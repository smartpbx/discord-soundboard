// Server-side helpers for managing Chatterbox TTS reference clips.
// Downloads from YouTube via yt-dlp, trims/normalizes via ffmpeg, then pushes
// the final WAV to the TTS server's PUT /voices/chatterbox/{id} endpoint.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const STAGING_DIR = path.join(__dirname, '..', 'data', 'tts-staging');
const SOURCE_CACHE_TTL_MS = 30 * 60 * 1000;   // 30 min cached YouTube source
const PREVIEW_TTL_MS = 60 * 60 * 1000;         // 1 hour preview retention
// Raised from 60 → 300 to accommodate longer source windows that get
// filtered down (isolate vocals + diarize dominant speaker). A 4-minute
// podcast slice may end up as ~1 min of usable target audio after both
// passes run.
const MAX_CLIP_DURATION_SEC = 300;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const YT_DLP = process.env.YT_DLP_BIN || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

const VOICE_ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const YT_HOST_RE = /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)$/i;

function ensureStaging() {
    if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });
}

function sweep() {
    ensureStaging();
    const now = Date.now();
    for (const name of fs.readdirSync(STAGING_DIR)) {
        const full = path.join(STAGING_DIR, name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const ttl = name.startsWith('source-') ? SOURCE_CACHE_TTL_MS : PREVIEW_TTL_MS;
        if (now - st.mtimeMs > ttl) {
            try { fs.unlinkSync(full); } catch {}
        }
    }
}

function validateYouTubeUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!YT_HOST_RE.test(u.hostname)) return null;
    return u.toString();
}

function normalizeVoiceId(raw) {
    if (typeof raw !== 'string') return null;
    let s = raw.trim().toLowerCase();
    if (s.startsWith('cb_')) s = s.slice(3);
    return VOICE_ID_RE.test(s) ? s : null;
}

function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
        let stdout = '', stderr = '';
        p.stdout.on('data', (d) => { stdout += d.toString(); });
        p.stderr.on('data', (d) => { stderr += d.toString(); });
        const timer = opts.timeoutMs ? setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, opts.timeoutMs) : null;
        p.on('close', (code) => {
            if (timer) clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        p.on('error', (err) => {
            if (timer) clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: String(err) });
        });
    });
}

async function fetchYouTubeSource(url) {
    sweep();
    const validUrl = validateYouTubeUrl(url);
    if (!validUrl) throw Object.assign(new Error('Invalid YouTube URL'), { status: 400 });

    const hash = crypto.createHash('sha1').update(validUrl).digest('hex').slice(0, 16);
    const sourcePath = path.join(STAGING_DIR, `source-${hash}.wav`);

    if (fs.existsSync(sourcePath)) {
        // Refresh mtime so the sweep doesn't drop a recently-touched cache hit.
        try { fs.utimesSync(sourcePath, new Date(), new Date()); } catch {}
        return { sourcePath, cached: true };
    }

    const tmpOut = path.join(STAGING_DIR, `source-${hash}.dl.%(ext)s`);
    const r = await run(YT_DLP, [
        '-f', 'bestaudio',
        '-x', '--audio-format', 'wav',
        '--audio-quality', '0',
        '--no-playlist',
        '--no-warnings',
        '--quiet',
        '-o', tmpOut,
        validUrl,
    ], { timeoutMs: 180000 });
    if (r.code !== 0) {
        const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-5).join('\n');
        throw Object.assign(new Error('yt-dlp failed: ' + (msg || 'unknown error')), { status: 502 });
    }
    const dlPath = path.join(STAGING_DIR, `source-${hash}.dl.wav`);
    if (!fs.existsSync(dlPath)) {
        throw Object.assign(new Error('yt-dlp did not produce a WAV output'), { status: 502 });
    }
    fs.renameSync(dlPath, sourcePath);
    return { sourcePath, cached: false };
}

async function probeDuration(filePath) {
    const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath], { timeoutMs: 15000 });
    const n = parseFloat((r.stdout || '').trim());
    return Number.isFinite(n) ? n : 0;
}

async function extractClip(sourcePath, startSec, endSec) {
    sweep();
    const start = Number(startSec);
    const end = Number(endSec);
    if (!Number.isFinite(start) || start < 0) throw Object.assign(new Error('Invalid start'), { status: 400 });
    if (!Number.isFinite(end) || end <= start) throw Object.assign(new Error('end must be greater than start'), { status: 400 });
    if (end - start > MAX_CLIP_DURATION_SEC) throw Object.assign(new Error(`Clip duration exceeds ${MAX_CLIP_DURATION_SEC}s`), { status: 400 });

    const token = crypto.randomBytes(12).toString('hex');
    const previewPath = path.join(STAGING_DIR, `preview-${token}.wav`);

    const args = [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-ss', String(start), '-to', String(end),
        '-i', sourcePath,
        '-af', 'loudnorm=I=-23:LRA=7:TP=-2,aresample=24000',
        '-ac', '1', '-ar', '24000',
        '-c:a', 'pcm_s16le',
        previewPath,
    ];
    const r = await run(FFMPEG, args, { timeoutMs: 60000 });
    if (r.code !== 0 || !fs.existsSync(previewPath)) {
        const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n');
        throw Object.assign(new Error('ffmpeg failed: ' + (msg || 'unknown error')), { status: 502 });
    }
    const duration = await probeDuration(previewPath);
    return { token, previewPath, duration };
}

function getPreviewPath(token) {
    if (!/^[a-f0-9]{24}$/.test(String(token || ''))) return null;
    const p = path.join(STAGING_DIR, `preview-${token}.wav`);
    return fs.existsSync(p) ? p : null;
}

function deletePreview(token) {
    const p = getPreviewPath(token);
    if (p) { try { fs.unlinkSync(p); } catch {} }
}

async function commitToTtsServer({ ttsApiUrl, adminToken, voiceId, name, group, gender, skipRvc, defaultExaggeration, source, previewPath }) {
    if (!ttsApiUrl) throw Object.assign(new Error('TTS_API_URL not configured'), { status: 503 });
    if (!adminToken) throw Object.assign(new Error('TTS_ADMIN_TOKEN not configured'), { status: 503 });

    const audio = fs.readFileSync(previewPath);
    const meta = {
        name: String(name || voiceId.replace(/_/g, ' ')).trim().slice(0, 80) || voiceId,
        gender: ['male', 'female'].includes(gender) ? gender : 'unknown',
        group: String(group || 'Celebrity').trim().slice(0, 40) || 'Celebrity',
        skip_rvc: !!skipRvc,
    };
    if (Number.isFinite(defaultExaggeration) && defaultExaggeration >= 0.25 && defaultExaggeration <= 2.0) {
        meta.default_exaggeration = Math.round(defaultExaggeration * 100) / 100;
    }
    if (source && (source.kind === 'youtube' || source.kind === 'upload')) {
        meta.source_kind = source.kind;
        if (source.kind === 'youtube' && typeof source.url === 'string') meta.source_url = source.url.slice(0, 500);
        if (source.kind === 'upload' && typeof source.filename === 'string') meta.source_filename = source.filename.slice(0, 200);
        if (Number.isFinite(source.start) && source.start >= 0) meta.source_start = Number(source.start);
        if (Number.isFinite(source.end) && source.end >= 0) meta.source_end = Number(source.end);
    }
    const form = new FormData();
    form.append('reference', new Blob([audio], { type: 'audio/wav' }), 'reference.wav');
    form.append('metadata', JSON.stringify(meta));

    const url = ttsApiUrl.replace(/\/+$/, '') + '/voices/chatterbox/' + encodeURIComponent(voiceId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let res;
    try {
        res = await fetch(url, {
            method: 'PUT',
            body: form,
            headers: { 'X-Admin-Token': adminToken },
            signal: controller.signal,
        });
    } catch (e) {
        clearTimeout(timer);
        throw Object.assign(new Error('TTS server unreachable: ' + e.message), { status: 502 });
    }
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) {
        let detail = text;
        try { detail = JSON.parse(text).detail || text; } catch {}
        throw Object.assign(new Error('TTS server rejected upload: ' + detail), { status: res.status });
    }
    try { return JSON.parse(text); } catch { return { id: 'cb_' + voiceId }; }
}

async function deleteFromTtsServer({ ttsApiUrl, adminToken, voiceId }) {
    if (!ttsApiUrl) throw Object.assign(new Error('TTS_API_URL not configured'), { status: 503 });
    if (!adminToken) throw Object.assign(new Error('TTS_ADMIN_TOKEN not configured'), { status: 503 });
    const url = ttsApiUrl.replace(/\/+$/, '') + '/voices/chatterbox/' + encodeURIComponent(voiceId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
        res = await fetch(url, { method: 'DELETE', headers: { 'X-Admin-Token': adminToken }, signal: controller.signal });
    } catch (e) {
        clearTimeout(timer);
        throw Object.assign(new Error('TTS server unreachable: ' + e.message), { status: 502 });
    }
    clearTimeout(timer);
    if (!res.ok) {
        const text = await res.text();
        let detail = text;
        try { detail = JSON.parse(text).detail || text; } catch {}
        throw Object.assign(new Error('TTS server rejected delete: ' + detail), { status: res.status });
    }
    return true;
}

module.exports = {
    STAGING_DIR,
    MAX_UPLOAD_BYTES,
    MAX_CLIP_DURATION_SEC,
    ensureStaging,
    sweep,
    validateYouTubeUrl,
    normalizeVoiceId,
    fetchYouTubeSource,
    extractClip,
    probeDuration,
    getPreviewPath,
    deletePreview,
    commitToTtsServer,
    deleteFromTtsServer,
};
