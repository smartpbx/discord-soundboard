// Disk-backed LRU cache for TTS synth output.
//
// Every /synthesize call is deterministic in its output for a given payload
// (same text + voice + knobs → same WAV, give or take Chatterbox's own
// stochasticity — see note below). Caching that output skips a multi-second
// GPU hit on every repeat phrase and every conversation-mode line that
// didn't change between Speak presses.
//
// Cache key: sha256 of the canonicalized synth payload. Volume is applied
// POST-synth, so it's not part of the key — changing volume reuses the
// cached WAV. Humanize runs BEFORE synth, so the humanized text is what
// gets hashed; the cache key already reflects the humanization.
//
// Stochasticity caveat: Chatterbox's sampler adds randomness per call, so
// strictly two "identical" synths aren't identical. We intentionally trade
// that variance for the speed win — users who want a different take hit
// the new 🔀 3-takes picker, which bypasses the cache.
//
// Eviction: size-capped LRU. We bump the file's mtime on read (treating
// mtime as "last used") and delete oldest-first when the total cache size
// exceeds the cap. Default 500 MB, override via TTS_CACHE_MAX_MB.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'tts-cache');
const DEFAULT_MAX_MB = 500;

function _maxBytes() {
    const mb = parseInt(process.env.TTS_CACHE_MAX_MB || '', 10);
    const n = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB;
    return n * 1024 * 1024;
}

function _enabled() {
    const v = (process.env.TTS_CACHE_ENABLED || '').toLowerCase();
    if (v === '0' || v === 'false' || v === 'no') return false;
    return true;
}

function _ensureDir() {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
}

// Canonicalize then hash the payload so key order doesn't matter. Segments
// (array of {text, emotion, ...}) are already stringified consistently by
// JSON.stringify when we include it; we stringify with sorted keys for
// extra safety against future payload reshapes.
function _sortedStringify(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(_sortedStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + _sortedStringify(obj[k])).join(',') + '}';
}

function keyFor(payload) {
    const canon = _sortedStringify(payload);
    return crypto.createHash('sha256').update(canon).digest('hex');
}

function _pathFor(key) {
    return path.join(CACHE_DIR, key + '.wav');
}

// Read a cached WAV. Returns null on miss or any I/O error. Bumps the
// file's atime/mtime on hit so the LRU eviction sees it as recently-used.
function get(key) {
    if (!_enabled()) return null;
    const p = _pathFor(key);
    try {
        const buf = fs.readFileSync(p);
        try { fs.utimesSync(p, new Date(), new Date()); } catch {}
        return buf;
    } catch {
        return null;
    }
}

// Write a WAV into the cache. Best-effort — errors are swallowed; a failed
// write just means the next read will miss. Triggers an eviction pass when
// we might be over the size cap.
function put(key, buffer) {
    if (!_enabled()) return;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return;
    _ensureDir();
    const p = _pathFor(key);
    const tmp = p + '.tmp-' + process.pid;
    try {
        fs.writeFileSync(tmp, buffer);
        fs.renameSync(tmp, p);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        return;
    }
    // Don't evict on every write — rate-limit to once per ~30s via a timer
    // guard. Keeps the synth path cheap when a burst of short clips lands.
    _maybeEvict();
}

let _lastEvict = 0;
function _maybeEvict() {
    const now = Date.now();
    if (now - _lastEvict < 30_000) return;
    _lastEvict = now;
    try { evict(); } catch {}
}

// Hard eviction pass — sums up cache size and deletes oldest files until
// we're under the cap. Called by the post-write timer and safe to invoke
// from elsewhere (eg. an ops /admin/cache/flush endpoint, if we add one).
function evict() {
    if (!_enabled()) return { removed: 0, totalBytes: 0 };
    let entries;
    try {
        entries = fs.readdirSync(CACHE_DIR)
            .filter(f => f.endsWith('.wav'))
            .map(f => {
                const full = path.join(CACHE_DIR, f);
                try {
                    const st = fs.statSync(full);
                    return { full, size: st.size, mtime: st.mtimeMs };
                } catch { return null; }
            })
            .filter(Boolean);
    } catch { return { removed: 0, totalBytes: 0 }; }

    const cap = _maxBytes();
    let total = entries.reduce((a, e) => a + e.size, 0);
    if (total <= cap) return { removed: 0, totalBytes: total };

    // Oldest first.
    entries.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    for (const e of entries) {
        if (total <= cap) break;
        try { fs.unlinkSync(e.full); total -= e.size; removed++; } catch {}
    }
    return { removed, totalBytes: total };
}

function stats() {
    try {
        _ensureDir();
        const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.wav'));
        let bytes = 0;
        for (const f of files) {
            try { bytes += fs.statSync(path.join(CACHE_DIR, f)).size; } catch {}
        }
        return { files: files.length, bytes, capBytes: _maxBytes(), enabled: _enabled() };
    } catch {
        return { files: 0, bytes: 0, capBytes: _maxBytes(), enabled: _enabled() };
    }
}

module.exports = { keyFor, get, put, evict, stats };
