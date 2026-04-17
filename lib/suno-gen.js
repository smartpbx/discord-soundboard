// Suno song generation via sunoapi.org (reverse-engineered wrapper).
//
// Auth: single Bearer token in SUNO_API_KEY env. The wrapper runs its own
// pool of Suno accounts and bills us per credit (separate from our personal
// suno.com subscription). The API notably bypasses web-side lyric filters.
//
// Endpoints used:
//   GET  /api/v1/generate/credit                 → remaining credit balance
//   POST /api/v1/generate                        → enqueue a generation
//   GET  /api/v1/generate/record-info?taskId=... → poll status + pull final URLs
//
// Generated MP3 + cover art are downloaded into data/suno-staging/<taskId>/ so
// the soundboard can stream them privately (no hot-linking from Suno's CDN
// that might expire or reveal auth).

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const STAGING_DIR = path.join(__dirname, '..', 'data', 'suno-staging');
const STAGING_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — generous so preview can sit overnight
const API_BASE = 'https://api.sunoapi.org/api/v1';

function apiKey() {
    return (process.env.SUNO_API_KEY || '').trim();
}

function ensureStaging() {
    if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });
}

function sweep() {
    ensureStaging();
    const now = Date.now();
    for (const entry of fs.readdirSync(STAGING_DIR)) {
        const full = path.join(STAGING_DIR, entry);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (now - st.mtimeMs > STAGING_TTL_MS) {
            try { fs.rmSync(full, { recursive: true, force: true }); } catch {}
        }
    }
}

async function apiCall(method, p, body, { timeout = 30000 } = {}) {
    const key = apiKey();
    if (!key) throw Object.assign(new Error('SUNO_API_KEY not configured'), { status: 503 });
    const headers = { Authorization: `Bearer ${key}` };
    if (body) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
        res = await fetch(`${API_BASE}${p}`, {
            method, headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
    } catch (e) {
        clearTimeout(timer);
        throw Object.assign(new Error('Suno API unreachable: ' + e.message), { status: 502 });
    }
    clearTimeout(timer);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw Object.assign(new Error('Non-JSON response from Suno: ' + text.slice(0, 200)), { status: 502 }); }
    if (!res.ok || (data.code != null && data.code !== 200)) {
        const msg = data.msg || data.message || data.error || `HTTP ${res.status}`;
        throw Object.assign(new Error('Suno API: ' + msg), { status: res.status || 502, detail: data });
    }
    return data.data;
}

async function getCredits() {
    const data = await apiCall('GET', '/generate/credit');
    return typeof data === 'number' ? data : (data && data.credits) || 0;
}

// Kick off a generation. Returns the taskId to poll against.
//   customMode=true uses explicit lyrics + style + title (fully specified).
//   customMode=false takes a plain description and Suno writes everything.
async function generateSong({ title, lyrics, style, model, instrumental = false, customMode = true, callBackUrl }) {
    const body = {
        customMode: !!customMode,
        instrumental: !!instrumental,
        model: model || 'V5_5',
    };
    if (customMode) {
        if (!style || typeof style !== 'string' || !style.trim()) {
            throw Object.assign(new Error('style required in custom mode'), { status: 400 });
        }
        body.style = style.trim().slice(0, 1000);
        if (title) body.title = String(title).trim().slice(0, 100);
        // In custom mode, `prompt` carries the lyrics for vocal tracks. For
        // instrumental tracks Suno ignores prompt — pass an empty string.
        body.prompt = instrumental ? '' : String(lyrics || '').trim();
    } else {
        // Non-custom: prompt is a free-text description of the whole song.
        body.prompt = String(style || lyrics || '').trim().slice(0, 400);
    }
    if (callBackUrl) body.callBackUrl = callBackUrl;
    const data = await apiCall('POST', '/generate', body, { timeout: 60000 });
    const taskId = data && (data.taskId || data.task_id);
    if (!taskId) throw new Error('No taskId in Suno response: ' + JSON.stringify(data).slice(0, 200));
    return taskId;
}

async function getSongStatus(taskId) {
    return apiCall('GET', `/generate/record-info?taskId=${encodeURIComponent(taskId)}`);
}

// Normalise the many shapes sunoapi.org responses can take into a single
// `tracks: [{id, title, tags, duration, lyrics, audio_url, image_url, video_url}]` list.
function extractTracks(statusPayload) {
    if (!statusPayload || typeof statusPayload !== 'object') return [];
    const candidates = [
        statusPayload.response && statusPayload.response.data,
        statusPayload.response && statusPayload.response.sunoData,
        statusPayload.sunoData,
        statusPayload.data,
        statusPayload.response,
    ];
    for (const c of candidates) {
        if (Array.isArray(c)) return c.map(normaliseTrack);
    }
    return [];
}

function normaliseTrack(t) {
    return {
        id: t.id || t.audio_id || t.clip_id || null,
        title: t.title || null,
        tags: t.tags || t.style || null,
        duration: t.duration || t.durationSec || null,
        lyrics: t.lyrics || t.prompt || null,
        audio_url: t.audio_url || t.audioUrl || t.streamAudioUrl || t.stream_audio_url || null,
        image_url: t.image_url || t.imageUrl || t.coverUrl || null,
        video_url: t.video_url || t.videoUrl || null,
    };
}

async function downloadFile(url, destPath, { timeout = 120000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        await pipeline(res.body, fs.createWriteStream(destPath));
    } finally {
        clearTimeout(timer);
    }
}

async function ingestCompletedTask(taskId, statusPayload) {
    ensureStaging();
    const dir = path.join(STAGING_DIR, taskId);
    fs.mkdirSync(dir, { recursive: true });
    const tracks = extractTracks(statusPayload);
    const ingested = [];
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const slot = { slot: i, ...t };
        if (t.audio_url) {
            const audioPath = path.join(dir, `slot${i}_audio.mp3`);
            if (!fs.existsSync(audioPath)) {
                try {
                    await downloadFile(t.audio_url, audioPath);
                    slot.audio_bytes = fs.statSync(audioPath).size;
                } catch (e) {
                    slot.audio_error = e.message;
                }
            } else {
                slot.audio_bytes = fs.statSync(audioPath).size;
            }
        }
        if (t.image_url) {
            const coverPath = path.join(dir, `slot${i}_cover.jpg`);
            if (!fs.existsSync(coverPath)) {
                try { await downloadFile(t.image_url, coverPath); } catch {}
            }
        }
        ingested.push(slot);
    }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        taskId, ingested_at: Date.now(), tracks: ingested, status: statusPayload && statusPayload.status,
    }, null, 2));
    return ingested;
}

function getStagingDir(taskId) {
    const dir = path.join(STAGING_DIR, taskId);
    return fs.existsSync(dir) ? dir : null;
}

function getStagingMeta(taskId) {
    const dir = getStagingDir(taskId);
    if (!dir) return null;
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;
    try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }
}

function getSlotAudioPath(taskId, slot) {
    const dir = getStagingDir(taskId);
    if (!dir) return null;
    const p = path.join(dir, `slot${slot}_audio.mp3`);
    return fs.existsSync(p) ? p : null;
}

function getSlotCoverPath(taskId, slot) {
    const dir = getStagingDir(taskId);
    if (!dir) return null;
    const p = path.join(dir, `slot${slot}_cover.jpg`);
    return fs.existsSync(p) ? p : null;
}

function deleteStaging(taskId) {
    const dir = getStagingDir(taskId);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
    STAGING_DIR,
    ensureStaging,
    sweep,
    getCredits,
    generateSong,
    getSongStatus,
    extractTracks,
    ingestCompletedTask,
    getStagingDir,
    getStagingMeta,
    getSlotAudioPath,
    getSlotCoverPath,
    deleteStaging,
};
