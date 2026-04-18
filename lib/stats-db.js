const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'stats.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sound_filename TEXT NOT NULL,
        display_name TEXT,
        user_id TEXT,
        user_role TEXT NOT NULL,
        guest_ip TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        planned_duration_ms INTEGER,
        actual_duration_ms INTEGER,
        stopped_early INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_plays_started_at ON plays(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plays_filename ON plays(sound_filename);
    CREATE INDEX IF NOT EXISTS idx_plays_user ON plays(user_id);

    CREATE TABLE IF NOT EXISTS admin_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        details TEXT,
        at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_actions_at ON admin_actions(at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_actions_actor ON admin_actions(actor);

    CREATE TABLE IF NOT EXISTS tts_recents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        text TEXT NOT NULL,
        voice_id TEXT NOT NULL,
        voice_label TEXT,
        display_name TEXT,
        wav_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tts_recents_owner_created ON tts_recents(owner, created_at DESC);
`);

const stmtInsertPlay = db.prepare(`
    INSERT INTO plays (sound_filename, display_name, user_id, user_role, guest_ip, started_at, planned_duration_ms)
    VALUES (@sound_filename, @display_name, @user_id, @user_role, @guest_ip, @started_at, @planned_duration_ms)
`);

const stmtFinalizePlay = db.prepare(`
    UPDATE plays
    SET ended_at = @ended_at,
        actual_duration_ms = @actual_duration_ms,
        stopped_early = @stopped_early
    WHERE id = @id AND ended_at IS NULL
`);

const stmtPlayCounts = db.prepare(`
    SELECT sound_filename, COUNT(*) AS count
    FROM plays
    GROUP BY sound_filename
`);

const stmtListPlays = db.prepare(`
    SELECT id, sound_filename, display_name, user_id, user_role, guest_ip,
           started_at, ended_at, planned_duration_ms, actual_duration_ms, stopped_early
    FROM plays
    WHERE (@from IS NULL OR started_at >= @from)
      AND (@to IS NULL OR started_at <= @to)
      AND (@user IS NULL OR user_id = @user)
      AND (@sound IS NULL OR sound_filename = @sound)
    ORDER BY started_at DESC
    LIMIT @limit OFFSET @offset
`);

const stmtCountPlays = db.prepare(`
    SELECT COUNT(*) AS count
    FROM plays
    WHERE (@from IS NULL OR started_at >= @from)
      AND (@to IS NULL OR started_at <= @to)
      AND (@user IS NULL OR user_id = @user)
      AND (@sound IS NULL OR sound_filename = @sound)
`);

const stmtInsertAdminAction = db.prepare(`
    INSERT INTO admin_actions (actor, actor_role, action, target, details, at)
    VALUES (@actor, @actor_role, @action, @target, @details, @at)
`);

const stmtListAdminActions = db.prepare(`
    SELECT id, actor, actor_role, action, target, details, at
    FROM admin_actions
    WHERE (@from IS NULL OR at >= @from)
      AND (@to IS NULL OR at <= @to)
      AND (@actor IS NULL OR actor = @actor)
      AND (@action IS NULL OR action = @action)
    ORDER BY at DESC
    LIMIT @limit OFFSET @offset
`);

const stmtCountAdminActions = db.prepare(`
    SELECT COUNT(*) AS count
    FROM admin_actions
    WHERE (@from IS NULL OR at >= @from)
      AND (@to IS NULL OR at <= @to)
      AND (@actor IS NULL OR actor = @actor)
      AND (@action IS NULL OR action = @action)
`);

const stmtPlaysPerDay = db.prepare(`
    SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
           COUNT(*) AS count
    FROM plays
    WHERE started_at >= @from
    GROUP BY day
    ORDER BY day ASC
`);

function recordPlayStart({ filename, displayName, userId, userRole, guestIp, plannedDurationMs }) {
    try {
        const info = stmtInsertPlay.run({
            sound_filename: filename,
            display_name: displayName ?? null,
            user_id: userId ?? null,
            user_role: userRole,
            guest_ip: guestIp ?? null,
            started_at: Date.now(),
            planned_duration_ms: plannedDurationMs ?? null,
        });
        return Number(info.lastInsertRowid);
    } catch (err) {
        console.error('[stats-db] recordPlayStart failed:', err.message);
        return null;
    }
}

function recordPlayEnd(playId, { stoppedEarly } = {}) {
    if (!playId) return;
    try {
        const row = db.prepare('SELECT started_at, planned_duration_ms, ended_at FROM plays WHERE id = ?').get(playId);
        if (!row || row.ended_at != null) return;
        const endedAt = Date.now();
        const actualMs = endedAt - row.started_at;
        let resolvedStoppedEarly;
        if (typeof stoppedEarly === 'boolean') {
            resolvedStoppedEarly = stoppedEarly;
        } else {
            resolvedStoppedEarly = row.planned_duration_ms != null && actualMs < row.planned_duration_ms - 250;
        }
        stmtFinalizePlay.run({
            id: playId,
            ended_at: endedAt,
            actual_duration_ms: actualMs,
            stopped_early: resolvedStoppedEarly ? 1 : 0,
        });
    } catch (err) {
        console.error('[stats-db] recordPlayEnd failed:', err.message);
    }
}

function getPlayCounts() {
    try {
        const rows = stmtPlayCounts.all();
        const map = {};
        for (const r of rows) map[r.sound_filename] = r.count;
        return map;
    } catch (err) {
        console.error('[stats-db] getPlayCounts failed:', err.message);
        return {};
    }
}

function listPlays({ from = null, to = null, user = null, sound = null, limit = 100, offset = 0 } = {}) {
    try {
        const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
        const safeOffset = Math.max(0, Number(offset) || 0);
        const params = { from, to, user, sound, limit: safeLimit, offset: safeOffset };
        const rows = stmtListPlays.all(params);
        const { count } = stmtCountPlays.get({ from, to, user, sound });
        return { rows, total: count, limit: safeLimit, offset: safeOffset };
    } catch (err) {
        console.error('[stats-db] listPlays failed:', err.message);
        return { rows: [], total: 0, limit, offset };
    }
}

function recordAdminAction({ actor, actorRole, action, target = null, details = null }) {
    try {
        stmtInsertAdminAction.run({
            actor,
            actor_role: actorRole,
            action,
            target,
            details: details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)),
            at: Date.now(),
        });
    } catch (err) {
        console.error('[stats-db] recordAdminAction failed:', err.message);
    }
}

function listAdminActions({ from = null, to = null, actor = null, action = null, limit = 100, offset = 0 } = {}) {
    try {
        const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
        const safeOffset = Math.max(0, Number(offset) || 0);
        const params = { from, to, actor, action, limit: safeLimit, offset: safeOffset };
        const rows = stmtListAdminActions.all(params);
        const { count } = stmtCountAdminActions.get({ from, to, actor, action });
        return { rows, total: count, limit: safeLimit, offset: safeOffset };
    } catch (err) {
        console.error('[stats-db] listAdminActions failed:', err.message);
        return { rows: [], total: 0, limit, offset };
    }
}

function getPlaysPerDay(fromMs) {
    try {
        return stmtPlaysPerDay.all({ from: fromMs });
    } catch (err) {
        console.error('[stats-db] getPlaysPerDay failed:', err.message);
        return [];
    }
}

const stmtInsertTtsRecent = db.prepare(`
    INSERT INTO tts_recents (owner, text, voice_id, voice_label, display_name, wav_path, created_at)
    VALUES (@owner, @text, @voice_id, @voice_label, @display_name, @wav_path, @created_at)
`);
const stmtListTtsRecents = db.prepare(`
    SELECT id, owner, text, voice_id, voice_label, display_name, wav_path, created_at
    FROM tts_recents
    WHERE owner = @owner
    ORDER BY created_at DESC
    LIMIT @limit
`);
const stmtListTtsRecentsGlobal = db.prepare(`
    SELECT id, owner, text, voice_id, voice_label, display_name, wav_path, created_at
    FROM tts_recents
    ORDER BY created_at DESC
    LIMIT @limit
`);
const stmtGetTtsRecent = db.prepare(`
    SELECT id, owner, text, voice_id, voice_label, display_name, wav_path, created_at
    FROM tts_recents WHERE id = @id
`);
const stmtDeleteTtsRecent = db.prepare(`DELETE FROM tts_recents WHERE id = @id`);
const stmtOldTtsRecents = db.prepare(`
    SELECT id, wav_path FROM tts_recents
    WHERE owner = @owner
    ORDER BY created_at DESC
    LIMIT -1 OFFSET @keep
`);

function insertTtsRecent({ owner, text, voiceId, voiceLabel = null, displayName = null, wavPath }) {
    try {
        const info = stmtInsertTtsRecent.run({
            owner,
            text,
            voice_id: voiceId,
            voice_label: voiceLabel,
            display_name: displayName,
            wav_path: wavPath,
            created_at: Date.now(),
        });
        return Number(info.lastInsertRowid);
    } catch (err) {
        console.error('[stats-db] insertTtsRecent failed:', err.message);
        return null;
    }
}

function listTtsRecents(owner, limit = 5) {
    try {
        return stmtListTtsRecents.all({ owner, limit: Math.max(1, Math.min(50, Number(limit) || 5)) });
    } catch (err) {
        console.error('[stats-db] listTtsRecents failed:', err.message);
        return [];
    }
}

function listTtsRecentsGlobal(limit = 20) {
    try {
        return stmtListTtsRecentsGlobal.all({ limit: Math.max(1, Math.min(100, Number(limit) || 20)) });
    } catch (err) {
        console.error('[stats-db] listTtsRecentsGlobal failed:', err.message);
        return [];
    }
}

function getTtsRecent(id) {
    try { return stmtGetTtsRecent.get({ id: Number(id) }) || null; }
    catch (err) { console.error('[stats-db] getTtsRecent failed:', err.message); return null; }
}

function deleteTtsRecent(id) {
    try { stmtDeleteTtsRecent.run({ id: Number(id) }); return true; }
    catch (err) { console.error('[stats-db] deleteTtsRecent failed:', err.message); return false; }
}

function listTtsRecentsBeyond(owner, keep) {
    try { return stmtOldTtsRecents.all({ owner, keep: Math.max(0, Number(keep) || 5) }); }
    catch (err) { console.error('[stats-db] listTtsRecentsBeyond failed:', err.message); return []; }
}

function close() {
    try { db.close(); } catch {}
}

module.exports = {
    recordPlayStart,
    recordPlayEnd,
    getPlayCounts,
    listPlays,
    recordAdminAction,
    listAdminActions,
    getPlaysPerDay,
    insertTtsRecent,
    listTtsRecents,
    listTtsRecentsGlobal,
    getTtsRecent,
    deleteTtsRecent,
    listTtsRecentsBeyond,
    close,
    _dbPath: DB_PATH,
};
