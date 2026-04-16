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

function close() {
    try { db.close(); } catch {}
}

module.exports = {
    recordPlayStart,
    recordPlayEnd,
    getPlayCounts,
    listPlays,
    recordAdminAction,
    close,
    _dbPath: DB_PATH,
};
