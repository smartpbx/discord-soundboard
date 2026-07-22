require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');

// Continuous event-loop lag histogram — surfaces sync FS hits, big
// JSON.parses, and synchronous FFI on the audio path as drift in the p99.
// Exposed via /api/diag/perf for the superadmin diagnostics panel and
// alerting from outside.
const _elDelay = monitorEventLoopDelay({ resolution: 20 });
_elDelay.enable();
function getEventLoopLag() {
    return {
        mean_ms: _elDelay.mean / 1e6,
        p50_ms: _elDelay.percentile(50) / 1e6,
        p95_ms: _elDelay.percentile(95) / 1e6,
        p99_ms: _elDelay.percentile(99) / 1e6,
        max_ms: _elDelay.max / 1e6,
        samples: _elDelay.exceeds,
    };
}

// Errors we never want to crash on. EPIPE/ECONNRESET/ECONNABORTED come from
// client-initiated aborts (closing the tab mid-download, hitting Stop on a
// long TTS synth). ENOBUFS is transient kernel UDP-buffer pressure from
// voice connection churn — recoverable, not worth a restart. Anything else
// here is a real bug and we re-throw so systemd restarts us.
const BENIGN_ERROR_CODES = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ENOBUFS']);
// Recoverable error messages we should never crash on. Opus stream corruption
// is one bad packet — prism emits it as a TypeError (no `code`) and we drop
// the stream's audio for the rest of the turn; the next speaking turn starts
// a fresh decoder. Re-throwing this previously created a death spiral via
// the unhandledRejection -> setImmediate(throw) symmetry I added earlier.
const BENIGN_ERROR_MESSAGE_FRAGMENTS = [
    'The compressed data passed is corrupted',
];
function isBenignError(err) {
    if (!err) return false;
    if (err.code && BENIGN_ERROR_CODES.has(err.code)) return true;
    const msg = err.message || (typeof err === 'string' ? err : '');
    if (msg && BENIGN_ERROR_MESSAGE_FRAGMENTS.some(f => msg.includes(f))) return true;
    return false;
}
process.on('uncaughtException', (err) => {
    if (isBenignError(err)) {
        console.warn('[net]', err.code, 'transient — ignored:', (err.syscall || '') + ' ' + (err.message || ''));
        return;
    }
    console.error('[fatal] uncaughtException:', err && err.stack || err);
    // Crash for real so systemd (Restart=on-failure) restarts us. The handlers
    // MUST be removed first — otherwise the re-thrown error re-enters this same
    // handler and loops forever, and the process never actually exits.
    process.exitCode = 1;
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    setImmediate(() => { throw err; });
});
process.on('unhandledRejection', (reason) => {
    if (isBenignError(reason)) {
        console.warn('[net]', reason.code, 'transient rejection — ignored:', (reason.syscall || '') + ' ' + (reason.message || ''));
        return;
    }
    console.error('[fatal] unhandledRejection:', reason && reason.stack || reason);
    // Re-throw asynchronously to be symmetric with uncaughtException. Remove the
    // listeners first so the throw actually crashes the process instead of
    // re-entering these handlers in an infinite loop.
    process.exitCode = 1;
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    setImmediate(() => { throw reason; });
});

// Discord voice requires an encryption lib to be ready *before* the first connection.
// Load it first so @discordjs/voice can use it.
const sodium = require('libsodium-wrappers');

function startApp() {
const { Readable } = require('stream');
const express = require('express');
const multer = require('multer');
const { execSync, spawn } = require('child_process');
const { Client, GatewayIntentBits, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder } = require('discord.js');
let _wheelCanvas = null;
try { _wheelCanvas = require('@napi-rs/canvas'); } catch (e) { console.warn('[wheel] @napi-rs/canvas not available — /wheel will be disabled:', e.message); }
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, getVoiceConnection, StreamType, AudioPlayerStatus, VoiceConnectionStatus, entersState, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const { Transform } = require('stream');
const statsDb = require('./lib/stats-db');
const ttsVoiceAdmin = require('./lib/tts-voice-admin');
const voiceTrainer = require('./lib/voice-trainer');
const sunoGen = require('./lib/suno-gen');

const SOUNDS_DIR = path.join(__dirname, 'sounds');
const PENDING_DIR = path.join(SOUNDS_DIR, 'pending');
const SOUNDS_META_PATH = path.join(SOUNDS_DIR, 'sounds.json');
const DATA_DIR = path.join(__dirname, 'data');
const GUEST_DATA_PATH = path.join(DATA_DIR, 'guest.json');
const PENDING_META_PATH = path.join(DATA_DIR, 'pending.json');
const SERVER_STATE_PATH = path.join(DATA_DIR, 'state.json');
const USERS_JSON_PATH = path.join(DATA_DIR, 'users.json');
const PENDING_USERS_PATH = path.join(DATA_DIR, 'pending-users.json');
const DISCORD_LINKS_PATH = path.join(DATA_DIR, 'discord-links.json');
const TTS_RECENTS_DIR = path.join(DATA_DIR, 'tts-recents');
if (!fs.existsSync(TTS_RECENTS_DIR)) fs.mkdirSync(TTS_RECENTS_DIR, { recursive: true });
const TTS_RECENTS_PER_USER = 5;
const TTS_RECENTS_GLOBAL_LIMIT = 30;

const DEFAULT_GUEST_COOLDOWN_SEC = 10;
const DEFAULT_GUEST_MAX_DURATION = 7;
const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2MB

// ---------------------------------------------------------------------------
// Per-user permission overrides
//
// Every role-level limit (TTS cap, playback cooldown, Suno quota, upload
// size, sound delete permission, etc.) can be overridden per username. Storage lives inside
// guest.json under `userOverrides: { <lowercased username>: { field: value,
// ... } }`. Each getter below consults the override map first and falls
// back to the existing role default when no override exists, so passing
// `username` to a getter is purely additive — callers that don't pass one
// keep getting role-level behavior as before.
// ---------------------------------------------------------------------------
const USER_OVERRIDE_FIELDS = [
    // Numbers (≥0). Use "" / null / undefined in setUserOverrides to clear.
    'ttsMaxTextLength', 'ttsCooldownSec',
    'sunoDailyLimit',
    'urlStreamMaxDurationSec',
    'userMaxDuration', 'userCooldownSec',
    'userMaxUploadDuration', 'userMaxUploadBytes',
    // Booleans
    'ttsEnabled',
    'urlStreamEnabled',
    'userUploadEnabled',
    'soundDeleteEnabled',
    'absurdCaptchaEnabled',
];
const USER_OVERRIDE_BOOLEAN_FIELDS = new Set(['ttsEnabled', 'urlStreamEnabled', 'userUploadEnabled', 'soundDeleteEnabled', 'absurdCaptchaEnabled']);

function _normalizeUsername(u) {
    return String(u || '').trim().toLowerCase();
}
function getUserOverride(username, field) {
    const un = _normalizeUsername(username);
    if (!un) return undefined;
    const d = loadGuestData();
    const all = d.userOverrides && typeof d.userOverrides === 'object' ? d.userOverrides : {};
    const rec = all[un];
    if (!rec || typeof rec !== 'object') return undefined;
    return rec[field];
}
function getAllUserOverrides() {
    const d = loadGuestData();
    const all = d.userOverrides && typeof d.userOverrides === 'object' ? d.userOverrides : {};
    const clean = {};
    for (const [un, rec] of Object.entries(all)) {
        if (!rec || typeof rec !== 'object') continue;
        const filtered = {};
        for (const f of USER_OVERRIDE_FIELDS) if (f in rec) filtered[f] = rec[f];
        if (Object.keys(filtered).length) clean[un] = filtered;
    }
    return clean;
}
function setUserOverrides(username, overrides) {
    const un = _normalizeUsername(username);
    if (!un) return false;
    if (!overrides || typeof overrides !== 'object') return false;
    const d = loadGuestData();
    d.userOverrides = d.userOverrides && typeof d.userOverrides === 'object' ? d.userOverrides : {};
    const next = { ...(d.userOverrides[un] || {}) };
    for (const f of USER_OVERRIDE_FIELDS) {
        if (!(f in overrides)) continue;
        const v = overrides[f];
        if (v === null || v === undefined || v === '') {
            delete next[f];
        } else if (USER_OVERRIDE_BOOLEAN_FIELDS.has(f)) {
            next[f] = !!v;
        } else {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) continue;
            next[f] = n;
        }
    }
    if (Object.keys(next).length === 0) delete d.userOverrides[un];
    else d.userOverrides[un] = next;
    saveGuestData(d);
    return true;
}
function clearAllUserOverrides(username) {
    const un = _normalizeUsername(username);
    if (!un) return false;
    const d = loadGuestData();
    if (!d.userOverrides || !d.userOverrides[un]) return false;
    delete d.userOverrides[un];
    saveGuestData(d);
    return true;
}

function getAbsurdCaptchaEnabled(username) {
    return getUserOverride(username, 'absurdCaptchaEnabled') === true;
}

function getGuestCooldownSec(ip) {
    const d = loadGuestData();
    if (ip) {
        const overrides = d.cooldownOverrides && typeof d.cooldownOverrides === 'object' ? d.cooldownOverrides : {};
        const v = Number(overrides[String(ip).trim()]);
        if (Number.isFinite(v) && v >= 0) return v;
    }
    const n = Number(d.guestCooldownSec);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GUEST_COOLDOWN_SEC;
}

function setGuestCooldownSec(sec) {
    const d = loadGuestData();
    d.guestCooldownSec = Number(sec) >= 0 ? Number(sec) : DEFAULT_GUEST_COOLDOWN_SEC;
    saveGuestData(d);
}

function getCooldownOverrides() {
    const d = loadGuestData();
    return d.cooldownOverrides && typeof d.cooldownOverrides === 'object' ? { ...d.cooldownOverrides } : {};
}

function setCooldownOverride(ip, sec) {
    const d = loadGuestData();
    const key = String(ip || '').trim();
    if (!key) return false;
    const overrides = d.cooldownOverrides && typeof d.cooldownOverrides === 'object' ? d.cooldownOverrides : {};
    const n = Number(sec);
    if (!Number.isFinite(n) || n < 0) return false;
    overrides[key] = n;
    d.cooldownOverrides = overrides;
    saveGuestData(d);
    return true;
}

function deleteCooldownOverride(ip) {
    const d = loadGuestData();
    const key = String(ip || '').trim();
    if (!key) return false;
    const overrides = d.cooldownOverrides && typeof d.cooldownOverrides === 'object' ? d.cooldownOverrides : {};
    if (!(key in overrides)) return false;
    delete overrides[key];
    d.cooldownOverrides = overrides;
    saveGuestData(d);
    return true;
}

function getGuestMaxDuration() {
    const d = loadGuestData();
    const n = Number(d.guestMaxDuration);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_GUEST_MAX_DURATION;
}

function setGuestMaxDuration(sec) {
    const d = loadGuestData();
    d.guestMaxDuration = Number(sec) > 0 ? Number(sec) : DEFAULT_GUEST_MAX_DURATION;
    saveGuestData(d);
}

// With `trust proxy` set, Express resolves req.ip from the leftmost
// X-Forwarded-For but only when the immediate hop matches a trusted proxy.
// Direct hits to the bot (bypassing Caddy) can't spoof the header anymore.
function getClientIP(req) {
    return req.ip || req.connection?.remoteAddress || 'unknown';
}

// Atomic write helper. Writes to <path>.tmp then renames; rename is atomic on
// POSIX so a crash mid-write can't blank the destination file. Used for every
// JSON state file (guest.json, state.json, users.json, sounds.json, etc).
function writeJsonAtomic(filePath, obj) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
}

// In-memory cache of guest.json. Hot read path: vosk emits a partial result
// every ~50-100 ms per active speaker, and each call into the voice-trigger
// handler ends up calling loadGuestData() at least twice (trigger list +
// global cooldown). Without this cache that's a 16 KB readFileSync +
// JSON.parse hundreds of times per second blocking the event loop.
let guestDataCache = null;
function loadGuestData() {
    if (guestDataCache) return structuredClone(guestDataCache);
    try {
        const raw = fs.readFileSync(GUEST_DATA_PATH, 'utf8');
        const data = JSON.parse(raw);
        guestDataCache = typeof data === 'object' && data !== null ? data : { enabled: false, blockedIPs: [], history: [] };
    } catch {
        guestDataCache = { enabled: false, blockedIPs: [], history: [] };
    }
    return structuredClone(guestDataCache);
}

function saveGuestData(data) {
    writeJsonAtomic(GUEST_DATA_PATH, data);
    guestDataCache = structuredClone(data);
}

function getGuestEnabled() {
    const d = loadGuestData();
    return d.enabled === true;
}

function setGuestEnabled(enabled) {
    const d = loadGuestData();
    d.enabled = enabled === true;
    saveGuestData(d);
}

function isIPBlocked(ip) {
    const d = loadGuestData();
    const list = Array.isArray(d.blockedIPs) ? d.blockedIPs : [];
    return list.includes(String(ip).trim());
}

function blockIP(ip) {
    const d = loadGuestData();
    d.blockedIPs = Array.isArray(d.blockedIPs) ? d.blockedIPs : [];
    const s = String(ip).trim();
    if (s && !d.blockedIPs.includes(s)) d.blockedIPs.push(s);
    saveGuestData(d);
}

function unblockIP(ip) {
    const d = loadGuestData();
    d.blockedIPs = (Array.isArray(d.blockedIPs) ? d.blockedIPs : []).filter(x => String(x).trim() !== String(ip).trim());
    saveGuestData(d);
}

function appendGuestHistory(ip, filename, displayName) {
    const d = loadGuestData();
    d.history = Array.isArray(d.history) ? d.history : [];
    d.history.push({ ip, timestamp: Date.now(), filename, displayName });
    const max = 500;
    if (d.history.length > max) d.history = d.history.slice(-max);
    saveGuestData(d);
}

function getUserUploadEnabled(username) {
    const ov = getUserOverride(username, 'userUploadEnabled');
    if (typeof ov === 'boolean') return ov;
    const d = loadGuestData();
    return d.userUploadEnabled === true;
}

function setUserUploadEnabled(enabled) {
    const d = loadGuestData();
    d.userUploadEnabled = enabled === true;
    saveGuestData(d);
}

function getGuestUploadEnabled() {
    const d = loadGuestData();
    return d.guestUploadEnabled === true;
}

function setGuestUploadEnabled(enabled) {
    const d = loadGuestData();
    d.guestUploadEnabled = enabled === true;
    saveGuestData(d);
}

function getUserMaxUploadDuration(username) {
    const ov = Number(getUserOverride(username, 'userMaxUploadDuration'));
    if (Number.isFinite(ov) && ov > 0) return ov;
    const d = loadGuestData();
    const n = Number(d.userMaxUploadDuration);
    return Number.isFinite(n) && n > 0 ? n : (Number(d.maxUploadDuration) || 7);
}

function setUserMaxUploadDuration(sec) {
    const d = loadGuestData();
    d.userMaxUploadDuration = Number(sec) > 0 ? Number(sec) : 7;
    saveGuestData(d);
}

function getUserMaxUploadBytes(username) {
    const ov = Number(getUserOverride(username, 'userMaxUploadBytes'));
    if (Number.isFinite(ov) && ov > 0) return ov;
    const d = loadGuestData();
    const n = Number(d.userMaxUploadBytes);
    return Number.isFinite(n) && n > 0 ? n : (Number(d.maxUploadBytes) || DEFAULT_MAX_UPLOAD_BYTES);
}

function setUserMaxUploadBytes(bytes) {
    const d = loadGuestData();
    d.userMaxUploadBytes = Number(bytes) > 0 ? Number(bytes) : DEFAULT_MAX_UPLOAD_BYTES;
    saveGuestData(d);
}

function getGuestMaxUploadDuration() {
    const d = loadGuestData();
    const n = Number(d.guestMaxUploadDuration);
    return Number.isFinite(n) && n > 0 ? n : 7;
}

function setGuestMaxUploadDuration(sec) {
    const d = loadGuestData();
    d.guestMaxUploadDuration = Number(sec) > 0 ? Number(sec) : 7;
    saveGuestData(d);
}

function getGuestMaxUploadBytes() {
    const d = loadGuestData();
    const n = Number(d.guestMaxUploadBytes);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UPLOAD_BYTES;
}

function setGuestMaxUploadBytes(bytes) {
    const d = loadGuestData();
    d.guestMaxUploadBytes = Number(bytes) > 0 ? Number(bytes) : DEFAULT_MAX_UPLOAD_BYTES;
    saveGuestData(d);
}

function getUserMaxDuration(username) {
    const ov = Number(getUserOverride(username, 'userMaxDuration'));
    if (Number.isFinite(ov) && ov > 0) return ov;
    const d = loadGuestData();
    const n = Number(d.userMaxDuration);
    return Number.isFinite(n) && n > 0 ? n : 7;
}

function setUserMaxDuration(sec) {
    const d = loadGuestData();
    d.userMaxDuration = Number(sec) > 0 ? Number(sec) : 7;
    saveGuestData(d);
}

function getUserCooldownSec(username) {
    const ov = Number(getUserOverride(username, 'userCooldownSec'));
    if (Number.isFinite(ov) && ov >= 0) return ov;
    const d = loadGuestData();
    const n = Number(d.userCooldownSec);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function setUserCooldownSec(sec) {
    const d = loadGuestData();
    d.userCooldownSec = Number(sec) >= 0 ? Number(sec) : 0;
    saveGuestData(d);
}

function getSoundDeleteRoleDefault(role) {
    if (role === 'superadmin') return true;
    if (role !== 'admin' && role !== 'user') return false;
    const d = loadGuestData();
    const key = role === 'admin' ? 'soundDeleteEnabled_admin' : 'soundDeleteEnabled_user';
    return d[key] === true;
}
function setSoundDeleteRoleDefault(role, enabled) {
    if (role !== 'admin' && role !== 'user') return;
    const d = loadGuestData();
    const key = role === 'admin' ? 'soundDeleteEnabled_admin' : 'soundDeleteEnabled_user';
    d[key] = enabled === true;
    saveGuestData(d);
}
function getSoundDeleteEnabled(role, username) {
    if (role === 'superadmin') return true;
    if (role !== 'admin' && role !== 'user') return false;
    const ov = getUserOverride(username, 'soundDeleteEnabled');
    if (typeof ov === 'boolean') return ov;
    return getSoundDeleteRoleDefault(role);
}

function getAutoNormalizeUploads() {
    const d = loadGuestData();
    // Default ON if unset.
    return d.autoNormalizeUploads !== false;
}

function setAutoNormalizeUploads(enabled) {
    const d = loadGuestData();
    d.autoNormalizeUploads = enabled === true;
    saveGuestData(d);
}

// --- TTS settings (stored in guest.json alongside other settings) ---
function getTtsEnabled(username) {
    // Per-user kill switch: if the override is explicitly false, TTS is off
    // for that user regardless of the global setting. An explicit `true`
    // override does NOT override a global OFF — the global toggle is still
    // the higher authority.
    const ov = getUserOverride(username, 'ttsEnabled');
    if (ov === false) return false;
    const d = loadGuestData();
    return d.ttsEnabled === true;
}
function setTtsEnabled(v) {
    const d = loadGuestData();
    d.ttsEnabled = !!v;
    saveGuestData(d);
}
function getTtsMaxTextLength(role, username) {
    const ov = Number(getUserOverride(username, 'ttsMaxTextLength'));
    if (Number.isFinite(ov) && ov >= 0) return ov;
    const d = loadGuestData();
    const defaults = { guest: 0, user: 200, admin: 500, superadmin: 2000 };
    const key = 'ttsMaxTextLength_' + role;
    const n = Number(d[key]);
    return Number.isFinite(n) && n >= 0 ? n : (defaults[role] ?? 500);
}
function setTtsMaxTextLength(role, len) {
    const d = loadGuestData();
    d['ttsMaxTextLength_' + role] = Number(len) >= 0 ? Number(len) : 0;
    saveGuestData(d);
}
function getTtsCooldownSec(role, username) {
    const ov = Number(getUserOverride(username, 'ttsCooldownSec'));
    if (Number.isFinite(ov) && ov >= 0) return ov;
    const d = loadGuestData();
    const defaults = { guest: 30, user: 15, admin: 5, superadmin: 0 };
    const key = 'ttsCooldownSec_' + role;
    const n = Number(d[key]);
    return Number.isFinite(n) && n >= 0 ? n : (defaults[role] ?? 5);
}
function setTtsCooldownSec(role, sec) {
    const d = loadGuestData();
    d['ttsCooldownSec_' + role] = Number(sec) >= 0 ? Number(sec) : 0;
    saveGuestData(d);
}

// --- Suno song-generation settings (stored in guest.json) ---
function getSunoEnabled() {
    const d = loadGuestData();
    return d.sunoEnabled === true;
}
function setSunoEnabled(v) {
    const d = loadGuestData();
    d.sunoEnabled = !!v;
    saveGuestData(d);
}
function getSunoDailyLimit(role, username) {
    const ov = Number(getUserOverride(username, 'sunoDailyLimit'));
    if (Number.isFinite(ov) && ov >= 0) return ov;
    const d = loadGuestData();
    const defaults = { guest: 0, user: 0, admin: 5, superadmin: 50 };
    const key = 'sunoDailyLimit_' + role;
    const n = Number(d[key]);
    return Number.isFinite(n) && n >= 0 ? n : (defaults[role] ?? 0);
}
function setSunoDailyLimit(role, n) {
    const d = loadGuestData();
    d['sunoDailyLimit_' + role] = Number(n) >= 0 ? Number(n) : 0;
    saveGuestData(d);
}
// Usage counter shape in guest.json: { sunoUsage: { "YYYY-MM-DD": { "<username>": N, ... } } }
function sunoTodayKey() { return new Date().toISOString().slice(0, 10); }
function getSunoUsageToday(username) {
    const d = loadGuestData();
    const u = d.sunoUsage && d.sunoUsage[sunoTodayKey()];
    return (u && u[username]) || 0;
}
function incrementSunoUsage(username) {
    const d = loadGuestData();
    d.sunoUsage = d.sunoUsage && typeof d.sunoUsage === 'object' ? d.sunoUsage : {};
    const today = sunoTodayKey();
    // Prune yesterday+ older entries so the object doesn't grow unbounded.
    for (const k of Object.keys(d.sunoUsage)) if (k < today) delete d.sunoUsage[k];
    d.sunoUsage[today] = d.sunoUsage[today] || {};
    d.sunoUsage[today][username] = (d.sunoUsage[today][username] || 0) + 1;
    saveGuestData(d);
    return d.sunoUsage[today][username];
}
function decrementSunoUsage(username) {
    const d = loadGuestData();
    const today = sunoTodayKey();
    if (d.sunoUsage && d.sunoUsage[today] && d.sunoUsage[today][username] > 0) {
        d.sunoUsage[today][username] -= 1;
        saveGuestData(d);
    }
}

// --- URL streaming settings (per-role enable + max duration) ---
function getUrlStreamEnabled(role, username) {
    const ov = getUserOverride(username, 'urlStreamEnabled');
    if (typeof ov === 'boolean') return ov;
    const d = loadGuestData();
    // Default: admin + superadmin on, user/guest off
    const defaults = { guest: false, user: false, admin: true, superadmin: true };
    const key = 'urlStreamEnabled_' + role;
    return typeof d[key] === 'boolean' ? d[key] : !!defaults[role];
}
function setUrlStreamEnabled(role, v) {
    const d = loadGuestData();
    d['urlStreamEnabled_' + role] = v === true;
    saveGuestData(d);
}
// Voice-channel clipping: capture + save the last N seconds of audio.
// Defaults: admin + superadmin + user on (it's a fun feature), guests off
// because they aren't authenticated long-term.
function getClipEnabled(role, username) {
    const ov = getUserOverride(username, 'clipEnabled');
    if (typeof ov === 'boolean') return ov;
    const d = loadGuestData();
    const defaults = { guest: false, user: true, admin: true, superadmin: true };
    const key = 'clipEnabled_' + role;
    return typeof d[key] === 'boolean' ? d[key] : !!defaults[role];
}
function setClipEnabled(role, v) {
    const d = loadGuestData();
    d['clipEnabled_' + role] = v === true;
    saveGuestData(d);
}

// Play-all queue: spams the soundboard sequentially. Defaults: admin +
// superadmin on, user + guest off — letting plain users fire a 50-sound
// queue is a recipe for the bot getting kicked.
function getPlayQueueEnabled(role, username) {
    const ov = getUserOverride(username, 'playQueueEnabled');
    if (typeof ov === 'boolean') return ov;
    const d = loadGuestData();
    const defaults = { guest: false, user: false, admin: true, superadmin: true };
    const key = 'playQueueEnabled_' + role;
    return typeof d[key] === 'boolean' ? d[key] : !!defaults[role];
}
function setPlayQueueEnabled(role, v) {
    const d = loadGuestData();
    d['playQueueEnabled_' + role] = v === true;
    saveGuestData(d);
}
function getUrlStreamMaxDurationSec(role, username) {
    const ov = Number(getUserOverride(username, 'urlStreamMaxDurationSec'));
    if (Number.isFinite(ov) && ov >= 0) return ov;
    const d = loadGuestData();
    const defaults = { guest: 0, user: 60, admin: 300, superadmin: 1800 };
    const key = 'urlStreamMaxDurationSec_' + role;
    const n = Number(d[key]);
    return Number.isFinite(n) && n >= 0 ? n : (defaults[role] ?? 300);
}
function setUrlStreamMaxDurationSec(role, sec) {
    const d = loadGuestData();
    d['urlStreamMaxDurationSec_' + role] = Number(sec) >= 0 ? Number(sec) : 0;
    saveGuestData(d);
}

// --- TTS voice management (stored in guest.json) ---
function getTtsDisabledVoices() {
    const d = loadGuestData();
    return Array.isArray(d.ttsDisabledVoices) ? d.ttsDisabledVoices : [];
}
function setTtsDisabledVoices(ids) {
    const d = loadGuestData();
    d.ttsDisabledVoices = Array.isArray(ids) ? ids.filter(v => typeof v === 'string') : [];
    saveGuestData(d);
}
function getTtsVoiceRvcOverrides() {
    const d = loadGuestData();
    return typeof d.ttsVoiceRvcOverrides === 'object' && d.ttsVoiceRvcOverrides !== null ? d.ttsVoiceRvcOverrides : {};
}
function setTtsVoiceRvcOverrides(obj) {
    const d = loadGuestData();
    d.ttsVoiceRvcOverrides = typeof obj === 'object' && obj !== null ? obj : {};
    saveGuestData(d);
}
function getTtsMaxQueueSize() {
    const d = loadGuestData();
    const n = Number(d.ttsMaxQueueSize);
    return Number.isFinite(n) && n >= 1 ? n : 10;
}
function setTtsMaxQueueSize(n) {
    const d = loadGuestData();
    d.ttsMaxQueueSize = Math.max(1, Math.min(50, Number(n) || 10));
    saveGuestData(d);
}

// --- Voice triggers (listen to channel speech, fire sound on keyword match) ---
function getVoiceTriggersEnabled() {
    return loadGuestData().voiceTriggersEnabled === true;
}
function setVoiceTriggersEnabled(v) {
    const d = loadGuestData();
    d.voiceTriggersEnabled = v === true;
    saveGuestData(d);
}
function getVoiceTriggersGlobalCooldownSec() {
    const n = Number(loadGuestData().voiceTriggersGlobalCooldownSec);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}
function setVoiceTriggersGlobalCooldownSec(sec) {
    const d = loadGuestData();
    d.voiceTriggersGlobalCooldownSec = Math.max(0, Math.min(3600, Number(sec) || 0));
    saveGuestData(d);
}
// Auto-clip: when > 0, every voice-trigger fire also captures the last N
// seconds of channel audio as a clip, so the "what just got said" moment
// is preserved without anyone manually hitting /clip.
function getVoiceTriggersAutoClipSec() {
    const n = Number(loadGuestData().voiceTriggersAutoClipSec);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}
function setVoiceTriggersAutoClipSec(sec) {
    const d = loadGuestData();
    d.voiceTriggersAutoClipSec = Math.max(0, Math.min(CLIP_MAX_REQUEST_SEC, Number(sec) || 0));
    saveGuestData(d);
}

// Wake-word soundboard: when set to a non-empty phrase, the voice-trigger
// pipeline listens for "<wake> [play] <sound name>" patterns and plays the
// best-matching sound from the library. Reuses the existing per-speaker
// vosk subscription; matches sound display names + filenames (substring).
function getVoiceTriggersWakeWord() {
    const v = loadGuestData().voiceTriggersWakeWord;
    return typeof v === 'string' ? v.trim() : '';
}
function setVoiceTriggersWakeWord(v) {
    const d = loadGuestData();
    d.voiceTriggersWakeWord = String(v || '').trim().toLowerCase().slice(0, 50);
    saveGuestData(d);
}

// Pronunciation overrides — a phonetic map applied to TTS text *before* synth
// so proper nouns, inside-joke names, and tech jargon ("nginx" -> "engine-x",
// "Discord" -> "diss-cord") read correctly. Match is whole-word, case-
// insensitive. Stored under guest-data so it doesn't leak into source.
function getTtsPronunciationOverrides() {
    const d = loadGuestData();
    return d.ttsPronunciationOverrides && typeof d.ttsPronunciationOverrides === 'object' ? d.ttsPronunciationOverrides : {};
}
function setTtsPronunciationOverrides(obj) {
    const d = loadGuestData();
    const out = {};
    if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
            const from = String(k).trim();
            const to = String(v).trim();
            if (from && to && from.length <= 100 && to.length <= 200) out[from] = to;
        }
    }
    d.ttsPronunciationOverrides = out;
    saveGuestData(d);
    return out;
}
function applyTtsPronunciationOverrides(text) {
    if (!text) return text;
    const overrides = getTtsPronunciationOverrides();
    const keys = Object.keys(overrides);
    if (!keys.length) return text;
    let out = text;
    for (const from of keys) {
        let re;
        try {
            // NOTE: the char class must be [.*+?^${}()|[\]\\] — the previous
            // version closed the class early so keys were never escaped, and a
            // key like "c++" threw here and crash-looped the bot on every speak.
            re = new RegExp('\\b' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
        } catch (e) {
            console.warn('[tts] skipping bad pronunciation override key:', from, e.message);
            continue;
        }
        out = out.replace(re, overrides[from]);
    }
    return out;
}

// --- Voting (kick/timeout via slash commands) ---
const VOTE_DEFAULTS = {
    enabled: false,
    thresholdPct: 51,         // % of eligible voters needed (Yes / eligible)
    windowSec: 30,            // how long the vote stays open
    minVoters: 2,             // minimum eligible voters required for vote to count
    targetCooldownSec: 300,   // cooldown per target after a successful vote
    immuneRoleIds: [],        // role IDs the bot will refuse to vote on
    maxTimeoutMinutes: 60,    // cap on /votetimeout duration
};
function getVotingConfig() {
    const d = loadGuestData();
    const stored = (d.voting && typeof d.voting === 'object') ? d.voting : {};
    return {
        enabled: stored.enabled === true,
        thresholdPct: Math.max(1, Math.min(100, Number(stored.thresholdPct) || VOTE_DEFAULTS.thresholdPct)),
        windowSec: Math.max(5, Math.min(300, Number(stored.windowSec) || VOTE_DEFAULTS.windowSec)),
        minVoters: Math.max(1, Math.min(50, Number(stored.minVoters) || VOTE_DEFAULTS.minVoters)),
        targetCooldownSec: Math.max(0, Math.min(86400, Number(stored.targetCooldownSec) || VOTE_DEFAULTS.targetCooldownSec)),
        immuneRoleIds: Array.isArray(stored.immuneRoleIds) ? stored.immuneRoleIds.filter(s => typeof s === 'string' && /^\d{5,32}$/.test(s)) : [],
        maxTimeoutMinutes: Math.max(1, Math.min(40320, Number(stored.maxTimeoutMinutes) || VOTE_DEFAULTS.maxTimeoutMinutes)),
    };
}
function setVotingConfig(patch) {
    const d = loadGuestData();
    const current = getVotingConfig();
    const next = { ...current, ...patch };
    // Clamp again in case caller passed raw values
    next.thresholdPct = Math.max(1, Math.min(100, Number(next.thresholdPct) || VOTE_DEFAULTS.thresholdPct));
    next.windowSec = Math.max(5, Math.min(300, Number(next.windowSec) || VOTE_DEFAULTS.windowSec));
    next.minVoters = Math.max(1, Math.min(50, Number(next.minVoters) || VOTE_DEFAULTS.minVoters));
    next.targetCooldownSec = Math.max(0, Math.min(86400, Number(next.targetCooldownSec) || VOTE_DEFAULTS.targetCooldownSec));
    next.maxTimeoutMinutes = Math.max(1, Math.min(40320, Number(next.maxTimeoutMinutes) || VOTE_DEFAULTS.maxTimeoutMinutes));
    next.immuneRoleIds = Array.isArray(next.immuneRoleIds) ? next.immuneRoleIds.filter(s => typeof s === 'string' && /^\d{5,32}$/.test(s)) : [];
    next.enabled = next.enabled === true;
    d.voting = next;
    saveGuestData(d);
    return next;
}
function recordVoteEvent(entry) {
    const stored = { when: Date.now(), ...entry };
    try { statsDb.recordVoteEvent(stored); } catch (err) { console.warn('[voting] vote-log persist failed:', err.message); }
    return stored;
}
function loadVoiceTriggers() {
    const arr = loadGuestData().voiceTriggers;
    return Array.isArray(arr) ? arr : [];
}
function saveVoiceTriggers(list) {
    const d = loadGuestData();
    d.voiceTriggers = Array.isArray(list) ? list : [];
    saveGuestData(d);
}
function normalizeTriggerPhrase(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Word-boundary phrase match against an already-normalized transcript.
// Avoids "delegate" firing the "wife" trigger via .includes() substring.
function phraseMatchesTranscript(normalizedTranscript, phrase) {
    if (!phrase) return false;
    const re = new RegExp(`(?:^|\\W)${escapeRegExp(phrase)}(?:$|\\W)`);
    return re.test(normalizedTranscript);
}
function makeTriggerId() {
    return 'vt_' + crypto.randomBytes(6).toString('hex');
}

// Cached for the same reason as guestDataCache — /api/playback-state polls
// this at 1 Hz per connected client, which would otherwise be a disk read +
// JSON.parse per second per client.
let serverStateCache = null;
function loadServerState() {
    if (serverStateCache) return structuredClone(serverStateCache);
    try {
        const raw = fs.readFileSync(SERVER_STATE_PATH, 'utf8');
        const data = JSON.parse(raw);
        serverStateCache = typeof data === 'object' && data !== null ? data : {};
    } catch {
        serverStateCache = {};
    }
    return structuredClone(serverStateCache);
}

function saveServerState(updates) {
    try {
        const state = { ...loadServerState(), ...updates };
        writeJsonAtomic(SERVER_STATE_PATH, state);
        serverStateCache = structuredClone(state);
    } catch (err) {
        console.error('Failed to save server state:', err.message);
    }
}

const RECENTLY_PLAYED_MAX = 5;
// Filenames that aren't real sound files — each TTS/URL-stream/Suno play
// is a distinct event, so we must NOT dedupe on filename (which would
// collapse every TTS clip to a single entry). Dedupe on displayName
// for these synthetic entries so "same phrase twice" still collapses,
// but different phrases stay separate.
const SYNTHETIC_FILENAMES = new Set(['tts', 'url_stream', 'suno_preview']);
function getRecentlyPlayedFromState() {
    const state = loadServerState();
    const arr = Array.isArray(state.recentlyPlayed) ? state.recentlyPlayed : [];
    return arr.slice(0, RECENTLY_PLAYED_MAX);
}
function addToRecentlyPlayedServer(filename, displayName, playedBy, playedAt) {
    if (!filename) return;
    let list = getRecentlyPlayedFromState();
    if (SYNTHETIC_FILENAMES.has(filename)) {
        // Dedupe on displayName for synthetic sources, not filename.
        list = list.filter((x) => !(x.filename === filename && x.displayName === displayName));
    } else {
        list = list.filter((x) => x.filename !== filename);
    }
    list.unshift({ filename, displayName: displayName || filename, playedBy: playedBy || null, playedAt: playedAt || Date.now() });
    list = list.slice(0, RECENTLY_PLAYED_MAX);
    saveServerState({ recentlyPlayed: list });
}

function getMaxUploadDuration() {
    return getUserMaxUploadDuration();
}

function setMaxUploadDuration(sec) {
    setUserMaxUploadDuration(sec);
}

function getMaxUploadBytes() {
    return getUserMaxUploadBytes();
}

function setMaxUploadBytes(bytes) {
    setUserMaxUploadBytes(bytes);
}

function loadPendingMeta() {
    try {
        const raw = fs.readFileSync(PENDING_META_PATH, 'utf8');
        const data = JSON.parse(raw);
        return typeof data === 'object' && data !== null && Array.isArray(data.uploads) ? data : { uploads: [] };
    } catch {
        return { uploads: [] };
    }
}

function savePendingMeta(data) {
    writeJsonAtomic(PENDING_META_PATH, data);
}

function addPendingUpload(filename, meta) {
    const d = loadPendingMeta();
    d.uploads = d.uploads || [];
    d.uploads.push({ filename, ...meta });
    savePendingMeta(d);
}

function removePendingUpload(filename) {
    const d = loadPendingMeta();
    d.uploads = (d.uploads || []).filter(u => u.filename !== filename);
    savePendingMeta(d);
}

function loadSoundsMeta() {
    try {
        const raw = fs.readFileSync(SOUNDS_META_PATH, 'utf8');
        const data = JSON.parse(raw);
        const meta = typeof data === 'object' && data !== null ? data : {};
        if (migrateFoldersToTags(meta)) saveSoundsMeta(meta);
        return meta;
    } catch {
        return {};
    }
}

function saveSoundsMeta(data) {
    writeJsonAtomic(SOUNDS_META_PATH, data);
    // Any meta edit (rename, retag, volume, trim, etc.) needs the next
    // /api/sounds poll to see the change immediately.
    if (typeof invalidateSoundsCache === 'function') invalidateSoundsCache();
}

function getDisplayName(meta, filename) {
    const m = meta[filename];
    return (m && typeof m === 'object' ? m.displayName : m) || (typeof m === 'string' ? m : null) || filename;
}

function getDuration(meta, filename) {
    const m = meta[filename];
    if (m && typeof m === 'object' && typeof m.duration === 'number') return m.duration;
    return null;
}

function setSoundMeta(filename, updates) {
    const meta = loadSoundsMeta();
    const cur = meta[filename];
    const next = typeof cur === 'object' && cur !== null ? { ...cur } : (typeof cur === 'string' ? { displayName: cur } : {});
    if (updates.displayName !== undefined) next.displayName = updates.displayName;
    if (updates.duration !== undefined) next.duration = updates.duration;
    if (updates.tags !== undefined) {
        const arr = Array.isArray(updates.tags) ? updates.tags : (updates.tags ? [updates.tags] : []);
        next.tags = arr.filter(t => typeof t === 'string' && t.trim() !== '').map(t => t.trim());
    }
    if (updates.color !== undefined) {
        const c = updates.color === null || updates.color === '' ? null : String(updates.color).trim();
        next.color = (c && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : null;
    }
    if (updates.folder !== undefined) {
        const f = updates.folder === null || updates.folder === '' ? null : String(updates.folder);
        next.folder = f;
        next.tags = f ? [f] : [];
    }
    if (updates.volume !== undefined) {
        const v = typeof updates.volume === 'number' ? Math.max(0, Math.min(2, updates.volume)) : undefined;
        next.volume = v;
    }
    if (updates.startTime !== undefined) {
        if (updates.startTime === null) delete next.startTime;
        else if (typeof updates.startTime === 'number' && updates.startTime >= 0) next.startTime = updates.startTime;
    }
    if (updates.endTime !== undefined) {
        if (updates.endTime === null) delete next.endTime;
        else if (typeof updates.endTime === 'number' && updates.endTime >= 0) next.endTime = updates.endTime;
    }
    if (updates.stopOthers !== undefined) {
        next.stopOthers = !!updates.stopOthers;
    }
    if (updates.tts !== undefined) {
        if (updates.tts === null) { delete next.tts; }
        else if (typeof updates.tts === 'object' && typeof updates.tts.text === 'string' && typeof updates.tts.voiceId === 'string') {
            next.tts = {
                text: String(updates.tts.text),
                voiceId: String(updates.tts.voiceId),
                voiceLabel: updates.tts.voiceLabel != null ? String(updates.tts.voiceLabel) : null,
            };
        }
    }
    meta[filename] = next;
    saveSoundsMeta(meta);
}

function getSoundTts(meta, filename) {
    const m = meta[filename];
    if (m && typeof m === 'object' && m.tts && typeof m.tts === 'object' && typeof m.tts.text === 'string' && typeof m.tts.voiceId === 'string') {
        return { text: m.tts.text, voiceId: m.tts.voiceId, voiceLabel: m.tts.voiceLabel || null };
    }
    return null;
}

function getTags(meta, filename) {
    const m = meta[filename];
    if (m && typeof m === 'object' && Array.isArray(m.tags)) return m.tags.filter(t => typeof t === 'string' && t.trim() !== '');
    if (m && typeof m === 'object' && m.folder != null) return [String(m.folder)];
    return [];
}

function getColor(meta, filename) {
    const m = meta[filename];
    if (m && typeof m === 'object' && typeof m.color === 'string' && m.color.trim() !== '') return m.color.trim();
    return null;
}

function getSoundVolume(meta, filename) {
    const m = meta[filename];
    if (m && typeof m === 'object' && typeof m.volume === 'number') return Math.max(0, Math.min(2, m.volume));
    return null;
}

function getSoundStopOthers(meta, filename) {
    const m = meta[filename];
    return !!(m && typeof m === 'object' && m.stopOthers);
}

function getSoundStartTime(meta, filename) {
    const m = meta[filename];
    if (m && typeof m === 'object' && typeof m.startTime === 'number' && m.startTime >= 0) return m.startTime;
    return null;
}

function getSoundEndTime(meta, filename) {
    const m = meta[filename];
    if (m && typeof m === 'object' && typeof m.endTime === 'number' && m.endTime >= 0) return m.endTime;
    return null;
}

function getAllTagsFromSounds(meta) {
    const set = new Set();
    Object.keys(meta).forEach(key => {
        if (key.startsWith('_')) return;
        const tags = getTags(meta, key);
        tags.forEach(t => set.add(t));
    });
    return [...set];
}

function getTagOrder(meta) {
    const list = meta._tagOrder;
    if (Array.isArray(list)) return list.filter(f => typeof f === 'string' && f.trim() !== '');
    const legacy = meta._folders;
    return Array.isArray(legacy) ? legacy.filter(f => typeof f === 'string' && f.trim() !== '') : [];
}

function getHiddenTags(meta) {
    const list = meta._tagHidden;
    return Array.isArray(list) ? list.filter(f => typeof f === 'string' && f.trim() !== '') : [];
}

function setTagOrder(order) {
    const meta = loadSoundsMeta();
    meta._tagOrder = order.filter(f => typeof f === 'string' && f.trim() !== '');
    saveSoundsMeta(meta);
}

function setTagHidden(tag, hidden) {
    const meta = loadSoundsMeta();
    meta._tagHidden = meta._tagHidden || [];
    const set = new Set(meta._tagHidden);
    if (hidden) set.add(tag);
    else set.delete(tag);
    meta._tagHidden = [...set];
    saveSoundsMeta(meta);
}

function migrateFoldersToTags(meta) {
    let changed = false;
    Object.keys(meta).forEach(key => {
        if (key.startsWith('_')) return;
        const m = meta[key];
        if (m && typeof m === 'object' && m.folder != null && !Array.isArray(m.tags)) {
            m.tags = [String(m.folder)];
            delete m.folder;
            changed = true;
        }
    });
    if (meta._folders && !meta._tagOrder) {
        meta._tagOrder = meta._folders;
        changed = true;
    }
    return changed;
}

function getFolder(meta, filename) {
    const tags = getTags(meta, filename);
    return tags.length > 0 ? tags[0] : null;
}

function getFolders(meta) {
    const order = getTagOrder(meta);
    const fromSounds = getAllTagsFromSounds(meta);
    const combined = order.length ? [...order, ...fromSounds.filter(t => !order.includes(t))] : fromSounds;
    return [...new Set(combined)];
}

function getSoundOrder(meta) {
    const order = meta._order;
    return Array.isArray(order) ? order.filter(f => typeof f === 'string') : [];
}

function setSoundOrder(order) {
    const meta = loadSoundsMeta();
    meta._order = order;
    saveSoundsMeta(meta);
}

function getPlaybackLocked(meta) {
    return meta._playbackLocked === true;
}

function getPlaybackLockedBy(meta) {
    const by = meta._playbackLockedBy;
    return (by === 'superadmin' || by === 'admin') ? by : 'admin';
}

function setPlaybackLocked(locked, byRole) {
    const meta = loadSoundsMeta();
    meta._playbackLocked = locked === true;
    meta._playbackLockedBy = (byRole === 'superadmin' || byRole === 'admin') ? byRole : 'admin';
    saveSoundsMeta(meta);
}

function getPlaybackSuperadminOnly(meta) {
    return meta._playbackSuperadminOnly === true;
}

function setPlaybackSuperadminOnly(meta, value) {
    meta._playbackSuperadminOnly = value === true;
}

function probeDuration(filePath) {
    try {
        const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 5000 });
        const d = parseFloat(out.trim());
        return Number.isFinite(d) && d > 0 ? d : null;
    } catch {
        return null;
    }
}
function probeDurationAsync(filePath) {
    return new Promise((resolve) => {
        const ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        ff.stdout.on('data', chunk => { out += chunk.toString(); });
        ff.on('error', () => resolve(null));
        ff.on('close', () => { const d = parseFloat(out.trim()); resolve(Number.isFinite(d) && d > 0 ? d : null); });
    });
}
if (!fs.existsSync(SOUNDS_DIR)) {
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    console.log('📁 Created sounds directory');
}
if (!fs.existsSync(PENDING_DIR)) {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
}

// Find an unused filename across a set of directories. Starts with base+ext,
// then base_2.ext, base_3.ext, … Returns `${base}${suffix}${ext}`.
function findAvailableSoundName(baseName, ext, dirs) {
    const tryName = (name) => dirs.every(d => !fs.existsSync(path.join(d, name)));
    let candidate = baseName + ext;
    if (tryName(candidate)) return candidate;
    for (let i = 2; i < 1000; i++) {
        candidate = `${baseName}_${i}${ext}`;
        if (tryName(candidate)) return candidate;
    }
    // Ultimate fallback — timestamp (extremely unlikely to collide).
    return `${baseName}_${Date.now()}${ext}`;
}
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
// Migrate from legacy paths (guest.json, pending.json in project root)
const LEGACY_GUEST = path.join(__dirname, 'guest.json');
const LEGACY_PENDING = path.join(__dirname, 'pending.json');
if (fs.existsSync(LEGACY_GUEST) && !fs.existsSync(GUEST_DATA_PATH)) {
    fs.copyFileSync(LEGACY_GUEST, GUEST_DATA_PATH);
    console.log('Migrated guest.json to data/');
}
if (fs.existsSync(LEGACY_PENDING) && !fs.existsSync(PENDING_META_PATH)) {
    fs.copyFileSync(LEGACY_PENDING, PENDING_META_PATH);
    console.log('Migrated pending.json to data/');
}

const app = express();
const upload = multer({ dest: 'sounds/', limits: { fileSize: 10 * 1024 * 1024 } });

// Running-build identity for the web UI's version stamp + What's New.
// Read at startup; the process restarts on every `scripts/update.sh`, so a
// polled SHA mismatch tells the client it's stale and should hard-refresh.
const VERSION_INFO = (function() {
    let sha = '';
    try {
        const r = require('child_process').spawnSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, timeout: 2000 });
        if (r.status === 0) sha = r.stdout.toString().trim();
    } catch {}
    // Fallback: read .git/HEAD directly (handles detached HEAD + missing git
    // binary). Only used when `git rev-parse` isn't available.
    if (!sha) {
        try {
            const head = fs.readFileSync(path.join(__dirname, '.git', 'HEAD'), 'utf8').trim();
            if (head.startsWith('ref: ')) {
                const refPath = path.join(__dirname, '.git', head.slice(5).trim());
                sha = fs.readFileSync(refPath, 'utf8').trim();
            } else {
                sha = head;
            }
        } catch {}
    }
    let packageVersion = '0.0.0';
    try { packageVersion = require('./package.json').version || '0.0.0'; } catch {}
    return {
        sha,
        shortSha: sha.slice(0, 7),
        packageVersion,
        startedAt: Date.now(),
    };
})();
console.log('[VERSION] %s (%s) startedAt=%d', VERSION_INFO.packageVersion, VERSION_INFO.shortSha || 'unknown', VERSION_INFO.startedAt);

// Unauthenticated on purpose so the login screen can render a version
// badge + compare SHAs across tabs without a session. Response is tiny and
// contains no sensitive info.
app.get('/api/version', (req, res) => {
    res.json(VERSION_INFO);
});

// Performance diagnostics — event-loop lag histogram + process RSS / uptime.
// Gated behind requireSuperadmin since it's purely an operator/debug surface.
app.get('/api/diag/perf', (req, res, next) => {
    if (!req.session?.user || req.session.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
    const mem = process.memoryUsage();
    res.json({
        eventLoop: getEventLoopLag(),
        rss_mb: mem.rss / (1024 * 1024),
        heap_used_mb: mem.heapUsed / (1024 * 1024),
        heap_total_mb: mem.heapTotal / (1024 * 1024),
        uptime_sec: process.uptime(),
        pid: process.pid,
        startedAt: VERSION_INFO.startedAt,
        nodeVersion: process.version,
    });
});

// Raw CHANGELOG.md so the frontend can parse + render the "What's New"
// modal. Kept unauthenticated for the same reason as /api/version.
app.get('/api/changelog', (req, res) => {
    try {
        const p = path.join(__dirname, 'CHANGELOG.md');
        const txt = fs.readFileSync(p, 'utf8');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(txt);
    } catch (e) {
        res.status(404).type('text/plain').send('# Changelog\n\nNot available.\n');
    }
});

const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim();
if (!SESSION_SECRET || SESSION_SECRET === 'soundboard-secret-change-me') {
    console.error('[fatal] SESSION_SECRET env var is required (and must not be the placeholder). Generate one with: openssl rand -hex 32');
    process.exit(1);
}

// Cloudflare Tunnel terminates at a local cloudflared on this container, so the
// only trustworthy proxy hop is loopback. 'trust proxy: 1' would trust ANY
// immediate peer (LAN/ZeroTier/other CT), letting them spoof X-Forwarded-For to
// dodge IP cooldowns/blocks and the login limiter. 'loopback' ignores XFF from
// non-loopback peers so their req.ip is the real socket address.
app.set('trust proxy', 'loopback');

// Baseline security headers. A restrictive script-src CSP is deferred until the
// inline handlers/scripts move out of index.html; these directives are safe now
// and are the backstop for the XSS sinks fixed in this change. frame-ancestors
// 'self' + X-Frame-Options stop clickjacking; nosniff stops MIME confusion.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
        "object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
    next();
});

// gzip / brotli all eligible responses. /api/sounds (~130 KB JSON) and the
// single-file frontend (~660 KB) compress to roughly 1/5th, which is the
// biggest payload win available without restructuring assets.
app.use(require('compression')());

app.use(express.static('public', {
    // Strong cache + ETag for static assets. The /api/version SHA poll
    // already forces a hard reload when the build SHA changes, so the
    // 1-hour cap is just a backstop for non-deploy edits during dev.
    etag: true,
    maxAge: 3600 * 1000,
}));
// HLS output of the Watch Together screen-capture proxy. The directory is
// created on demand under DATA_DIR/captures/<captureId> when the 'capture'
// strategy resolves a room; cleanup is handled by stopCaptureProxy() when
// the watch room is closed or swept.
app.use('/captures', express.static(path.join(__dirname, 'data', 'captures'), {
    etag: false,
    maxAge: 0,
    setHeaders(res, filePath) {
        if (filePath.endsWith('.m3u8')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        } else if (filePath.endsWith('.ts')) {
            res.setHeader('Cache-Control', 'public, max-age=3600, immutable');
            res.setHeader('Content-Type', 'video/mp2t');
        }
    },
}));
app.use(express.json());
app.use(require('cookie-parser')());
// Held in a named ref so the WS upgrade handler (yt-session noVNC proxy) can
// authenticate WebSocket clients with the same session cookie.
const sessionMiddleware = require('express-session')({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        // 'auto' = secure when the connection is HTTPS (production behind
        // Caddy), insecure for local dev over plain HTTP.
        secure: 'auto',
        // SameSite=lax stops the basic CSRF case (external site POSTs to
        // /api/play, /api/superadmin/* etc.) while still allowing top-level
        // navigation back into the app.
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
    },
});
app.use(sessionMiddleware);


// Parse users from env + data/users.json (approved signups)
// Roles: superadmin, admin, user
function loadUsersFromEnv() {
    const users = new Map();
    const raw = (process.env.USERS || '').trim();
    if (raw) {
        for (const entry of raw.split(',')) {
            const parts = entry.trim().split(':');
            if (parts.length >= 3) {
                const username = parts[0].trim().toLowerCase();
                const password = parts[1];
                const role = parts.slice(2).join(':').trim().toLowerCase();
                if (username && password && ['superadmin', 'admin', 'user'].includes(role)) {
                    users.set(username, { username, password, role });
                }
            }
        }
    }
    const adminPw = (process.env.ADMIN_PASSWORD || '').trim();
    const userPw = (process.env.USER_PASSWORD || '').trim();
    const superPw = (process.env.SUPERADMIN_PASSWORD || '').trim();
    if (adminPw && !users.has('admin')) users.set('admin', { username: 'admin', password: adminPw, role: 'admin' });
    if (userPw && !users.has('user')) users.set('user', { username: 'user', password: userPw, role: 'user' });
    if (superPw && !users.has('superadmin')) users.set('superadmin', { username: 'superadmin', password: superPw, role: 'superadmin' });
    return users;
}
function loadApprovedSignups() {
    try {
        const raw = fs.readFileSync(USERS_JSON_PATH, 'utf8');
        const data = JSON.parse(raw);
        const list = Array.isArray(data.users) ? data.users : [];
        return list.filter(u => u && u.username && u.password).map(u => ({
            username: String(u.username).trim().toLowerCase(),
            password: u.password,
            role: (u.role === 'admin' ? 'admin' : 'user'),
            mustChangePassword: u.mustChangePassword === true,
            disabled: u.disabled === true
        }));
    } catch {
        return [];
    }
}
function saveApprovedSignups(arr) {
    writeJsonAtomic(USERS_JSON_PATH, { users: arr });
}
function loadUsers() {
    const env = loadUsersFromEnv();
    const signups = loadApprovedSignups();
    signups.forEach(u => {
        const un = u.username;
        if (un && !env.has(un)) env.set(un, { username: un, password: u.password, role: u.role, mustChangePassword: u.mustChangePassword, disabled: u.disabled });
    });
    return env;
}
const USERS = loadUsers();
let approvedSignups = loadApprovedSignups();
const envUsernames = new Set(loadUsersFromEnv().keys());

function loadPendingUsers() {
    try {
        const raw = fs.readFileSync(PENDING_USERS_PATH, 'utf8');
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}
function savePendingUsers(arr) {
    writeJsonAtomic(PENDING_USERS_PATH, arr);
}
function addApprovedUser(username, password, role) {
    const un = String(username).trim().toLowerCase();
    if (!un || !password) return false;
    const r = (role === 'admin' ? 'admin' : 'user');
    const stored = ensureHashedPassword(password);
    USERS.set(un, { username: un, password: stored, role: r, mustChangePassword: false, disabled: false });
    approvedSignups.push({ username: un, password: stored, role: r, mustChangePassword: false, disabled: false });
    saveApprovedSignups(approvedSignups);
    return true;
}

function setManagedUserDisabled(username, disabled) {
    const un = String(username).trim().toLowerCase();
    if (!un || envUsernames.has(un)) return false;
    const idx = approvedSignups.findIndex(u => u.username === un);
    if (idx < 0) return false;
    approvedSignups[idx].disabled = disabled === true;
    const entry = USERS.get(un);
    if (entry) entry.disabled = disabled === true;
    saveApprovedSignups(approvedSignups);
    return true;
}

function destroySessionsForUsername(sessionStore, username) {
    const un = String(username || '').trim().toLowerCase();
    if (!un || !sessionStore || typeof sessionStore.destroy !== 'function') return;
    if (sessionStore.sessions && typeof sessionStore.sessions === 'object') {
        for (const [sid, raw] of Object.entries(sessionStore.sessions)) {
            let sess = raw;
            if (typeof raw === 'string') {
                try { sess = JSON.parse(raw); } catch { sess = null; }
            }
            const su = sess && sess.user && String(sess.user.username || '').trim().toLowerCase();
            if (su === un) sessionStore.destroy(sid, () => {});
        }
        return;
    }
    if (typeof sessionStore.all !== 'function') return;
    sessionStore.all((err, sessions) => {
        if (err || !sessions) return;
        if (Array.isArray(sessions)) return;
        Object.entries(sessions).forEach(([sid, sess]) => {
            const su = sess && sess.user && String(sess.user.username || '').trim().toLowerCase();
            if (su === un) sessionStore.destroy(sid, () => {});
        });
    });
}

function updateManagedUserRole(username, role) {
    const un = String(username).trim().toLowerCase();
    if (!un || envUsernames.has(un)) return false;
    const r = (role === 'admin' ? 'admin' : 'user');
    const idx = approvedSignups.findIndex(u => u.username === un);
    if (idx < 0) return false;
    approvedSignups[idx].role = r;
    const entry = USERS.get(un);
    if (entry) entry.role = r;
    saveApprovedSignups(approvedSignups);
    return true;
}
function removeManagedUser(username) {
    const un = String(username).trim().toLowerCase();
    if (!un || envUsernames.has(un)) return false;
    const idx = approvedSignups.findIndex(u => u.username === un);
    if (idx < 0) return false;
    approvedSignups.splice(idx, 1);
    USERS.delete(un);
    saveApprovedSignups(approvedSignups);
    return true;
}
function updateManagedUserPassword(username, newPassword, forceChange) {
    const un = String(username).trim().toLowerCase();
    if (!un || envUsernames.has(un)) return false;
    const idx = approvedSignups.findIndex(u => u.username === un);
    if (idx < 0) return false;
    if (!newPassword || newPassword.length < 6) return false;
    const stored = hashPassword(newPassword);
    approvedSignups[idx].password = stored;
    approvedSignups[idx].mustChangePassword = forceChange === true;
    const entry = USERS.get(un);
    if (entry) {
        entry.password = stored;
        entry.mustChangePassword = forceChange === true;
    }
    saveApprovedSignups(approvedSignups);
    return true;
}
function updateOwnPassword(username, currentPassword, newPassword) {
    const un = String(username).trim().toLowerCase();
    const entry = USERS.get(un);
    if (!entry) return false;
    if (envUsernames.has(un)) return false;
    const { valid } = verifyPassword(currentPassword, entry.password);
    if (!valid) return false;
    const idx = approvedSignups.findIndex(u => u.username === un);
    if (idx < 0) return false;
    if (!newPassword || newPassword.length < 6) return false;
    const stored = hashPassword(newPassword);
    approvedSignups[idx].password = stored;
    approvedSignups[idx].mustChangePassword = false;
    entry.password = stored;
    entry.mustChangePassword = false;
    saveApprovedSignups(approvedSignups);
    return true;
}
// --- Discord user linking & entrance/exit sounds ---
// data/discord-links.json shape:
// { globalEnabled: bool, users: { [username]: { discordId, entranceSound, exitSound, disabled } } }
// Discord-linking config has two top-level toggles:
//   globalEnabled       — master switch for the whole linking subsystem.
//                         When off, /play ignores linked roles and entrance/
//                         exit sounds don't fire.
//   entranceExitEnabled — sub-toggle just for the entrance/exit playback
//                         behavior. Defaults to true when missing so older
//                         deploys keep their existing semantics.
function loadDiscordLinks() {
    try {
        const raw = fs.readFileSync(DISCORD_LINKS_PATH, 'utf8');
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') return { globalEnabled: false, entranceExitEnabled: true, users: {} };
        return {
            globalEnabled: data.globalEnabled === true,
            entranceExitEnabled: data.entranceExitEnabled !== false, // default true
            users: (data.users && typeof data.users === 'object') ? data.users : {},
        };
    } catch {
        return { globalEnabled: false, entranceExitEnabled: true, users: {} };
    }
}
function saveDiscordLinks(data) {
    writeJsonAtomic(DISCORD_LINKS_PATH, data);
}
function getDiscordLinkGlobalEnabled() {
    return loadDiscordLinks().globalEnabled === true;
}
function setDiscordLinkGlobalEnabled(enabled) {
    const d = loadDiscordLinks();
    d.globalEnabled = enabled === true;
    saveDiscordLinks(d);
}
function getDiscordLinkEntranceExitEnabled() {
    return loadDiscordLinks().entranceExitEnabled !== false;
}
function setDiscordLinkEntranceExitEnabled(enabled) {
    const d = loadDiscordLinks();
    d.entranceExitEnabled = enabled !== false;
    saveDiscordLinks(d);
}
function getDiscordLinkForUser(username) {
    const un = String(username || '').trim().toLowerCase();
    if (!un) return null;
    const d = loadDiscordLinks();
    return d.users[un] || null;
}
function setDiscordLinkForUser(username, patch) {
    const un = String(username || '').trim().toLowerCase();
    if (!un) return false;
    const d = loadDiscordLinks();
    const cur = d.users[un] || { discordId: null, entranceSound: null, exitSound: null, disabled: false };
    const next = { ...cur };
    if ('discordId' in patch) next.discordId = patch.discordId ? String(patch.discordId).trim() : null;
    if ('entranceSound' in patch) next.entranceSound = patch.entranceSound ? path.basename(String(patch.entranceSound)) : null;
    if ('exitSound' in patch) next.exitSound = patch.exitSound ? path.basename(String(patch.exitSound)) : null;
    if ('disabled' in patch) next.disabled = patch.disabled === true;
    d.users[un] = next;
    saveDiscordLinks(d);
    return true;
}
function findUsernameByDiscordId(discordId) {
    const id = String(discordId || '').trim();
    if (!id) return null;
    const d = loadDiscordLinks();
    for (const [un, entry] of Object.entries(d.users)) {
        if (entry && entry.discordId === id) return un;
    }
    return null;
}

const guestLastPlayByIP = new Map();
const userLastPlayByUsername = new Map();
const ttsLastPlayByIP = new Map();
const ttsLastPlayByUsername = new Map();
const TTS_API_URL = (process.env.TTS_API_URL || '').replace(/\/+$/, '');
// Cache last TTS WAV buffer per username so it can be saved as a sound
// { wavBuffer: Buffer, text: string, voiceId: string, timestamp: number }
const ttsLastBuffer = new Map();

// Short-lived cache of freshly-synthesized TTS WAVs keyed by a random token.
// Lets the speak-request's browser fetch the bytes and render a live waveform
// while the queue plays in Discord. TTL is short because the WAV is already
// persisted in tts_recents for non-guests; this is only needed for the
// post-synth flash visualization.
const ttsWavCache = new Map();
const TTS_WAV_CACHE_TTL_MS = 2 * 60 * 1000;
function ttsWavCacheStash(buffer, owner) {
    const id = require('crypto').randomBytes(16).toString('hex');
    // owner is the username that synthesised this WAV. The /api/tts/wav/:id
    // endpoint refuses to serve to anyone else so a leaked / guessed id
    // can't pull another user's freshly-synthesized clip.
    ttsWavCache.set(id, { buffer, owner: owner ? String(owner).toLowerCase() : null, expiresAt: Date.now() + TTS_WAV_CACHE_TTL_MS });
    return id;
}
setInterval(() => {
    const now = Date.now();
    for (const [id, e] of ttsWavCache) if (e.expiresAt < now) ttsWavCache.delete(id);
}, 60_000).unref?.();

// --- TTS Queue ---
const ttsQueue = [];
let ttsQueueIdCounter = 0;
let ttsIsPlaying = false;

// Serialize /synthesize requests to the TTS server: parallel generations
// on a shared GPU garble each other, so only one synth runs at a time.
let ttsSynthTail = Promise.resolve();
let ttsSynthPending = 0;
async function runTtsSynthSerially(fn) {
    const prev = ttsSynthTail;
    let release;
    ttsSynthTail = new Promise((r) => { release = r; });
    ttsSynthPending++;
    try {
        await prev.catch(() => {});
        return await fn();
    } finally {
        ttsSynthPending--;
        release();
    }
}

const COMPANION_TOKEN = (process.env.COMPANION_TOKEN || '').trim();
function injectCompanionAuth(req) {
    if (!COMPANION_TOKEN) return false;
    const auth = req.headers['authorization'] || '';
    if (auth === `Bearer ${COMPANION_TOKEN}`) {
        req.session = req.session || {};
        req.session.user = { username: 'companion', role: 'admin' };
        return true;
    }
    return false;
}
function requireAuth(req, res, next) {
    if (injectCompanionAuth(req)) return next();
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (req.session.user.role === 'guest') {
        if (!getGuestEnabled() || isIPBlocked(req.session.user.ip || getClientIP(req))) {
            req.session.destroy(() => {});
            return res.status(401).json({ error: 'Guest access disabled or IP blocked.' });
        }
    } else {
        const un = String(req.session.user.username || '').trim().toLowerCase();
        const entry = USERS.get(un);
        if (!entry || entry.disabled === true) {
            req.session.destroy(() => {});
            return res.status(401).json({ error: 'Account is disabled. Contact an admin.' });
        }
    }
    next();
}
function requireAdmin(req, res, next) {
    if (injectCompanionAuth(req)) return next();
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const un = String(req.session.user.username || '').trim().toLowerCase();
    const entry = USERS.get(un);
    if (!entry || entry.disabled === true) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'Account is disabled. Contact an admin.' });
    }
    // Authorize against the LIVE record, not the session snapshot, so a demoted
    // admin loses access immediately instead of keeping it until the 7-day
    // cookie expires.
    if (entry.role !== 'admin' && entry.role !== 'superadmin') return res.status(403).json({ error: 'Admin or superadmin only' });
    next();
}

function requireSuperadmin(req, res, next) {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const un = String(req.session.user.username || '').trim().toLowerCase();
    const entry = USERS.get(un);
    if (!entry || entry.disabled === true) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'Account is disabled. Contact an admin.' });
    }
    if (entry.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
    next();
}

// Passwords are stored as `scrypt:<saltHex>:<hashHex>`. Legacy plaintext
// rows (anything that doesn't start with `scrypt:`) are accepted on a one-
// time basis at next login and silently upgraded to a hash. Env-sourced
// passwords (.env USERS / *_PASSWORD) stay plaintext at rest — they're
// rewritten on every boot from the env file, so persistence is moot.
function hashPassword(plain) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(plain), salt, 64);
    return 'scrypt:' + salt.toString('hex') + ':' + hash.toString('hex');
}
function ensureHashedPassword(value) {
    if (typeof value === 'string' && value.startsWith('scrypt:')) return value;
    return hashPassword(value);
}
function verifyPassword(plain, stored) {
    if (!stored) return { valid: false, needsUpgrade: false };
    const s = String(stored);
    if (s.startsWith('scrypt:')) {
        const parts = s.split(':');
        if (parts.length !== 3) return { valid: false, needsUpgrade: false };
        let actual;
        try {
            const salt = Buffer.from(parts[1], 'hex');
            const expected = Buffer.from(parts[2], 'hex');
            actual = crypto.scryptSync(String(plain), salt, expected.length);
            const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
            return { valid, needsUpgrade: false };
        } catch {
            return { valid: false, needsUpgrade: false };
        }
    }
    // Legacy plaintext — constant-time compare to keep the path uniform.
    const plainBuf = Buffer.from(String(plain), 'utf8');
    const storedBuf = Buffer.from(s, 'utf8');
    const valid = plainBuf.length === storedBuf.length && crypto.timingSafeEqual(plainBuf, storedBuf);
    return { valid, needsUpgrade: valid };
}

function checkCredentials(username, password) {
    const u = username ? String(username).trim().toLowerCase() : '';
    const p = String(password || '');
    const entry = USERS.get(u);
    if (!entry) return null;
    const { valid, needsUpgrade } = verifyPassword(p, entry.password);
    if (!valid) return null;
    if (entry.disabled === true) return { disabled: true };
    if (needsUpgrade && !envUsernames.has(u)) {
        try {
            const newHash = hashPassword(p);
            entry.password = newHash;
            const idx = approvedSignups.findIndex(x => String(x.username || '').toLowerCase() === u);
            if (idx >= 0) {
                approvedSignups[idx].password = newHash;
                saveApprovedSignups(approvedSignups);
                console.log(`[auth] migrated plaintext password to scrypt for ${u}`);
            }
        } catch (err) {
            console.warn('[auth] password hash migration failed:', err.message);
        }
    }
    return { username: entry.username, role: entry.role, mustChangePassword: entry.mustChangePassword === true };
}

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] 
});
const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

let currentConnection = null;
let currentVolume = 0.5;
let playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, duration: null, startedBy: null };
let multiPlayEnabled = false;

// --- PCM Mixer for multi-play ---
class AudioMixer extends Readable {
    constructor() {
        super();
        this.tracks = new Map();
        this.nextTrackId = 1;
        this.mixTimer = null;
        this.destroyed = false;
        this.FRAME_SIZE = 3840; // 20ms of s16le stereo 48kHz (960 samples × 2ch × 2 bytes)
    }

    addTrack(pcmStream, metadata, ffmpegProc, opts) {
        const id = this.nextTrackId++;
        const priority = !!(opts && opts.priority);
        const track = { id, stream: pcmStream, chunks: [], chunkBytes: 0, ended: false, metadata, ffmpegProc: ffmpegProc || null, priority };
        pcmStream.on('data', chunk => { track.chunks.push(chunk); track.chunkBytes += chunk.length; });
        pcmStream.on('end', () => { track.ended = true; });
        pcmStream.on('error', () => { track.ended = true; });
        this.tracks.set(id, track);
        if (!this.mixTimer) this._startMixing();
        return id;
    }

    _consumeFrame(track) {
        if (track.chunkBytes < this.FRAME_SIZE) return null;
        // Walk chunks and copy into a single FRAME_SIZE buffer instead of
        // Buffer.concat(all) + slice. With many small inbound chunks per
        // tick (ffmpeg emits ~256-byte stdout chunks) the old path allocated
        // O(N*FRAME_SIZE) per 20 ms tick per track — pretty wasteful.
        const frame = Buffer.allocUnsafe(this.FRAME_SIZE);
        let copied = 0;
        while (copied < this.FRAME_SIZE && track.chunks.length > 0) {
            const c = track.chunks[0];
            const need = this.FRAME_SIZE - copied;
            if (c.length <= need) {
                c.copy(frame, copied);
                copied += c.length;
                track.chunks.shift();
                track.chunkBytes -= c.length;
            } else {
                c.copy(frame, copied, 0, need);
                copied += need;
                track.chunks[0] = c.subarray(need);
                track.chunkBytes -= need;
            }
        }
        return frame;
    }

    removeTrack(id) {
        const track = this.tracks.get(id);
        if (track) {
            if (track.stream && !track.stream.destroyed) track.stream.destroy();
            // SIGPIPE on stdout would eventually kill ffmpeg anyway, but
            // rapid Stop/Play storms can leave several zombies for a few
            // seconds. Explicit SIGKILL avoids that.
            if (track.ffmpegProc && !track.ffmpegProc.killed) {
                try { track.ffmpegProc.kill('SIGKILL'); } catch {}
            }
            this.tracks.delete(id);
        }
    }

    removeAllTracks() {
        for (const [, track] of this.tracks) {
            if (track.stream && !track.stream.destroyed) track.stream.destroy();
            if (track.ffmpegProc && !track.ffmpegProc.killed) {
                try { track.ffmpegProc.kill('SIGKILL'); } catch {}
            }
        }
        this.tracks.clear();
    }

    getActiveTrackCount() { return this.tracks.size; }

    _startMixing() {
        let silenceCount = 0;
        this._mixStartTime = process.hrtime.bigint();
        this._mixFrameCount = 0;
        const tick = () => {
            if (this.destroyed) return;
            // Clean up finished tracks
            for (const [id, track] of this.tracks) {
                if (track.ended && track.chunkBytes < this.FRAME_SIZE) this.tracks.delete(id);
            }
            if (this.tracks.size === 0) {
                silenceCount++;
                if (silenceCount >= 5) { this.mixTimer = null; this.push(null); return; }
                this.push(Buffer.alloc(this.FRAME_SIZE));
            } else {
                silenceCount = 0;
                const mixed = Buffer.alloc(this.FRAME_SIZE);
                // Two-pass mix so we can apply sidechain ducking: if any
                // priority track (TTS, voice-trigger fires) is contributing
                // this frame, knock non-priority tracks down ~12 dB so
                // speech sits on top of music without clipping.
                const DUCK_GAIN = 0.25;
                const contributing = [];
                let priorityActive = false;
                for (const [, track] of this.tracks) {
                    const frame = this._consumeFrame(track);
                    if (!frame) continue;
                    contributing.push({ frame, priority: track.priority });
                    if (track.priority) priorityActive = true;
                }
                for (const { frame, priority } of contributing) {
                    const ducked = priorityActive && !priority;
                    for (let i = 0; i < this.FRAME_SIZE; i += 2) {
                        const sample = ducked
                            ? Math.round(frame.readInt16LE(i) * DUCK_GAIN)
                            : frame.readInt16LE(i);
                        const sum = mixed.readInt16LE(i) + sample;
                        mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i);
                    }
                }
                this.push(mixed);
            }
            // Schedule next frame with drift compensation
            this._mixFrameCount++;
            const elapsed = Number(process.hrtime.bigint() - this._mixStartTime) / 1e6; // ms
            const nextAt = this._mixFrameCount * 20; // ideal time for next frame
            const delay = Math.max(0, nextAt - elapsed);
            this.mixTimer = setTimeout(tick, delay);
        };
        this.mixTimer = setTimeout(tick, 20);
    }

    _stopMixing() {
        if (this.mixTimer) { clearTimeout(this.mixTimer); this.mixTimer = null; }
    }

    _read() {}

    _destroy(err, callback) {
        this.destroyed = true;
        this._stopMixing();
        this.removeAllTracks();
        callback(err);
    }
}

let activeMixer = null;
let activeTracks = new Map(); // trackId -> { filename, displayName, startTime, startTimeOffset, duration, startedBy, volume, playId }
let currentSinglePlayId = null; // DB row id for the in-flight single-play track (null in multi-play mode)

function finalizeAllOpenPlays(stoppedEarly) {
    const opts = typeof stoppedEarly === 'boolean' ? { stoppedEarly } : {};
    if (currentSinglePlayId != null) {
        statsDb.recordPlayEnd(currentSinglePlayId, opts);
        currentSinglePlayId = null;
    }
    for (const t of activeTracks.values()) {
        if (t && t.playId != null) {
            statsDb.recordPlayEnd(t.playId, opts);
            t.playId = null;
        }
    }
}

// ---------------------------------------------------------------------------
// Voting: /votekick (voice disconnect) and /votetimeout (guild timeout).
// Eligible voters are members in the bot's current voice channel.
// ---------------------------------------------------------------------------
const activeVotes = new Map();         // voteId -> vote state object
const voteTargetCooldown = new Map();  // targetUserId -> ms timestamp when cooldown ends

function makeVoteId() {
    return crypto.randomBytes(6).toString('hex');
}

function eligibleVotersInBotChannel(guild, excludeUserId) {
    if (!guild || !lastChannelId) return [];
    const channel = guild.channels.cache.get(lastChannelId);
    if (!channel || !channel.isVoiceBased?.()) return [];
    const out = [];
    channel.members.forEach((member) => {
        if (member.user.bot) return;
        if (excludeUserId && member.id === excludeUserId) return;
        out.push(member);
    });
    return out;
}

function memberHasImmuneRole(member, immuneRoleIds) {
    if (!member || !Array.isArray(immuneRoleIds) || !immuneRoleIds.length) return false;
    const memberRoles = member.roles?.cache;
    if (!memberRoles) return false;
    for (const id of immuneRoleIds) if (memberRoles.has(id)) return true;
    return false;
}

function buildVotePanel(vote) {
    const cfg = getVotingConfig();
    const remainingMs = Math.max(0, vote.expiresAt - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    const yesCount = [...vote.voters.values()].filter(v => v === 'yes').length;
    const noCount = [...vote.voters.values()].filter(v => v === 'no').length;
    const eligibleCount = vote.eligible.size;
    const action = vote.type === 'kick'
        ? `kick <@${vote.targetUserId}> from the voice channel`
        : `timeout <@${vote.targetUserId}> for ${vote.timeoutMinutes} minute${vote.timeoutMinutes === 1 ? '' : 's'}`;
    const lines = [
        `**Vote called by <@${vote.initiatorUserId}>** to ${action}.`,
        vote.reason ? `_Reason:_ ${vote.reason}` : null,
        `Threshold: **${vote.threshold} / ${eligibleCount} Yes** required · Closes in **${remainingSec}s**`,
    ].filter(Boolean);
    const embed = new EmbedBuilder()
        .setTitle(vote.type === 'kick' ? 'Vote to kick' : 'Vote to timeout')
        .setColor(vote.type === 'kick' ? 0xed4245 : 0xfaa61a)
        .setDescription(lines.join('\n'))
        .addFields(
            { name: 'Yes', value: String(yesCount), inline: true },
            { name: 'No',  value: String(noCount),  inline: true },
            { name: 'Pending', value: String(eligibleCount - yesCount - noCount), inline: true },
        );
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`vote:${vote.id}:yes`).setLabel(`Yes (${yesCount})`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`vote:${vote.id}:no`).setLabel(`No (${noCount})`).setStyle(ButtonStyle.Danger),
    );
    return { embeds: [embed], components: [row] };
}

async function refreshVoteMessage(vote) {
    if (!vote.message) return;
    try { await vote.message.edit(buildVotePanel(vote)); } catch (err) { console.warn('[voting] edit failed:', err.message); }
}

async function executeVoteAction(vote) {
    const guild = client.guilds.cache.get(vote.guildId);
    if (!guild) return { ok: false, reason: 'guild-missing' };
    try {
        const member = await guild.members.fetch(vote.targetUserId);
        if (vote.type === 'kick') {
            if (!member.voice?.channelId) return { ok: false, reason: 'not-in-voice' };
            await member.voice.disconnect(vote.reason || 'Vote-kick');
            return { ok: true };
        }
        if (vote.type === 'timeout') {
            // Refuse to re-timeout someone who's already timed out — the
            // Discord API silently extends the existing timeout in that case,
            // which is rarely what voters intend ("they're already out").
            if (typeof member.isCommunicationDisabled === 'function' && member.isCommunicationDisabled()) {
                return { ok: false, reason: 'already-timed-out' };
            }
            const ms = Math.min(vote.timeoutMinutes * 60 * 1000, 28 * 24 * 60 * 60 * 1000);
            await member.timeout(ms, vote.reason || 'Vote-timeout');
            return { ok: true };
        }
        return { ok: false, reason: 'unknown-type' };
    } catch (err) {
        return { ok: false, reason: 'discord-error', error: err.message };
    }
}

async function finalizeVote(vote, outcome) {
    if (vote.finalized) return;
    vote.finalized = true;
    if (vote.timer) { clearTimeout(vote.timer); vote.timer = null; }
    activeVotes.delete(vote.id);

    const yesCount = [...vote.voters.values()].filter(v => v === 'yes').length;
    const noCount = [...vote.voters.values()].filter(v => v === 'no').length;
    const eligibleCount = vote.eligible.size;
    const passed = yesCount >= vote.threshold;

    // Resolve voters to displayName + choice for the persisted audit trail
    // and the final Discord embed.
    const guild = client.guilds.cache.get(vote.guildId);
    const voterDetails = [];
    for (const [userId, choice] of vote.voters) {
        const m = guild?.members?.cache?.get(userId);
        voterDetails.push({
            userId,
            name: m?.displayName || m?.user?.username || userId,
            choice,
        });
    }

    let actionResult = null;
    if (passed) actionResult = await executeVoteAction(vote);
    if (passed && actionResult?.ok) {
        const cooldownMs = getVotingConfig().targetCooldownSec * 1000;
        if (cooldownMs > 0) voteTargetCooldown.set(vote.targetUserId, Date.now() + cooldownMs);
    }

    recordVoteEvent({
        voteId: vote.id,
        type: vote.type,
        initiatorUserId: vote.initiatorUserId,
        initiatorUsername: vote.initiatorUsername,
        targetUserId: vote.targetUserId,
        targetUsername: vote.targetUsername,
        reason: vote.reason || null,
        yes: yesCount,
        no: noCount,
        eligible: eligibleCount,
        threshold: vote.threshold,
        outcome,
        passed,
        actionOk: actionResult?.ok === true,
        actionError: actionResult?.ok === false ? (actionResult.error || actionResult.reason || 'unknown') : null,
        timeoutMinutes: vote.type === 'timeout' ? vote.timeoutMinutes : null,
        voters: voterDetails,
    });
    statsDb.recordAdminAction({
        actor: vote.initiatorUsername || vote.initiatorUserId,
        actorRole: 'discord-user',
        action: 'voting.' + (passed ? (vote.type === 'kick' ? 'kick' : 'timeout') : 'failed'),
        target: vote.targetUsername || vote.targetUserId,
        details: { yes: yesCount, no: noCount, eligible: eligibleCount, outcome, actionOk: actionResult?.ok === true },
    });

    const summaryLines = [
        passed
            ? (actionResult?.ok ? '✅ **Vote passed** — action applied.' : `⚠️ **Vote passed** but action failed: ${actionResult?.error || actionResult?.reason}`)
            : `❌ **Vote failed** — ${outcome === 'no-overtake-impossible' ? 'Yes can no longer reach threshold.' : outcome === 'window-expired' ? 'Window expired.' : 'Insufficient yes votes.'}`,
        `Final tally: **${yesCount} Yes** / **${noCount} No** / ${eligibleCount - yesCount - noCount} no-vote (threshold ${vote.threshold}).`,
    ];
    const yesNames = voterDetails.filter(v => v.choice === 'yes').map(v => v.name);
    const noNames = voterDetails.filter(v => v.choice === 'no').map(v => v.name);
    if (yesNames.length) summaryLines.push(`**Yes:** ${yesNames.join(', ')}`);
    if (noNames.length) summaryLines.push(`**No:** ${noNames.join(', ')}`);
    const embed = new EmbedBuilder()
        .setTitle(vote.type === 'kick' ? (passed ? 'Vote-kick passed' : 'Vote-kick failed') : (passed ? 'Vote-timeout passed' : 'Vote-timeout failed'))
        .setColor(passed && actionResult?.ok ? 0x57f287 : 0x99aab5)
        .setDescription(summaryLines.join('\n'));
    try { if (vote.message) await vote.message.edit({ embeds: [embed], components: [] }); } catch {}
}

async function handleVoteStart(interaction, type) {
    const cfg = getVotingConfig();
    if (!cfg.enabled) return interaction.reply({ content: 'Voting is disabled.', flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== activeGuildId || !lastChannelId) {
        return interaction.reply({ content: 'The bot is not currently connected to a voice channel in this server.', flags: MessageFlags.Ephemeral });
    }
    const target = interaction.options.getUser('user');
    if (!target) return interaction.reply({ content: 'You must specify a user.', flags: MessageFlags.Ephemeral });
    if (target.bot) return interaction.reply({ content: 'Cannot vote on a bot.', flags: MessageFlags.Ephemeral });
    if (target.id === interaction.user.id) return interaction.reply({ content: 'You cannot vote on yourself.', flags: MessageFlags.Ephemeral });

    const reason = interaction.options.getString('reason') || null;
    let timeoutMinutes = null;
    if (type === 'timeout') {
        timeoutMinutes = Math.max(1, Math.min(cfg.maxTimeoutMinutes, interaction.options.getInteger('minutes') || 0));
        if (!timeoutMinutes) return interaction.reply({ content: 'Provide a minutes value between 1 and ' + cfg.maxTimeoutMinutes + '.', flags: MessageFlags.Ephemeral });
    }

    const guild = interaction.guild;
    const initiatorMember = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!initiatorMember || initiatorMember.voice?.channelId !== lastChannelId) {
        return interaction.reply({ content: 'You must be in the bot\'s voice channel to call a vote.', flags: MessageFlags.Ephemeral });
    }
    const targetMember = await guild.members.fetch(target.id).catch(() => null);
    if (!targetMember || targetMember.voice?.channelId !== lastChannelId) {
        return interaction.reply({ content: 'The target must be in the bot\'s voice channel.', flags: MessageFlags.Ephemeral });
    }
    if (memberHasImmuneRole(targetMember, cfg.immuneRoleIds)) {
        return interaction.reply({ content: 'That user has an immune role and cannot be voted on.', flags: MessageFlags.Ephemeral });
    }
    const cooldownEnd = voteTargetCooldown.get(target.id) || 0;
    if (cooldownEnd > Date.now()) {
        const sec = Math.ceil((cooldownEnd - Date.now()) / 1000);
        return interaction.reply({ content: `That user was already voted on recently. Try again in ${sec}s.`, flags: MessageFlags.Ephemeral });
    }
    // One in-flight vote per target.
    for (const v of activeVotes.values()) {
        if (v.targetUserId === target.id) {
            return interaction.reply({ content: 'A vote on this user is already in progress.', flags: MessageFlags.Ephemeral });
        }
    }
    const eligibleMembers = eligibleVotersInBotChannel(guild, target.id);
    if (eligibleMembers.length < cfg.minVoters) {
        return interaction.reply({ content: `Not enough eligible voters (${eligibleMembers.length} / need ${cfg.minVoters}).`, flags: MessageFlags.Ephemeral });
    }
    const eligibleIds = new Set(eligibleMembers.map(m => m.id));
    if (!eligibleIds.has(interaction.user.id)) {
        return interaction.reply({ content: 'You are not eligible to vote (must be in the bot\'s voice channel as a non-bot user).', flags: MessageFlags.Ephemeral });
    }

    const threshold = Math.max(1, Math.ceil(eligibleIds.size * cfg.thresholdPct / 100));
    const windowMs = cfg.windowSec * 1000;
    const vote = {
        id: makeVoteId(),
        type,
        targetUserId: target.id,
        targetUsername: targetMember.user.tag,
        initiatorUserId: interaction.user.id,
        initiatorUsername: interaction.user.tag,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        voters: new Map([[interaction.user.id, 'yes']]),
        eligible: eligibleIds,
        threshold,
        expiresAt: Date.now() + windowMs,
        reason,
        timeoutMinutes,
        message: null,
        timer: null,
        finalized: false,
    };
    activeVotes.set(vote.id, vote);
    await interaction.reply(buildVotePanel(vote));
    vote.message = await interaction.fetchReply().catch(() => null);
    vote.timer = setTimeout(() => finalizeVote(vote, 'window-expired'), windowMs);

    // Check if the initiator's auto-Yes already decides it.
    if ([...vote.voters.values()].filter(v => v === 'yes').length >= vote.threshold) {
        await finalizeVote(vote, 'threshold-reached');
    }
}

async function handleVoteButton(interaction, voteId, choice) {
    const vote = activeVotes.get(voteId);
    if (!vote || vote.finalized) {
        return interaction.reply({ content: 'This vote has ended.', flags: MessageFlags.Ephemeral });
    }
    if (!vote.eligible.has(interaction.user.id)) {
        return interaction.reply({ content: 'You are not eligible to vote (must be in the bot\'s voice channel).', flags: MessageFlags.Ephemeral });
    }
    if (vote.voters.has(interaction.user.id)) {
        return interaction.reply({ content: 'You already voted.', flags: MessageFlags.Ephemeral });
    }
    vote.voters.set(interaction.user.id, choice);
    await interaction.reply({ content: `Your **${choice.toUpperCase()}** vote was recorded.`, flags: MessageFlags.Ephemeral });

    const yesCount = [...vote.voters.values()].filter(v => v === 'yes').length;
    const noCount  = [...vote.voters.values()].filter(v => v === 'no').length;
    const remaining = vote.eligible.size - yesCount - noCount;
    if (yesCount >= vote.threshold) {
        await refreshVoteMessage(vote);
        return finalizeVote(vote, 'threshold-reached');
    }
    if (yesCount + remaining < vote.threshold) {
        await refreshVoteMessage(vote);
        return finalizeVote(vote, 'no-overtake-impossible');
    }
    await refreshVoteMessage(vote);
}

async function registerSlashCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('votekick')
            .setDescription("Vote to disconnect a user from the bot's voice channel")
            .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
        new SlashCommandBuilder()
            .setName('votetimeout')
            .setDescription('Vote to timeout a user in the guild')
            .addUserOption(o => o.setName('user').setDescription('User to timeout').setRequired(true))
            .addIntegerOption(o => o.setName('minutes').setDescription('Minutes (1-40320)').setRequired(true).setMinValue(1).setMaxValue(40320))
            .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
        new SlashCommandBuilder()
            .setName('rejoin')
            .setDescription("Move the soundboard into your current voice channel (or bounce it if it's stuck)"),
        new SlashCommandBuilder()
            .setName('clip')
            .setDescription('Save the last N seconds of voice-channel audio as a previewable clip')
            .addIntegerOption(o => o.setName('seconds').setDescription(`Seconds to clip (${CLIP_MIN_REQUEST_SEC}-${CLIP_MAX_REQUEST_SEC}, default ${CLIP_DEFAULT_REQUEST_SEC})`).setRequired(false).setMinValue(CLIP_MIN_REQUEST_SEC).setMaxValue(CLIP_MAX_REQUEST_SEC)),
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Play a soundboard sound through the bot')
            .addStringOption(o => o.setName('sound').setDescription('Sound name (autocompletes)').setRequired(true).setAutocomplete(true)),
        new SlashCommandBuilder()
            .setName('watch')
            .setDescription('Start a synced Watch Together room around a video URL')
            .addStringOption(o => o.setName('url').setDescription('YouTube / Vimeo / Twitch / direct video / weflix URL').setRequired(true))
            .addBooleanOption(o => o.setName('public').setDescription('Post the join link to the channel (default: only you see it)').setRequired(false)),
        new SlashCommandBuilder()
            .setName('movienight')
            .setDescription('Open a pre-watch room where everyone adds candidate URLs + votes on which to play'),
        new SlashCommandBuilder()
            .setName('wheel')
            .setDescription('Spin a wheel for any decision — opens a modal where you type options'),
        new SlashCommandBuilder()
            .setName('stop')
            .setDescription('Stop all soundboard playback (sounds, TTS, and the URL queue)'),
        new SlashCommandBuilder()
            .setName('skip')
            .setDescription('Skip the current URL stream'),
    ].map(c => c.toJSON());
    for (const [, guild] of client.guilds.cache) {
        try {
            await guild.commands.set(commands);
            console.log(`[slash] commands registered in ${guild.name}`);
        } catch (err) {
            console.error('[slash] failed to register commands in', guild.id, err.message);
        }
    }
}

// Rapid back-to-back rejoins leak UDP sockets and crash the process with
// `write ENOBUFS` once the kernel send-buffer fills up. Every rejoin path
// (manual /rejoin, Disconnected handler, premature-close burst) funnels
// through requestRejoin() below so the cooldown + in-flight guard catch them
// all.
const REJOIN_COOLDOWN_MS = 5_000;
const REJOIN_BOUNCE_DELAY_MS = 250;
let lastRejoinAt = 0;
let rejoinInflight = false;

function requestRejoin(reason, channelOverride = null) {
    const now = Date.now();
    const sinceLast = now - lastRejoinAt;
    if (sinceLast < REJOIN_COOLDOWN_MS) {
        return { ok: false, reason: 'cooldown', waitMs: REJOIN_COOLDOWN_MS - sinceLast };
    }
    if (rejoinInflight) {
        return { ok: false, reason: 'inflight' };
    }
    let channel = channelOverride;
    if (!channel && lastChannelId) {
        channel = client.channels.cache.get(lastChannelId);
    }
    if (!channel || !channel.isVoiceBased?.()) {
        return { ok: false, reason: 'no-channel' };
    }
    lastRejoinAt = now;
    rejoinInflight = true;
    console.warn(`[DIAG] voice.rejoin reason=${reason} channel=${channel.id} sinceLast=${sinceLast}ms`);
    (async () => {
        try {
            const wasConnected = !!activeGuildId;
            leaveVoiceChannel();
            if (wasConnected) await new Promise(r => setTimeout(r, REJOIN_BOUNCE_DELAY_MS));
            joinChannelById(channel);
            lastChannelId = channel.id;
            saveServerState({ lastChannelId });
        } catch (err) {
            console.error('[DIAG] voice.rejoin failed:', err.message);
        } finally {
            rejoinInflight = false;
        }
    })();
    return { ok: true, channel };
}

async function handleRejoinCommand(interaction) {
    const channel = interaction.member?.voice?.channel;
    if (!channel || !channel.isVoiceBased?.()) {
        return interaction.reply({ content: 'Join a voice channel first, then run `/rejoin` again.', flags: MessageFlags.Ephemeral });
    }
    const result = requestRejoin('manual', channel);
    if (!result.ok) {
        if (result.reason === 'cooldown') {
            const wait = Math.ceil(result.waitMs / 1000);
            return interaction.reply({ content: `Just bounced — give me ${wait}s before trying again.`, flags: MessageFlags.Ephemeral });
        }
        if (result.reason === 'inflight') {
            return interaction.reply({ content: 'Already bouncing — try again in a moment.', flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: 'Failed to join: could not resolve target channel.', flags: MessageFlags.Ephemeral });
    }
    console.log(`[slash] /rejoin by ${interaction.user?.tag ?? interaction.user?.id} -> #${channel.name}`);
    return interaction.reply({ content: `Joined **${channel.name}**.`, flags: MessageFlags.Ephemeral });
}

async function handleStopCommand(interaction) {
    // Gate the same way POST /api/stop does (requireAdmin): resolve the Discord
    // user to a linked account and require admin/superadmin.
    const un = findUsernameByDiscordId(interaction.user?.id);
    const role = un ? USERS.get(un)?.role : null;
    if (role !== 'admin' && role !== 'superadmin') {
        return interaction.reply({ content: 'Only linked admins can stop playback — link your account in the web UI first.', flags: MessageFlags.Ephemeral });
    }
    const wasPlaying = playbackState.status !== 'idle' || !!activeUrlStream || ttsQueue.length > 0 || urlStreamQueue.length > 0;
    stopAllPlayback();
    try {
        statsDb.recordAdminAction({
            actor: interaction.user?.tag || interaction.user?.id || 'discord',
            actorRole: 'discord', action: 'stop.slash', target: 'all', details: {},
        });
    } catch {}
    console.log(`[slash] /stop by ${interaction.user?.tag ?? interaction.user?.id}`);
    return interaction.reply({ content: wasPlaying ? '⏹ Stopped all playback.' : 'Nothing was playing.', flags: MessageFlags.Ephemeral });
}

async function handleSkipCommand(interaction) {
    if (!activeUrlStream) {
        return interaction.reply({ content: 'No URL stream is playing to skip.', flags: MessageFlags.Ephemeral });
    }
    // Gate the same way POST /api/stream-url/skip does: the stream's owner or an
    // admin (and only superadmin can skip superadmin playback).
    const un = findUsernameByDiscordId(interaction.user?.id);
    const role = un ? USERS.get(un)?.role : null;
    const isAdmin = role === 'admin' || role === 'superadmin';
    const current = playbackState.startedBy;
    const isOwn = !!(current && un && current.username === un);
    if (!isOwn && !isAdmin) {
        return interaction.reply({ content: 'You can only skip your own stream — ask an admin, or use the Vote-skip button in the web UI.', flags: MessageFlags.Ephemeral });
    }
    if (!isOwn && role === 'admin' && current?.role === 'superadmin') {
        return interaction.reply({ content: 'Only superadmin can skip superadmin playback.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const skippedTitle = playbackState.displayName || 'the current stream';
    try {
        statsDb.recordAdminAction({
            actor: interaction.user?.tag || interaction.user?.id || 'discord',
            actorRole: 'discord', action: 'skip.slash', target: playbackState.filename || 'url', details: {},
        });
    } catch {}
    try {
        await performUrlSkip();
        console.log(`[slash] /skip by ${interaction.user?.tag ?? interaction.user?.id}`);
        return interaction.editReply({ content: `⏭ Skipped ${skippedTitle}.` });
    } catch (err) {
        if (err.statusCode === 409) return interaction.editReply({ content: 'A skip is already in progress — try again in a moment.' });
        console.error('[slash] /skip failed:', err.message || err);
        return interaction.editReply({ content: 'Could not skip the stream.' });
    }
}

client.on('interactionCreate', async (interaction) => {
    try {
        // Each handler is awaited: `return handler()` (without await) lets the
        // returned promise reject OUTSIDE this try/catch, which then hits the
        // global unhandledRejection handler and crashes the process (e.g. a late
        // reply throwing DiscordAPIError 10062 under event-loop lag).
        if (interaction.isChatInputCommand?.()) {
            if (interaction.commandName === 'votekick') return await handleVoteStart(interaction, 'kick');
            if (interaction.commandName === 'votetimeout') return await handleVoteStart(interaction, 'timeout');
            if (interaction.commandName === 'rejoin') return await handleRejoinCommand(interaction);
            if (interaction.commandName === 'clip') return await handleClipCommand(interaction);
            if (interaction.commandName === 'play') return await handlePlayCommand(interaction);
            if (interaction.commandName === 'watch') return await handleWatchCommand(interaction);
            if (interaction.commandName === 'movienight') return await handleMovieNightCommand(interaction);
            if (interaction.commandName === 'wheel') return await handleWheelCommand(interaction);
            if (interaction.commandName === 'stop') return await handleStopCommand(interaction);
            if (interaction.commandName === 'skip') return await handleSkipCommand(interaction);
        } else if (interaction.isAutocomplete?.()) {
            if (interaction.commandName === 'play') return await handlePlayAutocomplete(interaction);
        } else if (interaction.isButton?.()) {
            const m = String(interaction.customId || '').match(/^vote:([^:]+):(yes|no)$/);
            if (m) return await handleVoteButton(interaction, m[1], m[2]);
            const w = String(interaction.customId || '').match(/^watch:post:(w_[a-f0-9]{8})$/i);
            if (w) return await handleWatchPostButton(interaction, w[1]);
            const mn = String(interaction.customId || '').match(/^mn:post:(mn_[a-f0-9]{8})$/i);
            if (mn) return await handleMovieNightPostButton(interaction, mn[1]);
        } else if (interaction.isModalSubmit?.()) {
            if (interaction.customId === 'wheel:modal') return await handleWheelModalSubmit(interaction);
        }
    } catch (err) {
        console.error('[voting] interaction error:', err);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ content: 'Internal error.', flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ content: 'Internal error.', flags: MessageFlags.Ephemeral });
            }
        } catch {}
    }
});

// ---------------------------------------------------------------------------
// Voice triggers: listen to the active voice channel and fire sounds when
// configured phrases are spoken. Uses vosk for streaming on-device STT,
// restricted to the configured phrase grammar so a tiny model is sufficient.
// ---------------------------------------------------------------------------
let voskModel = null;
let voskModelLoadAttempted = false;
let voskLib = null;
let voiceTriggerAttachedReceiver = null;
let voiceTriggerSpeakingListener = null; // so we can detach on teardown
const voiceTriggerSpeakers = new Map(); // userId -> { recognizer, opusStream, decoder, downmix }
const voiceTriggerLastFired = new Map(); // triggerId -> ms timestamp
let voiceTriggerGlobalLastFired = 0;     // ms timestamp of last fire across all triggers
let voiceTriggerActivePhrases = []; // enabled phrases; empty = short-circuit (no recognizer)
function recordVoiceTriggerEvent(entry) {
    const stored = { when: Date.now(), ...entry };
    // Persist to SQLite so the activity log survives restarts. The returned
    // object is kept as a live handle the partial->final transcript-upgrade
    // path mutates in place; the persisted row is a static snapshot.
    try { statsDb.recordVoiceTriggerEvent(stored); } catch (err) { console.warn('[voice-triggers] log persist failed:', err.message); }
    return stored;
}

// Decimate 48k stereo s16le → 16k mono s16le (3:1 group, simple average).
// Quality is fine for keyword spotting; we skip anti-alias filtering because
// the small vosk model + grammar restriction is robust to the aliasing.
class PcmStereo48ToMono16 extends Transform {
    constructor() { super(); this._buf = Buffer.alloc(0); }
    _transform(chunk, _enc, cb) {
        const buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
        const groupBytes = 12; // 3 stereo frames × 4 bytes
        const fullGroups = Math.floor(buf.length / groupBytes);
        const out = Buffer.alloc(fullGroups * 2);
        for (let g = 0; g < fullGroups; g++) {
            const off = g * groupBytes;
            let sum = 0;
            for (let i = 0; i < 3; i++) {
                sum += (buf.readInt16LE(off + i * 4) + buf.readInt16LE(off + i * 4 + 2)) / 2;
            }
            const v = Math.max(-32768, Math.min(32767, Math.round(sum / 3)));
            out.writeInt16LE(v, g * 2);
        }
        this._buf = buf.subarray(fullGroups * groupBytes);
        cb(null, out);
    }
}

function ensureVoskModel() {
    if (voskModel || voskModelLoadAttempted) return voskModel;
    voskModelLoadAttempted = true;
    try {
        const modelPath = path.join(__dirname, 'models', 'vosk-en-us-small');
        if (!fs.existsSync(path.join(modelPath, 'am', 'final.mdl'))) {
            console.warn('[voice-triggers] vosk model not found at', modelPath, '— run scripts/update.sh to install');
            return null;
        }
        voskLib = require('vosk-koffi');
        voskLib.setLogLevel(-1);
        voskModel = new voskLib.Model(modelPath);
        console.log('[voice-triggers] vosk model loaded');
    } catch (err) {
        console.error('[voice-triggers] failed to load vosk model:', err.message);
        voskModel = null;
    }
    return voskModel;
}

function voiceTriggerModelReady() {
    return ensureVoskModel() !== null;
}

function cleanupSpeakerEntry(entry) {
    if (!entry) return;
    try { entry.recognizer?.free?.(); } catch {}
    try { entry.opusStream?.destroy?.(); } catch {}
    try { entry.decoder?.destroy?.(); } catch {}
    try { entry.downmix?.destroy?.(); } catch {}
}

function rebuildVoiceTriggerGrammar() {
    // Snapshot keys before iterating because the body deletes from the same
    // Map. Works under V8 today but the spec doesn't guarantee it.
    // Open-vocabulary recognition so the activity log can show the full
    // transcribed sentence (a grammar-restricted recognizer can only emit
    // configured phrases). Substring matching against the full transcript
    // happens in handleSpeechResult. The phrases list is kept only so an
    // empty-list short-circuit avoids running vosk for nothing.
    const phrases = loadVoiceTriggers().filter(t => t.enabled).map(t => t.phrase);
    voiceTriggerActivePhrases = [...new Set(phrases)];
    const userIds = [...voiceTriggerSpeakers.keys()];
    for (const userId of userIds) {
        cleanupSpeakerEntry(voiceTriggerSpeakers.get(userId));
        voiceTriggerSpeakers.delete(userId);
    }
}

function startVoiceTriggerCapture() {
    if (!getVoiceTriggersEnabled()) return;
    if (!currentConnection) return;
    if (!ensureVoskModel()) return;
    const receiver = currentConnection.receiver;
    if (voiceTriggerAttachedReceiver === receiver) return; // already wired
    voiceTriggerAttachedReceiver = receiver;
    if (voiceTriggerActivePhrases.length === 0) rebuildVoiceTriggerGrammar();

    const onSpeakingStart = (userId) => {
        if (voiceTriggerAttachedReceiver !== receiver) return;
        if (voiceTriggerSpeakers.has(userId)) return;
        if (voiceTriggerActivePhrases.length === 0) return;
        let recognizer = null, opusStream = null, decoder = null, downmix = null;
        try {
            recognizer = new voskLib.Recognizer({ model: voskModel, sampleRate: 16000 });
            opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 800 } });
            decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
            downmix = new PcmStereo48ToMono16();
            // Tracks trigger.id -> activity-log entry already fired for this
            // speaking turn so vosk's partials can fire mid-sentence without
            // double-firing when the final result arrives with the same text.
            // The retained entry lets us upgrade the logged transcript to the
            // full sentence once vosk emits its final.
            const firedThisUtterance = new Map();
            let lastPartial = '';
            opusStream.pipe(decoder).pipe(downmix);
            // prism's opus decoder throws on malformed packets ("compressed
            // data passed is corrupted") and the error would otherwise
            // bubble to the global uncaughtException handler.
            decoder.on('error', (err) => console.warn('[voice-triggers] decoder error:', err && err.message));
            downmix.on('error', (err) => console.warn('[voice-triggers] downmix error:', err && err.message));
            downmix.on('data', (chunk) => {
                try {
                    if (recognizer.acceptWaveform(chunk)) {
                        const r = recognizer.result();
                        if (r && r.text) handleSpeechResult(userId, r.text, firedThisUtterance);
                        lastPartial = '';
                    } else {
                        const p = recognizer.partialResult();
                        const partial = p && p.partial;
                        if (partial && partial !== lastPartial) {
                            lastPartial = partial;
                            handleSpeechResult(userId, partial, firedThisUtterance);
                        }
                    }
                } catch (err) {
                    console.error('[voice-triggers] recognizer error:', err.message);
                }
            });
            let cleanedUp = false;
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                try {
                    const r = recognizer.finalResult();
                    if (r && r.text) handleSpeechResult(userId, r.text, firedThisUtterance);
                } catch {}
                cleanupSpeakerEntry(voiceTriggerSpeakers.get(userId));
                voiceTriggerSpeakers.delete(userId);
            };
            opusStream.on('end', cleanup);
            opusStream.on('error', cleanup);
            voiceTriggerSpeakers.set(userId, { recognizer, opusStream, decoder, downmix });
        } catch (err) {
            // Anything thrown between alloc and the speakers.set() above
            // leaves orphaned streams/recognizers. Clean up the locals on
            // the failure path so we don't leak across rejoins.
            console.error('[voice-triggers] failed to spin up recognizer:', err.message);
            try { recognizer?.free?.(); } catch {}
            try { opusStream?.destroy?.(); } catch {}
            try { decoder?.destroy?.(); } catch {}
            try { downmix?.destroy?.(); } catch {}
        }
    };
    receiver.speaking.on('start', onSpeakingStart);
    voiceTriggerSpeakingListener = onSpeakingStart;
    console.log('[voice-triggers] capture attached to receiver');
}

function stopVoiceTriggerCapture() {
    if (voiceTriggerAttachedReceiver && voiceTriggerSpeakingListener) {
        try { voiceTriggerAttachedReceiver.speaking.off('start', voiceTriggerSpeakingListener); } catch {}
    }
    voiceTriggerSpeakingListener = null;
    voiceTriggerAttachedReceiver = null;
    for (const [, entry] of voiceTriggerSpeakers) cleanupSpeakerEntry(entry);
    voiceTriggerSpeakers.clear();
}

// ---------------------------------------------------------------------------
// /clip — rolling buffer of recent voice-channel audio so users can rip the
// last N seconds out of the channel as a previewable / editable sound clip.
// Subscribes to every active speaker separately from the voice-trigger
// pipeline (so /clip works even when triggers are disabled) and keeps each
// user's last CLIP_BUFFER_MAX_SEC of 48 kHz stereo PCM in memory.
// ---------------------------------------------------------------------------
const CLIP_SAMPLE_RATE = 48000;
const CLIP_CHANNELS = 2;
const CLIP_BYTES_PER_SEC = CLIP_SAMPLE_RATE * CLIP_CHANNELS * 2; // 16-bit
const CLIP_BUFFER_MAX_SEC = 180;
const CLIP_MIN_REQUEST_SEC = 5;
const CLIP_MAX_REQUEST_SEC = 120;
const CLIP_DEFAULT_REQUEST_SEC = 30;
const CLIP_RETAIN_COUNT = 30;
const CLIPS_DIR = path.join(DATA_DIR, 'clips');
const CLIPS_INDEX_PATH = path.join(DATA_DIR, 'clips.json');
try { fs.mkdirSync(CLIPS_DIR, { recursive: true }); } catch {}

// Per speaker we keep a list of "sessions". Each session corresponds to one
// uninterrupted speaking turn (from receiver.speaking('start') until 800 ms
// of silence ends the subscription). Within a session, PCM chunks are
// strictly contiguous and back-to-back — Discord's opus decoder produces
// a continuous 48 kHz stereo stream while a user is talking. Recording
// per-chunk wall-clock timestamps (the previous design) was the source of
// the choppy/garbled output: event-loop jitter between Date.now() calls
// shifted consecutive 20 ms chunks by ±a few ms, so the mixer placed them
// at overlapping byte offsets and chopped/duplicated samples. By anchoring
// only on the session's first-chunk timestamp and laying every subsequent
// chunk down contiguously inside the session, the audio inside a turn is
// guaranteed bit-for-bit gapless; only the gap *between* sessions is
// approximate, which is exactly the right resolution for "clip the last
// N seconds" mixing.
//
//   clipBuffers: userId -> { sessions: [{ startTs, pcm: Buffer[], totalBytes }], activeSession }
const clipBuffers = new Map();
const clipCaptureSpeakers = new Map();   // userId -> { opusStream, decoder }
let clipCaptureAttachedReceiver = null;
let clipCaptureSpeakingListener = null;

function startClipSession(userId) {
    let buf = clipBuffers.get(userId);
    if (!buf) {
        buf = { sessions: [], active: null };
        clipBuffers.set(userId, buf);
    }
    const session = { startTs: Date.now(), pcm: [], totalBytes: 0 };
    buf.sessions.push(session);
    buf.active = session;
}

function endClipSession(userId) {
    const buf = clipBuffers.get(userId);
    if (buf) buf.active = null;
}

function appendClipChunk(userId, pcm) {
    const buf = clipBuffers.get(userId);
    if (!buf || !buf.active) return;
    buf.active.pcm.push(pcm);
    buf.active.totalBytes += pcm.length;
    // Cap retention per-user. Drop the oldest closed session entirely
    // whenever total bytes exceed the cap. (Don't trim the active session
    // — splitting it would re-introduce the contiguity problem.)
    const cap = CLIP_BUFFER_MAX_SEC * CLIP_BYTES_PER_SEC;
    let totalBytes = 0;
    for (const s of buf.sessions) totalBytes += s.totalBytes;
    while (totalBytes > cap && buf.sessions.length > 1) {
        const dropped = buf.sessions.shift();
        totalBytes -= dropped.totalBytes;
        if (buf.active === dropped) buf.active = null;
    }
}

function mixClipToPcm(seconds) {
    const totalShorts = seconds * CLIP_SAMPLE_RATE * CLIP_CHANNELS;
    const out = new Int16Array(totalShorts);
    const now = Date.now();
    const startMs = now - seconds * 1000;
    for (const [, buf] of clipBuffers) {
        for (const session of buf.sessions) {
            if (session.totalBytes === 0) continue;
            const sessionDurMs = (session.totalBytes / CLIP_BYTES_PER_SEC) * 1000;
            if (session.startTs + sessionDurMs < startMs) continue;
            if (session.startTs > now) continue;
            // Concatenate session PCM once (so the Int16Array view is
            // properly aligned with a clean underlying ArrayBuffer).
            const sessionPcm = session.pcm.length === 1 ? session.pcm[0] : Buffer.concat(session.pcm, session.totalBytes);
            let outShortOffset = Math.floor(((session.startTs - startMs) / 1000) * CLIP_SAMPLE_RATE) * CLIP_CHANNELS;
            let sessionShortStart = 0;
            if (outShortOffset < 0) {
                sessionShortStart = -outShortOffset;
                outShortOffset = 0;
            }
            const sessionInt16 = new Int16Array(sessionPcm.buffer, sessionPcm.byteOffset, sessionPcm.length / 2);
            const copyLen = Math.min(sessionInt16.length - sessionShortStart, totalShorts - outShortOffset);
            for (let i = 0; i < copyLen; i++) {
                const sum = out[outShortOffset + i] + sessionInt16[sessionShortStart + i];
                out[outShortOffset + i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
            }
        }
    }
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function encodeClipPcmToMp3(pcmBuffer) {
    return new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
            '-nostdin', '-y',
            '-f', 's16le', '-ar', String(CLIP_SAMPLE_RATE), '-ac', String(CLIP_CHANNELS),
            '-i', 'pipe:0',
            '-c:a', 'libmp3lame', '-b:a', '192k',
            '-f', 'mp3', 'pipe:1',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks = [];
        ff.stdout.on('data', c => chunks.push(c));
        ff.stderr.on('data', () => {});
        ff.on('error', reject);
        ff.on('close', code => {
            if (code !== 0) return reject(new Error('ffmpeg exit ' + code));
            resolve(Buffer.concat(chunks));
        });
        ff.stdin.end(pcmBuffer);
    });
}

function loadClipsIndex() {
    try {
        const raw = fs.readFileSync(CLIPS_INDEX_PATH, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch { return []; }
}
function saveClipsIndex(arr) {
    writeJsonAtomic(CLIPS_INDEX_PATH, arr);
}

function startClipCapture() {
    if (!currentConnection) return;
    const receiver = currentConnection.receiver;
    if (clipCaptureAttachedReceiver === receiver) return;
    clipCaptureAttachedReceiver = receiver;
    const onSpeakingStart = (userId) => {
        if (clipCaptureAttachedReceiver !== receiver) return;
        if (clipCaptureSpeakers.has(userId)) return;
        let opusStream = null, decoder = null;
        try {
            opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 800 } });
            decoder = new prism.opus.Decoder({ rate: CLIP_SAMPLE_RATE, channels: CLIP_CHANNELS, frameSize: 960 });
            startClipSession(userId);
            opusStream.pipe(decoder);
            decoder.on('error', (err) => console.warn('[clip] decoder error:', err && err.message));
            decoder.on('data', (chunk) => { try { appendClipChunk(userId, Buffer.from(chunk)); } catch {} });
            let cleanedUp = false;
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                endClipSession(userId);
                try { opusStream.destroy(); } catch {}
                try { decoder.destroy(); } catch {}
                clipCaptureSpeakers.delete(userId);
            };
            opusStream.on('end', cleanup);
            opusStream.on('error', cleanup);
            clipCaptureSpeakers.set(userId, { opusStream, decoder });
        } catch (err) {
            console.error('[clip] capture attach failed for', userId, err.message);
            try { opusStream?.destroy?.(); } catch {}
            try { decoder?.destroy?.(); } catch {}
            endClipSession(userId);
        }
    };
    receiver.speaking.on('start', onSpeakingStart);
    clipCaptureSpeakingListener = onSpeakingStart;
    console.log('[clip] capture attached to receiver');
}

function stopClipCapture() {
    if (clipCaptureAttachedReceiver && clipCaptureSpeakingListener) {
        try { clipCaptureAttachedReceiver.speaking.off('start', clipCaptureSpeakingListener); } catch {}
    }
    clipCaptureSpeakingListener = null;
    clipCaptureAttachedReceiver = null;
    for (const [, entry] of clipCaptureSpeakers) {
        try { entry.opusStream?.destroy?.(); } catch {}
        try { entry.decoder?.destroy?.(); } catch {}
    }
    clipCaptureSpeakers.clear();
    clipBuffers.clear();
}

// ---------------------------------------------------------------------------
// Watch Together — synced video rooms.
// Bot creates a short-lived room around a video URL; viewers open
// /watch/<id> and the player keeps everyone roughly in lockstep via a
// WebSocket broadcast of host play / pause / seek events. Supports four
// sourceType paths:
//   youtube  — full sync via the YouTube iframe Player API
//   video    — direct .mp4 / .m3u8 → HTML5 <video> with full sync
//   vimeo    — Vimeo Player API (full sync)
//   twitch   — Twitch Embed Player API (full sync, best-effort on live)
//   iframe   — generic embed (weflix.org etc.) — click-to-start sync only;
//              host's "play now" event fires a synchronized resume but the
//              embedded player won't accept further programmatic control.
// ---------------------------------------------------------------------------
const WATCH_ROOM_TTL_MS = 6 * 60 * 60 * 1000;  // 6h idle
const WATCH_ROOM_MAX_VIEWERS = 50;
const watchRooms = new Map(); // id -> { id, url, sourceType, sourceMeta, hostUsername, hostRole, createdAt, lastActivity, state, viewers: Set<ws> }

function _watchExtractYouTubeId(u) {
    try {
        const url = new URL(u);
        if (/(^|\.)youtube\.com$/.test(url.hostname)) {
            const v = url.searchParams.get('v');
            if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) return v;
            const m = url.pathname.match(/^\/(?:embed|shorts|v)\/([A-Za-z0-9_-]+)/);
            if (m) return m[1];
        }
        if (/(^|\.)youtu\.be$/.test(url.hostname)) {
            const m = url.pathname.match(/^\/([A-Za-z0-9_-]+)/);
            if (m) return m[1];
        }
    } catch {}
    return null;
}
function _watchExtractVimeoId(u) {
    try {
        const url = new URL(u);
        if (!/(^|\.)vimeo\.com$/.test(url.hostname)) return null;
        const m = url.pathname.match(/^\/(\d{6,})/);
        return m ? m[1] : null;
    } catch { return null; }
}
function _watchExtractTwitch(u) {
    try {
        const url = new URL(u);
        if (!/(^|\.)twitch\.tv$/.test(url.hostname)) return null;
        // VOD: /videos/<id>; live: /<channel>
        const vod = url.pathname.match(/^\/videos\/(\d+)/);
        if (vod) return { kind: 'video', id: vod[1] };
        const ch = url.pathname.match(/^\/([A-Za-z0-9_]+)$/);
        if (ch && !['videos', 'directory'].includes(ch[1])) return { kind: 'channel', id: ch[1] };
        return null;
    } catch { return null; }
}
// Some aggregator sites (weflix.org → vidsrcme.ru, similar shells) just
// frame a third-party player. yt-dlp doesn't have extractors for the wrapper
// itself, only the underlying provider. Fetch the wrapper page, regex out
// the player iframe src, return that.
async function unwrapAggregatorEmbed(url) {
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
    if (!/(^|\.)(weflix\.org|watchug\.com)$/i.test(host)) return null;
    try {
        const res = await fetch(url, {
            headers: {
                'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml',
            },
        });
        if (!res.ok) return null;
        const html = await res.text();
        const m = html.match(/<iframe[^>]+src=["']([^"']+(?:vidsrc|vidsrcme|streamhg|filemoon|mixdrop|streamtape|doodstream|streamwish|upstream|streamzz|fembed|playerwish|streamhide)[^"']*)["']/i);
        if (m && m[1]) return m[1];
    } catch (err) {
        console.warn('[watch] unwrapAggregatorEmbed failed for', url, err.message);
    }
    return null;
}

// Resolve a YouTube URL to a direct progressive CDN URL via yt-dlp using the
// existing cookie session. Lets us serve YouTube videos as HTML5 <video>
// instead of the iframe — full programmatic sync + sidesteps YouTube's
// viewer-side "Sign in to confirm you're not a bot" wall.
function resolveDirectVideoUrlViaYtDlp(sourceUrl) {
    return new Promise((resolve) => {
        const args = ytdlpCommonArgs();
        // Progressive single-file MP4 plays in every browser with one URL.
        // YouTube progressive caps at ~720p but that's fine for a watch
        // party; we'd need MSE + DASH for higher quality.
        args.push('-f', 'best[ext=mp4][acodec!=none][vcodec!=none]/best[ext=mp4]/best');
        args.push('-g', '--no-warnings', sourceUrl);
        let stdout = '', stderr = '';
        let child;
        try { child = spawn(YT_DLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { resolve(null); return; }
        const tmo = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(null); }, 15000);
        child.stdout.on('data', d => stdout += d.toString());
        child.stderr.on('data', d => stderr += d.toString());
        child.on('error', () => { clearTimeout(tmo); resolve(null); });
        child.on('close', (code) => {
            clearTimeout(tmo);
            if (code !== 0) { console.warn('[watch] yt-dlp resolve failed (' + code + '):', stderr.split('\n').slice(-2).join(' ').trim()); resolve(null); return; }
            const lines = stdout.split('\n').map(s => s.trim()).filter(Boolean);
            resolve(lines[0] || null);
        });
    });
}

function _watchDetectSource(url) {
    const u = String(url || '').trim();
    if (!u) return { sourceType: 'invalid', error: 'URL required' };
    if (!/^https?:\/\//i.test(u)) return { sourceType: 'invalid', error: 'URL must start with http(s)://' };
    // DRM-locked services we know upfront won't work in an iframe.
    const drm = /(^|\.)(netflix\.com|disneyplus\.com|max\.com|hbomax\.com|hulu\.com|primevideo\.com|amazon\.com\/.*\bdp\b|paramountplus\.com|peacocktv\.com|appletv\.com|apple\.com\/tv)/i;
    try {
        const parsed = new URL(u);
        // SSRF guard: don't let a user point the watch/capture/scrape pipeline at
        // internal hosts (169.254.169.254, Proxmox :8006, other LXCs, the router…).
        if (_isPrivateHost(parsed.hostname)) {
            return { sourceType: 'invalid', error: 'Private / loopback addresses are not allowed.' };
        }
        if (drm.test(parsed.hostname + parsed.pathname)) {
            return { sourceType: 'drm-blocked', error: 'This service uses DRM — the bot can\'t decrypt or re-stream it (industry-wide). Use Discord\'s built-in **Go Live / Screenshare** in voice instead: open the video in your browser, hit Go Live in the voice channel, friends in voice see your screen with the video.' };
        }
    } catch {}
    const yt = _watchExtractYouTubeId(u);
    if (yt) return { sourceType: 'youtube', sourceMeta: { videoId: yt } };
    const vi = _watchExtractVimeoId(u);
    if (vi) return { sourceType: 'vimeo', sourceMeta: { videoId: vi } };
    const tw = _watchExtractTwitch(u);
    if (tw) return { sourceType: 'twitch', sourceMeta: tw };
    // Direct video file?
    if (/\.(mp4|webm|m3u8|ogg|ogv)(\?|$)/i.test(u)) return { sourceType: 'video', sourceMeta: { url: u } };
    // Generic iframe fallback (weflix.org, vidsrcme, custom embed sites…).
    return { sourceType: 'iframe', sourceMeta: { url: u } };
}

function makeWatchRoomId() { return 'w_' + crypto.randomBytes(4).toString('hex'); }

function _watchBroadcast(room, payload) {
    const json = JSON.stringify(payload);
    for (const ws of room.viewers) {
        if (ws.readyState === 1) {
            try { ws.send(json); } catch {}
        }
    }
}

// Deduplicated [{username, role}] list of viewers currently in a room. One
// person can have multiple tabs open; we collapse those into a single pill.
function _viewerList(room) {
    const seen = new Map();
    for (const ws of room.viewers) {
        const un = ws._un;
        if (!un) continue;
        if (!seen.has(un)) seen.set(un, { username: un, role: ws._role || 'user' });
    }
    return Array.from(seen.values());
}

function _watchCurrentPosition(room) {
    if (!room.state.playing) return room.state.position;
    return room.state.position + (Date.now() - room.state.positionAt) / 1000;
}

function _watchRoomPublic(room) {
    return {
        id: room.id,
        url: room.url,
        sourceType: room.sourceType,
        sourceMeta: room.sourceMeta,
        hostUsername: room.hostUsername,
        hostRole: room.hostRole,
        createdAt: room.createdAt,
        viewerCount: room.viewers.size,
        state: {
            playing: room.state.playing,
            position: _watchCurrentPosition(room),
            updatedAt: Date.now(),
        },
    };
}

function _watchSweep() {
    const now = Date.now();
    const ttlMs = getWatchRoomTtlHours() * 60 * 60 * 1000;
    for (const [id, room] of watchRooms) {
        if (now - room.lastActivity > ttlMs && room.viewers.size === 0) {
            if (room.sourceMeta?.captureId) stopCaptureProxy(room.sourceMeta.captureId);
            watchRooms.delete(id);
        }
    }
}
setInterval(_watchSweep, 30 * 60 * 1000).unref?.();

// Watch Together resolution strategy — which extractors / proxies to try
// when creating a room. 'auto' tries each in order (ytdlp → cdp → capture);
// the others constrain to a single approach so the superadmin can A/B them.
const WATCH_STRATEGIES = ['auto', 'ytdlp', 'cdp', 'capture', 'iframe'];
function getWatchStrategy() {
    const v = loadGuestData().watchSyncStrategy;
    return WATCH_STRATEGIES.includes(v) ? v : 'auto';
}
function setWatchStrategy(v) {
    if (!WATCH_STRATEGIES.includes(v)) return false;
    const d = loadGuestData();
    d.watchSyncStrategy = v;
    saveGuestData(d);
    return true;
}

// CDP sniffer timeout — how long to let headless Chromium watch the page for
// stream URLs before giving up. Higher = more reliable on slow aggregators,
// lower = faster fallback to capture. Default 25s.
function getWatchCdpTimeoutMs() {
    const v = Number(loadGuestData().watchCdpTimeoutMs);
    return Number.isFinite(v) && v >= 3000 && v <= 120000 ? v : 25000;
}
function setWatchCdpTimeoutMs(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 3000 || n > 120000) return false;
    const d = loadGuestData();
    d.watchCdpTimeoutMs = n;
    saveGuestData(d);
    return true;
}
// Capture proxy resolution. Valid: 480p | 720p | 1080p. Stored as the
// preset string; resolution() resolves to {width,height}.
const WATCH_CAPTURE_PRESETS = { '480p': { width: 854, height: 480 }, '720p': { width: 1280, height: 720 }, '1080p': { width: 1920, height: 1080 } };
function getWatchCaptureResolution() {
    const v = loadGuestData().watchCaptureResolution;
    return WATCH_CAPTURE_PRESETS[v] ? v : '720p';
}
function setWatchCaptureResolution(v) {
    if (!WATCH_CAPTURE_PRESETS[v]) return false;
    const d = loadGuestData();
    d.watchCaptureResolution = v;
    saveGuestData(d);
    return true;
}
// Capture proxy framerate. Valid: 24 | 30 | 60.
function getWatchCaptureFramerate() {
    const v = Number(loadGuestData().watchCaptureFramerate);
    return [24, 30, 60].includes(v) ? v : 30;
}
function setWatchCaptureFramerate(v) {
    const n = Number(v);
    if (![24, 30, 60].includes(n)) return false;
    const d = loadGuestData();
    d.watchCaptureFramerate = n;
    saveGuestData(d);
    return true;
}
// Idle TTL for /watch and /movienight rooms. Hours; default 6.
function getWatchRoomTtlHours() {
    const v = Number(loadGuestData().watchRoomTtlHours);
    return Number.isFinite(v) && v >= 1 && v <= 168 ? v : 6;
}
function setWatchRoomTtlHours(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n > 168) return false;
    const d = loadGuestData();
    d.watchRoomTtlHours = n;
    saveGuestData(d);
    return true;
}

// CDP-based stream sniffer: spawns headless Chromium, navigates to the URL,
// listens for Network.requestWillBeSent events, returns the first HLS/MP4
// URL the page fetches. Useful for sources like weflix → vidsrcme →
// cloudnestra where yt-dlp has no extractor but the underlying stream is
// loaded via plain HTTP from a JS player.
function resolveViaCdpSniffer(targetUrl, timeoutMs = 25000) {
    return new Promise((resolve) => {
        const profileDir = `/tmp/cdp-sniff-${crypto.randomBytes(4).toString('hex')}`;
        try { fs.mkdirSync(profileDir, { recursive: true }); } catch {}
        let chromium;
        try {
            chromium = spawn('/usr/bin/chromium', [
                '--headless=new',
                '--no-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--remote-debugging-port=0',
                `--user-data-dir=${profileDir}`,
                '--autoplay-policy=no-user-gesture-required',
                '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                targetUrl,
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) { resolve(null); return; }
        let ws = null;
        let resolved = false;
        const seen = new Set();
        const timer = setTimeout(() => done(null), timeoutMs);
        function done(result) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try { if (ws) ws.close(); } catch {}
            try { chromium.kill('SIGKILL'); } catch {}
            setTimeout(() => { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {} }, 1000);
            if (result) console.log('[cdp-sniff]', targetUrl, '->', result);
            else console.warn('[cdp-sniff]', targetUrl, '-> no stream URL found in', timeoutMs, 'ms');
            resolve(result);
        }
        chromium.on('error', (err) => { console.warn('[cdp-sniff] chromium spawn error:', err.message); done(null); });
        chromium.on('exit', () => { if (!resolved) setTimeout(() => done(null), 500); });
        let bufferedStderr = '';
        chromium.stderr.on('data', (d) => {
            bufferedStderr += d.toString();
            if (ws) return;
            const m = bufferedStderr.match(/DevTools listening on ws:\/\/(\S+)/);
            if (m) {
                const wsUrl = 'ws://' + m[1];
                attachToPage(wsUrl);
            }
        });
        async function attachToPage(initialWsUrl) {
            // The startup ws-url is the browser target; we need a page target,
            // which appears once Chromium has loaded the URL we passed on the
            // command line. Poll /json briefly.
            try {
                const u = new URL(initialWsUrl);
                const httpUrl = `http://${u.host}/json`;
                let attempts = 0;
                const find = async () => {
                    if (resolved) return;
                    if (attempts++ > 25) { done(null); return; }
                    try {
                        const r = await fetch(httpUrl);
                        const targets = await r.json();
                        const page = targets.find(t => t.type === 'page');
                        if (page && page.webSocketDebuggerUrl) attach(page.webSocketDebuggerUrl);
                        else setTimeout(find, 200);
                    } catch { setTimeout(find, 200); }
                };
                find();
            } catch { done(null); }
        }
        function attach(pageWsUrl) {
            const W = require('ws');
            try { ws = new W(pageWsUrl); } catch { done(null); return; }
            let msgId = 0;
            ws.on('open', () => {
                try { ws.send(JSON.stringify({ id: ++msgId, method: 'Network.enable' })); } catch {}
            });
            ws.on('message', (data) => {
                if (resolved) return;
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.method === 'Network.requestWillBeSent') {
                        const u = msg.params?.request?.url || '';
                        if (!u || seen.has(u)) return;
                        seen.add(u);
                        // HLS playlists are the strongest signal; .mpd is DASH
                        // (which our HTML5 path doesn't handle); .mp4/.webm
                        // direct files are great but watch out for ad files.
                        if (/\.(m3u8)(\?|$)/i.test(u)) return done(u);
                        if (/\.(mp4|webm)(\?|$)/i.test(u) && !/\/(?:thumbnail|preview|sprite|ads?\/|track\/)/i.test(u) && msg.params?.type !== 'XHR') {
                            // Only accept .mp4 if it's a media-typed request.
                            const resType = String(msg.params?.type || '').toLowerCase();
                            if (resType === 'media' || resType === 'video') return done(u);
                        }
                    }
                } catch {}
            });
            ws.on('error', () => {});
            ws.on('close', () => { if (!resolved) setTimeout(() => done(null), 300); });
        }
    });
}

// Centralised "resolve a watch URL → playable source" — honors the configured
// strategy and falls back through the chain on 'auto'.
async function resolveWatchSource(url, forceStrategy) {
    const strategy = forceStrategy || getWatchStrategy();
    const detect = _watchDetectSource(url);
    if (detect.sourceType === 'invalid' || detect.sourceType === 'drm-blocked') return { ...detect };
    let sourceType = detect.sourceType;
    let sourceMeta = detect.sourceMeta || {};
    if (strategy === 'iframe') return { sourceType, sourceMeta };
    // YouTube / Vimeo / Twitch already have great in-browser player APIs
    // with full programmatic sync. yt-dlp's resolved CDN URLs come with
    // signed query params tied to the server's IP/UA, so the *browser*
    // often can't play them — defeating the whole point. In 'auto' mode
    // we therefore PREFER the iframe path for these. Users can still
    // explicitly pick the 'ytdlp' strategy if iframe gets walled.
    const IFRAME_API_SOURCES = new Set(['youtube', 'vimeo', 'twitch']);
    if (strategy === 'auto' && IFRAME_API_SOURCES.has(sourceType)) {
        return { sourceType, sourceMeta };
    }
    if (strategy === 'auto' || strategy === 'ytdlp') {
        const direct = await resolveDirectVideoUrlViaYtDlp(url);
        if (direct) return { sourceType: 'video', sourceMeta: { url: direct, originalUrl: url, via: 'ytdlp', resolvedAt: Date.now() } };
        if (detect.sourceType === 'iframe') {
            const unwrapped = await unwrapAggregatorEmbed(url);
            if (unwrapped) {
                const inner = await resolveDirectVideoUrlViaYtDlp(unwrapped);
                if (inner) return { sourceType: 'video', sourceMeta: { url: inner, originalUrl: url, via: 'ytdlp-unwrap', resolvedAt: Date.now() } };
                sourceMeta = { url: unwrapped, originalUrl: url };
            }
        }
        if (strategy === 'ytdlp') return { sourceType, sourceMeta };
    }
    if (strategy === 'auto' || strategy === 'cdp') {
        const cdpUrl = await resolveViaCdpSniffer(sourceMeta.url || url, getWatchCdpTimeoutMs());
        if (cdpUrl) return { sourceType: 'video', sourceMeta: { url: cdpUrl, originalUrl: url, via: 'cdp', resolvedAt: Date.now() } };
        if (strategy === 'cdp') return { sourceType, sourceMeta };
    }
    if (strategy === 'auto' || strategy === 'capture') {
        const cap = await startCaptureProxyForUrl(url).catch(() => null);
        if (cap) return { sourceType: 'video', sourceMeta: { url: cap.streamUrl, originalUrl: url, via: 'capture', captureId: cap.captureId, resolvedAt: Date.now() } };
    }
    return { sourceType, sourceMeta };
}

// Screen-capture proxy — renders the URL in a virtual Chromium under Xvfb
// and re-encodes the rendered pixels as HLS for all viewers. Required for
// DRM-protected / iframe-locked sources the CDP sniffer can't crack
// (browsers can play the page, so we play it once on the server and let
// every viewer pull the same HLS). Video-only for v1; audio mux ships in a
// follow-up once pulseaudio plumbing is in place.
const CAPTURES_DIR = path.join(DATA_DIR, 'captures');
try { fs.mkdirSync(CAPTURES_DIR, { recursive: true }); } catch {}
const captureProxies = new Map();
let _nextCaptureDisplay = 100;
function _pickFreeXDisplay() {
    for (let i = 0; i < 50; i++) {
        const n = _nextCaptureDisplay++;
        if (_nextCaptureDisplay > 199) _nextCaptureDisplay = 100;
        try { fs.accessSync(`/tmp/.X${n}-lock`); continue; } catch { return n; }
    }
    return null;
}
function stopCaptureProxy(captureId) {
    const cap = captureProxies.get(captureId);
    if (!cap) return false;
    captureProxies.delete(captureId);
    for (const p of [cap.ffmpeg, cap.chromium, cap.pulseaudio, cap.xvfb]) {
        try { if (p && !p.killed) p.kill('SIGKILL'); } catch {}
    }
    setTimeout(() => { try { fs.rmSync(cap.dir, { recursive: true, force: true }); } catch {} }, 2000);
    if (cap.pulseRuntime) setTimeout(() => { try { fs.rmSync(cap.pulseRuntime, { recursive: true, force: true }); } catch {} }, 2000);
    console.log('[capture] stopped', captureId);
    return true;
}
async function startCaptureProxyForUrl(url) {
    // Bail fast if Xvfb isn't installed — let the caller fall back.
    try {
        await new Promise((resolve, reject) => {
            const p = spawn('which', ['Xvfb'], { stdio: 'ignore' });
            p.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Xvfb missing')));
            p.on('error', reject);
        });
    } catch (e) {
        console.warn('[capture] Xvfb not available — skipping');
        return null;
    }
    const display = _pickFreeXDisplay();
    if (display == null) { console.warn('[capture] no free X display'); return null; }
    const captureId = 'cap_' + crypto.randomBytes(4).toString('hex');
    const dir = path.join(CAPTURES_DIR, captureId);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const preset = WATCH_CAPTURE_PRESETS[getWatchCaptureResolution()] || WATCH_CAPTURE_PRESETS['720p'];
    const { width, height } = preset;
    const framerate = getWatchCaptureFramerate();
    // PulseAudio is optional — when present, we spawn a per-capture daemon
    // backed by a null-sink so Chromium's audio is routed somewhere ffmpeg
    // can grab it. When missing we fall through to video-only.
    let pulseaudio = null;
    let pulseRuntime = null;
    let pulseSinkName = null;
    let pulseAvailable = false;
    try {
        await new Promise((resolve, reject) => {
            const p = spawn('which', ['pulseaudio'], { stdio: 'ignore' });
            p.on('exit', (code) => code === 0 ? resolve() : reject());
            p.on('error', reject);
        });
        pulseAvailable = true;
    } catch { /* no pulseaudio — capture stays video-only */ }
    let xvfb, chromium, ffmpeg;
    try {
        xvfb = spawn('Xvfb', [`:${display}`, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-ac', '+extension', 'RANDR'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { console.warn('[capture] Xvfb spawn failed:', e.message); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} return null; }
    await new Promise((r) => setTimeout(r, 600)); // let Xvfb come up
    // Spawn an isolated pulseaudio daemon for this capture so Chromium can
    // output audio into a null-sink whose monitor ffmpeg pulls from. Each
    // capture gets its own PULSE_RUNTIME_PATH so multiple proxies don't
    // collide. If pulseaudio fails for any reason we fall back to video-only.
    if (pulseAvailable) {
        try {
            pulseRuntime = `/tmp/pulse-${captureId}`;
            pulseSinkName = `cap_${captureId.slice(4)}_sink`;
            fs.mkdirSync(pulseRuntime, { recursive: true, mode: 0o700 });
            const pulseEnv = { ...process.env, PULSE_RUNTIME_PATH: pulseRuntime, HOME: dir, XDG_RUNTIME_DIR: pulseRuntime };
            pulseaudio = spawn('pulseaudio', [
                '-n',                   // ignore default config
                '--exit-idle-time=-1',  // never auto-exit
                '--disallow-exit',
                '--disallow-module-loading=no',
                '--log-target=stderr',
                '--log-level=error',
                '-L', `module-native-protocol-unix socket=${pulseRuntime}/native`,
                '-L', `module-null-sink sink_name=${pulseSinkName} sink_properties=device.description=CaptureSink`,
                '-L', `set-default-sink ${pulseSinkName}`,
            ], { stdio: ['ignore', 'ignore', 'pipe'], env: pulseEnv });
            pulseaudio.stderr?.on('data', (d) => {
                const s = d.toString().trim();
                if (s) console.warn('[capture]', captureId, 'pulse:', s.slice(0, 200));
            });
            pulseaudio.on('exit', (code) => { if (code !== 0 && code !== null) console.warn('[capture]', captureId, 'pulseaudio exit', code); });
            await new Promise((r) => setTimeout(r, 700)); // socket ready
        } catch (e) {
            console.warn('[capture] pulseaudio spawn failed; degrading to video-only:', e.message);
            try { if (pulseaudio) pulseaudio.kill('SIGKILL'); } catch {}
            try { if (pulseRuntime) fs.rmSync(pulseRuntime, { recursive: true, force: true }); } catch {}
            pulseaudio = null;
            pulseRuntime = null;
            pulseSinkName = null;
        }
    }
    try {
        const profileDir = path.join(dir, 'chrome-profile');
        fs.mkdirSync(profileDir, { recursive: true });
        const chromeEnv = { ...process.env, DISPLAY: `:${display}` };
        if (pulseRuntime) {
            chromeEnv.PULSE_RUNTIME_PATH = pulseRuntime;
            chromeEnv.PULSE_SERVER = `unix:${pulseRuntime}/native`;
            chromeEnv.XDG_RUNTIME_DIR = pulseRuntime;
        }
        chromium = spawn('/usr/bin/chromium', [
            '--no-sandbox',
            '--kiosk',
            '--noerrdialogs',
            '--disable-infobars',
            '--disable-translate',
            '--disable-features=Translate',
            '--autoplay-policy=no-user-gesture-required',
            `--window-size=${width},${height}`,
            `--user-data-dir=${profileDir}`,
            '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            url,
        ], { stdio: 'ignore', env: chromeEnv });
    } catch (e) {
        console.warn('[capture] chromium spawn failed:', e.message);
        try { xvfb.kill('SIGKILL'); } catch {}
        try { if (pulseaudio) pulseaudio.kill('SIGKILL'); } catch {}
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        if (pulseRuntime) { try { fs.rmSync(pulseRuntime, { recursive: true, force: true }); } catch {} }
        return null;
    }
    await new Promise((r) => setTimeout(r, 2500)); // let chromium reach the page
    const playlistPath = path.join(dir, 'index.m3u8');
    const segPattern = path.join(dir, 'seg_%05d.ts');
    try {
        const args = [
            '-loglevel', 'warning',
            '-f', 'x11grab',
            '-draw_mouse', '0',
            '-framerate', String(framerate),
            '-video_size', `${width}x${height}`,
            '-i', `:${display}.0`,
        ];
        if (pulseRuntime && pulseSinkName) {
            args.push('-thread_queue_size', '512');
            args.push('-f', 'pulse');
            args.push('-i', `${pulseSinkName}.monitor`);
        }
        args.push(
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-tune', 'zerolatency',
            '-profile:v', 'baseline',
            '-level', '3.0',
            '-g', String(framerate * 2),
            '-sc_threshold', '0',
            '-pix_fmt', 'yuv420p',
        );
        if (pulseRuntime && pulseSinkName) {
            args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2');
        }
        args.push(
            '-f', 'hls',
            '-hls_time', '2',
            '-hls_list_size', '6',
            '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
            '-hls_segment_filename', segPattern,
            playlistPath,
        );
        const ffmpegEnv = { ...process.env };
        if (pulseRuntime) {
            ffmpegEnv.PULSE_RUNTIME_PATH = pulseRuntime;
            ffmpegEnv.PULSE_SERVER = `unix:${pulseRuntime}/native`;
            ffmpegEnv.XDG_RUNTIME_DIR = pulseRuntime;
        }
        ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], env: ffmpegEnv });
    } catch (e) {
        console.warn('[capture] ffmpeg spawn failed:', e.message);
        try { chromium.kill('SIGKILL'); } catch {}
        try { if (pulseaudio) pulseaudio.kill('SIGKILL'); } catch {}
        try { xvfb.kill('SIGKILL'); } catch {}
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        if (pulseRuntime) { try { fs.rmSync(pulseRuntime, { recursive: true, force: true }); } catch {} }
        return null;
    }
    ffmpeg.stderr?.on('data', (d) => {
        const s = d.toString();
        if (/error|fail|cannot/i.test(s)) console.warn('[capture]', captureId, s.trim().slice(0, 300));
    });
    ffmpeg.on('exit', (code) => { console.log('[capture]', captureId, 'ffmpeg exit', code); });
    // Wait for the playlist file to appear so the viewer doesn't 404 on join.
    for (let i = 0; i < 30; i++) {
        try { fs.accessSync(playlistPath); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
        if (i === 29) {
            console.warn('[capture]', captureId, 'playlist never materialized — aborting');
            try { ffmpeg.kill('SIGKILL'); chromium.kill('SIGKILL'); xvfb.kill('SIGKILL'); if (pulseaudio) pulseaudio.kill('SIGKILL'); } catch {}
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
            if (pulseRuntime) { try { fs.rmSync(pulseRuntime, { recursive: true, force: true }); } catch {} }
            return null;
        }
    }
    captureProxies.set(captureId, { url, dir, display, xvfb, chromium, ffmpeg, pulseaudio, pulseRuntime, pulseSinkName, audio: !!pulseaudio, startedAt: Date.now() });
    console.log('[capture] started', captureId, 'for', url, 'audio:', !!pulseaudio);
    return { captureId, streamUrl: `/captures/${captureId}/index.m3u8` };
}

function getWatchPartyEnabled(role, username) {
    const ov = getUserOverride(username, 'watchPartyEnabled');
    if (typeof ov === 'boolean') return ov;
    const d = loadGuestData();
    const defaults = { guest: false, user: true, admin: true, superadmin: true };
    const key = 'watchPartyEnabled_' + role;
    return typeof d[key] === 'boolean' ? d[key] : !!defaults[role];
}
function setWatchPartyEnabled(role, v) {
    const d = loadGuestData();
    d['watchPartyEnabled_' + role] = v === true;
    saveGuestData(d);
}

// ---------------------------------------------------------------------------
// Movie Night — pre-watch rooms with candidate list + vote-to-pick.
// Once a winner is decided, the room's selected candidate becomes a regular
// Watch Together room (same player path, same WS sync) and viewers are
// redirected to /watch/<id>.
// ---------------------------------------------------------------------------
const MOVIENIGHT_TTL_MS = 6 * 60 * 60 * 1000;
const MOVIENIGHT_MAX_CANDIDATES = 12;
const MOVIENIGHT_VOTE_WINDOW_MS = 30_000;
const movieNightRooms = new Map();

function makeMovieNightRoomId() { return 'mn_' + crypto.randomBytes(4).toString('hex'); }

function _mnBroadcast(room, payload) {
    const json = JSON.stringify(payload);
    for (const ws of room.viewers) {
        if (ws.readyState === 1) { try { ws.send(json); } catch {} }
    }
}

function _mnRoomPublic(room) {
    return {
        id: room.id,
        hostUsername: room.hostUsername,
        hostRole: room.hostRole,
        createdAt: room.createdAt,
        candidates: room.candidates,
        viewerCount: room.viewers.size,
        phase: room.phase,
        vote: room.vote ? { endsAt: room.vote.endsAt, tallies: _mnTallies(room) } : null,
        winnerIdx: room.winnerIdx,
        winnerWatchRoomId: room.winnerWatchRoomId,
    };
}

function _mnTallies(room) {
    if (!room.vote) return null;
    const t = new Array(room.candidates.length).fill(0);
    for (const idx of room.vote.byUser.values()) {
        if (Number.isInteger(idx) && idx >= 0 && idx < t.length) t[idx]++;
    }
    return t;
}

// Best-effort title/poster scrape via Open Graph meta tags. Falls back to
// the URL's pathname if no og:title. Skipped for known DRM hosts.
async function scrapeOgMeta(url) {
    try {
        // SSRF guard: resolve + reject private/loopback targets before fetching
        // (this reflects og:title/description back to the user).
        if (!(await _assertPublicUrl(url))) return null;
        const res = await fetch(url, {
            headers: {
                'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml',
            },
        });
        if (!res.ok) return null;
        const html = await res.text();
        const pick = (re) => { const m = html.match(re); return m ? m[1].trim() : null; };
        return {
            title: pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                || pick(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i)
                || pick(/<title>([^<]+)<\/title>/i),
            poster: pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                || pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i),
            description: pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i),
        };
    } catch { return null; }
}

function getMovieNightEnabled(role, username) {
    // Movie Night gates on the same permission as Watch Together — picking a
    // movie that you can't actually play would be silly.
    return getWatchPartyEnabled(role, username);
}

function _mnFinalize(room) {
    if (room.phase === 'decided') return;
    let winnerIdx;
    if (room.phase === 'voting' && room.vote) {
        if (room.vote.timer) { clearTimeout(room.vote.timer); room.vote.timer = null; }
        const tallies = _mnTallies(room);
        let maxVotes = -1;
        tallies.forEach((v) => { if (v > maxVotes) maxVotes = v; });
        const tied = tallies.map((v, i) => v === maxVotes ? i : -1).filter(i => i >= 0);
        winnerIdx = tied[Math.floor(Math.random() * tied.length)];
    } else if (room.phase === 'spinning' && room.winnerIdx != null) {
        // Wheel mode: winner was picked at spin-start time.
        winnerIdx = room.winnerIdx;
    } else {
        return;
    }
    room.winnerIdx = winnerIdx;
    room.phase = 'decided';
    // Create the corresponding watch room.
    const winner = room.candidates[winnerIdx];
    (async () => {
        const resolved = await resolveWatchSource(winner.url);
        if (resolved.sourceType === 'invalid' || resolved.sourceType === 'drm-blocked') {
            throw new Error(resolved.error || 'Could not resolve the winning URL.');
        }
        const watchId = makeWatchRoomId();
        const now = Date.now();
        watchRooms.set(watchId, {
            id: watchId, url: winner.url,
            sourceType: resolved.sourceType,
            sourceMeta: resolved.sourceMeta || {},
            hostUsername: room.hostUsername, hostRole: room.hostRole,
            createdAt: now, lastActivity: now,
            state: { playing: false, position: 0, positionAt: now },
            viewers: new Set(),
        });
        room.winnerWatchRoomId = watchId;
        console.log(`[movienight] room ${room.id} decided: ${winner.title || winner.url} -> /watch/${watchId}`);
        _mnBroadcast(room, { type: 'decided', winnerIdx, watchRoomId: watchId, room: _mnRoomPublic(room) });
    })().catch(err => {
        console.error('[movienight] finalize failed:', err.message);
        _mnBroadcast(room, { type: 'error', error: 'Failed to create the winning room: ' + err.message });
    });
}

function _mnSweep() {
    const now = Date.now();
    const ttlMs = getWatchRoomTtlHours() * 60 * 60 * 1000;
    for (const [id, room] of movieNightRooms) {
        if (now - room.lastActivity > ttlMs && room.viewers.size === 0) {
            movieNightRooms.delete(id);
        }
    }
}
setInterval(_mnSweep, 30 * 60 * 1000).unref?.();

// Shared capture path used by both /clip (Discord slash) and the web UI's
// Clip button. Returns { ok, meta?, error? } — callers translate to their
// own reply/response shape.
async function captureClip(seconds, byContext) {
    if (!activeGuildId || !currentConnection) {
        return { ok: false, code: 'no-channel', error: "Bot isn't in a voice channel." };
    }
    if (clipBuffers.size === 0) {
        return { ok: false, code: 'no-audio', error: 'No voice audio has been captured yet — someone has to be talking first.' };
    }
    const sec = Math.max(CLIP_MIN_REQUEST_SEC, Math.min(CLIP_MAX_REQUEST_SEC, Number(seconds) || CLIP_DEFAULT_REQUEST_SEC));
    try {
        const pcm = mixClipToPcm(sec);
        const mp3 = await encodeClipPcmToMp3(pcm);
        const id = 'clip_' + crypto.randomBytes(6).toString('hex');
        const filename = id + '.mp3';
        fs.writeFileSync(path.join(CLIPS_DIR, filename), mp3);
        const meta = {
            id,
            filename,
            createdAt: Date.now(),
            durationSec: sec,
            byUserId: String(byContext?.userId || ''),
            byUserTag: byContext?.userTag || null,
            channelId: lastChannelId,
            guildId: byContext?.guildId || null,
            source: byContext?.source || 'unknown',
            savedToSoundboard: null,
        };
        const arr = loadClipsIndex();
        arr.unshift(meta);
        while (arr.length > CLIP_RETAIN_COUNT) {
            const dropped = arr.pop();
            try { fs.unlinkSync(path.join(CLIPS_DIR, dropped.filename)); } catch {}
        }
        saveClipsIndex(arr);
        console.log(`[clip] saved ${id} (${sec}s) for ${meta.byUserTag || meta.byUserId || 'anon'} via ${meta.source}`);
        return { ok: true, meta };
    } catch (err) {
        console.error('[clip] capture failed:', err);
        return { ok: false, code: 'encode-failed', error: err.message || 'unknown error' };
    }
}

// Resolve a Discord interaction.user to a soundboard role + username, the
// same way /play does — used to enforce per-role + per-user permissions on
// slash commands. Returns { username, role, fallbackTag, disabledReason }.
function resolveDiscordCaller(interaction) {
    const fallbackTag = interaction.user?.tag || interaction.user?.username || 'discord-user';
    let username = `discord:${fallbackTag}`;
    let role = 'user';
    if (getDiscordLinkGlobalEnabled()) {
        const linkedUn = findUsernameByDiscordId(interaction.user?.id);
        if (linkedUn) {
            const link = getDiscordLinkForUser(linkedUn);
            if (link && link.disabled === true) return { username, role, fallbackTag, disabledReason: 'link-disabled' };
            const entry = USERS.get(linkedUn.toLowerCase());
            if (entry && entry.disabled === true) return { username, role, fallbackTag, disabledReason: 'account-disabled' };
            if (entry && entry.role) {
                username = linkedUn;
                role = entry.role;
            }
        }
    }
    return { username, role, fallbackTag };
}

async function handleClipCommand(interaction) {
    const caller = resolveDiscordCaller(interaction);
    if (caller.disabledReason) {
        return interaction.reply({
            content: caller.disabledReason === 'link-disabled' ? 'Your linked account is disabled.' : 'Your linked soundboard account is disabled.',
            flags: MessageFlags.Ephemeral,
        });
    }
    if (!getClipEnabled(caller.role, caller.username)) {
        return interaction.reply({ content: "You don't have permission to use `/clip`. Ask a superadmin.", flags: MessageFlags.Ephemeral });
    }
    const requested = interaction.options.getInteger('seconds') ?? CLIP_DEFAULT_REQUEST_SEC;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await captureClip(requested, {
        userId: caller.username,
        userTag: caller.fallbackTag,
        guildId: interaction.guildId,
        source: 'slash',
    });
    if (!result.ok) {
        const hint = result.code === 'no-channel' ? ' Use `/rejoin` first.' : '';
        return interaction.editReply({ content: result.error + hint });
    }
    return interaction.editReply({ content: `Saved the last **${result.meta.durationSec}s** as \`${result.meta.id}\`. Open the soundboard → **Clip** button (or ☰ → **Clips**) to preview, trim, and save it as a sound.` });
}

// /play <sound>
// Looks up a sound by exact display-name match, exact filename match, then
// case-insensitive substring on either. Falls back to a friendly "not found"
// reply. Plays through whatever voice channel the bot is currently in.
//
// Permission model: when the invoking Discord user is linked to a soundboard
// account (and the global Discord-link toggle is on), /play inherits that
// account's role + per-user override values. Otherwise the invocation runs
// as a plain `user` and obeys the user-tier cooldown / max-duration /
// admin-only / superadmin-only / playback-locked gates the web UI uses.
async function handlePlayCommand(interaction) {
    if (!activeGuildId || !currentConnection) {
        return interaction.reply({ content: "I'm not in a voice channel right now. Use `/rejoin` first.", flags: MessageFlags.Ephemeral });
    }
    const raw = String(interaction.options.getString('sound') || '').trim();
    if (!raw) return interaction.reply({ content: 'Pick a sound name.', flags: MessageFlags.Ephemeral });

    // Resolve Discord user -> soundboard account if linked.
    const fallbackTag = interaction.user?.tag || interaction.user?.username || 'discord-user';
    let username = `discord:${fallbackTag}`;
    let role = 'user';
    let linkedVia = 'fallback';
    if (getDiscordLinkGlobalEnabled()) {
        const linkedUn = findUsernameByDiscordId(interaction.user?.id);
        if (linkedUn) {
            const link = getDiscordLinkForUser(linkedUn);
            if (link && link.disabled === true) {
                return interaction.reply({ content: 'Your linked account is disabled for soundboard playback.', flags: MessageFlags.Ephemeral });
            }
            const entry = USERS.get(linkedUn.toLowerCase());
            if (entry && entry.disabled === true) {
                return interaction.reply({ content: 'Your linked soundboard account is disabled.', flags: MessageFlags.Ephemeral });
            }
            if (entry && entry.role) {
                username = linkedUn;
                role = entry.role;
                linkedVia = 'linked';
            }
        }
    }

    // Resolve the sound from the meta index.
    const meta = loadSoundsMeta();
    const files = Object.keys(meta);
    const q = raw.toLowerCase();
    const nameOf = (f) => String((meta[f] && meta[f].displayName) || f).toLowerCase();
    let match =
        files.find(f => f.toLowerCase() === q || nameOf(f) === q) ||
        files.find(f => f.toLowerCase().startsWith(q) || nameOf(f).startsWith(q)) ||
        files.find(f => f.toLowerCase().includes(q) || nameOf(f).includes(q));
    if (!match) return interaction.reply({ content: `No sound matching \`${raw}\`.`, flags: MessageFlags.Ephemeral });
    const displayName = (meta[match] && meta[match].displayName) || match;

    // Per-user cooldown + max-duration (only enforced on plain users; admin
    // and superadmin bypass these the same way they do on the web UI).
    if (role === 'user') {
        const cooldownSec = getUserCooldownSec(username);
        const lastPlay = userLastPlayByUsername.get(username);
        if (lastPlay != null && cooldownSec > 0) {
            const elapsed = (Date.now() - lastPlay) / 1000;
            if (elapsed < cooldownSec) {
                return interaction.reply({ content: `Wait ${Math.ceil(cooldownSec - elapsed)}s before playing again.`, flags: MessageFlags.Ephemeral });
            }
        }
        let dur = getDuration(meta, match);
        if (dur == null) {
            try { dur = await probeDurationAsync(path.join(SOUNDS_DIR, match)); } catch {}
            if (dur != null) setSoundMeta(match, { duration: dur });
        }
        const metaStart = getSoundStartTime(meta, match);
        const metaEnd = getSoundEndTime(meta, match);
        let effectiveDur = dur;
        if (dur != null && (metaStart != null || metaEnd != null)) {
            const s = metaStart != null ? metaStart : 0;
            const e = metaEnd != null && metaEnd <= dur ? metaEnd : dur;
            effectiveDur = Math.max(0, e - s);
        }
        const maxDur = getUserMaxDuration(username);
        if (effectiveDur != null && effectiveDur > maxDur) {
            return interaction.reply({ content: `Only sounds ${maxDur}s or shorter are allowed. This one is ${Math.ceil(effectiveDur)}s.`, flags: MessageFlags.Ephemeral });
        }
    }

    // Hand off to the shared play path. playSoundAsLinkedUser also enforces
    // superadmin-only / admin-only locks + the single/multi-play role
    // hierarchy, so /play is fully aligned with /api/play's gating.
    const result = await playSoundAsLinkedUser(match, { username, role });
    if (result && result.ok) {
        if (role === 'user') userLastPlayByUsername.set(username, Date.now());
        console.log(`[slash] /play by ${fallbackTag} (${linkedVia}=${username}, role=${role}) -> ${match}`);
        return interaction.reply({ content: `Playing **${displayName}**.`, flags: MessageFlags.Ephemeral });
    }
    // Friendlier wording for the failure reasons playSoundAsLinkedUser emits.
    const friendly = {
        'no-voice': "I'm not in a voice channel.",
        'missing-file': 'That sound file is missing on disk.',
        'invalid-path': 'Invalid sound path.',
        'superadmin-only': 'Only superadmin can play right now.',
        'locked': 'Playback is locked.',
        'lower-role': "A higher-role user is currently playing — you can't override them right now.",
        'voice-not-ready': "Voice connection isn't ready yet — try again in a moment.",
    };
    const reason = (result && result.reason) || 'unknown';
    return interaction.reply({ content: `Can't play: ${friendly[reason] || reason}`, flags: MessageFlags.Ephemeral });
}

async function handleWatchCommand(interaction) {
    const caller = resolveDiscordCaller(interaction);
    if (caller.disabledReason) {
        return interaction.reply({ content: caller.disabledReason === 'link-disabled' ? 'Your linked account is disabled.' : 'Your linked soundboard account is disabled.', flags: MessageFlags.Ephemeral });
    }
    if (!getWatchPartyEnabled(caller.role, caller.username)) {
        return interaction.reply({ content: "You don't have permission to use `/watch`.", flags: MessageFlags.Ephemeral });
    }
    const url = String(interaction.options.getString('url') || '').trim();
    const wantPublic = interaction.options.getBoolean('public') === true;
    await interaction.deferReply({ flags: wantPublic ? 0 : MessageFlags.Ephemeral });
    const resolved = await resolveWatchSource(url);
    if (resolved.sourceType === 'invalid' || resolved.sourceType === 'drm-blocked') {
        return interaction.editReply({ content: resolved.error || 'Could not start a watch room.' });
    }
    const id = makeWatchRoomId();
    const now = Date.now();
    const room = {
        id, url,
        sourceType: resolved.sourceType,
        sourceMeta: resolved.sourceMeta || {},
        hostUsername: caller.username,
        hostRole: caller.role,
        createdAt: now, lastActivity: now,
        state: { playing: false, position: 0, positionAt: now },
        viewers: new Set(),
    };
    watchRooms.set(id, room);
    const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') || 'https://soundboard.mannerow.net';
    const joinUrl = `${publicBase}/watch/${id}`;
    console.log(`[watch] room ${id} created via /watch by ${caller.fallbackTag} (${room.sourceType}, public=${wantPublic})`);
    if (wantPublic) {
        return interaction.editReply({ content: `🎬 **Watch Together** — ${caller.fallbackTag} started a ${room.sourceType.toUpperCase()} party. Join: ${joinUrl}` });
    }
    // Ephemeral reply with a "Post to channel" button so the host can
    // promote it to a public message after the fact without re-running.
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`watch:post:${id}`)
            .setLabel('📢 Post to channel')
            .setStyle(ButtonStyle.Primary),
    );
    return interaction.editReply({
        content: `🎬 **Watch Together** — ${room.sourceType.toUpperCase()} room ready. Open ${joinUrl} to join. The host (you) controls play / pause / seek.`,
        components: [row],
    });
}

async function handleWatchPostButton(interaction, roomId) {
    if (!WATCH_ID_RE.test(String(roomId || ''))) return interaction.reply({ content: 'Invalid room.', flags: MessageFlags.Ephemeral });
    const room = watchRooms.get(roomId);
    if (!room) return interaction.reply({ content: 'Room expired.', flags: MessageFlags.Ephemeral });
    // Only the original host (or a superadmin) can post the link publicly.
    const caller = resolveDiscordCaller(interaction);
    if (caller.username !== room.hostUsername && caller.role !== 'superadmin') {
        return interaction.reply({ content: 'Only the room host can post the link to the channel.', flags: MessageFlags.Ephemeral });
    }
    const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') || 'https://soundboard.mannerow.net';
    const joinUrl = `${publicBase}/watch/${roomId}`;
    // Send a fresh non-ephemeral message in the same channel + disable the
    // original ephemeral button so the host can't double-post.
    try {
        await interaction.update({ components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('watch:posted').setLabel('✓ Posted').setStyle(ButtonStyle.Success).setDisabled(true),
        )] });
        await interaction.followUp({
            content: `🎬 **Watch Together** — ${caller.fallbackTag} started a ${room.sourceType.toUpperCase()} party. Join: ${joinUrl}`,
        });
    } catch (err) {
        console.error('[watch] post-to-channel failed:', err.message);
    }
}

async function handleMovieNightCommand(interaction) {
    const caller = resolveDiscordCaller(interaction);
    if (caller.disabledReason) {
        return interaction.reply({ content: caller.disabledReason === 'link-disabled' ? 'Your linked account is disabled.' : 'Your linked soundboard account is disabled.', flags: MessageFlags.Ephemeral });
    }
    if (!getMovieNightEnabled(caller.role, caller.username)) {
        return interaction.reply({ content: "You don't have permission to use `/movienight`.", flags: MessageFlags.Ephemeral });
    }
    const id = makeMovieNightRoomId();
    const now = Date.now();
    movieNightRooms.set(id, {
        id, hostUsername: caller.username, hostRole: caller.role,
        createdAt: now, lastActivity: now,
        candidates: [],
        phase: 'gathering',
        vote: null,
        winnerIdx: null,
        winnerWatchRoomId: null,
        viewers: new Set(),
    });
    const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') || 'https://soundboard.mannerow.net';
    const joinUrl = `${publicBase}/movienight/${id}`;
    console.log(`[movienight] room ${id} created via /movienight by ${caller.fallbackTag}`);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mn:post:${id}`).setLabel('📢 Post to channel').setStyle(ButtonStyle.Primary),
    );
    return interaction.reply({
        content: `🎬 **Movie Night** — pick the night's feature together. Join ${joinUrl}, paste candidate URLs, then the host starts a 30-second vote and the winner auto-starts in Watch Together.`,
        components: [row],
        flags: MessageFlags.Ephemeral,
    });
}

async function handleMovieNightPostButton(interaction, roomId) {
    if (!MN_ID_RE.test(String(roomId || ''))) return interaction.reply({ content: 'Invalid room.', flags: MessageFlags.Ephemeral });
    const room = movieNightRooms.get(roomId);
    if (!room) return interaction.reply({ content: 'Room expired.', flags: MessageFlags.Ephemeral });
    const caller = resolveDiscordCaller(interaction);
    if (caller.username !== room.hostUsername && caller.role !== 'superadmin') {
        return interaction.reply({ content: 'Only the host can post the link.', flags: MessageFlags.Ephemeral });
    }
    const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') || 'https://soundboard.mannerow.net';
    const joinUrl = `${publicBase}/movienight/${roomId}`;
    try {
        await interaction.update({ components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('mn:posted').setLabel('✓ Posted').setStyle(ButtonStyle.Success).setDisabled(true),
        )] });
        await interaction.followUp({ content: `🎬 **Movie Night** — ${caller.fallbackTag} started a movie pick. Add candidates + vote: ${joinUrl}` });
    } catch (err) {
        console.error('[movienight] post-to-channel failed:', err.message);
    }
}

// ---------------------------------------------------------------------------
// /wheel — Discord-native vote wheel. The slash command opens a modal where
// the caller types a title + one option per line; the server picks a winner,
// renders a spinning-wheel MP4 with @napi-rs/canvas + ffmpeg, and posts the
// video as a Discord attachment so the animation plays inline for everyone.
// ---------------------------------------------------------------------------
const WHEEL_MAX_OPTIONS = 12;
const WHEEL_SPIN_SEC = 5;
const WHEEL_HOLD_SEC = 2;
const WHEEL_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#06b6d4', '#a855f7', '#eab308'];

async function handleWheelCommand(interaction) {
    if (!_wheelCanvas) {
        return interaction.reply({ content: '`/wheel` is unavailable: the canvas renderer failed to load. Check server logs.', flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder().setCustomId('wheel:modal').setTitle('Spin the wheel');
    const titleInput = new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Title (optional)')
        .setPlaceholder('e.g. What\'s for dinner?')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(80)
        .setRequired(false);
    const optsInput = new TextInputBuilder()
        .setCustomId('options')
        .setLabel(`Options (one per line, max ${WHEEL_MAX_OPTIONS})`)
        .setPlaceholder('Pizza\nSushi\nTacos\nThai')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(600)
        .setRequired(true);
    modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(optsInput),
    );
    await interaction.showModal(modal);
}

async function handleWheelModalSubmit(interaction) {
    const title = String(interaction.fields.getTextInputValue('title') || '').trim();
    const raw = String(interaction.fields.getTextInputValue('options') || '');
    const options = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, WHEEL_MAX_OPTIONS);
    if (options.length < 2) {
        return interaction.reply({ content: 'Need at least 2 options (one per line).', flags: MessageFlags.Ephemeral });
    }
    const winnerIdx = Math.floor(Math.random() * options.length);
    // Random landing position within the winning slice (15–85% from the
    // slice start) so the pointer doesn't land dead-center every time and
    // the result reads as genuinely random.
    const sliceFrac = 0.15 + Math.random() * 0.70;
    await interaction.deferReply();
    const tmpPath = path.join(require('os').tmpdir(), `wheel_${crypto.randomBytes(6).toString('hex')}.gif`);
    try {
        await renderWheelGif({ title, options, winnerIdx, sliceFrac, outPath: tmpPath });
        const attach = new AttachmentBuilder(tmpPath, { name: 'wheel.gif' });
        // Don't spoil the winner up front — Discord auto-plays GIFs as soon
        // as they come into view, so everyone watches the spin together.
        // The winner reveal is sent as a follow-up timed to land roughly when
        // the wheel itself lands on the winning slice.
        const spinningLine = title ? `🎡 **${title}** — spinning the wheel…` : '🎡 **Spinning the wheel…**';
        await interaction.editReply({ content: spinningLine, files: [attach] });
        const SPIN_DELAY_MS = WHEEL_SPIN_SEC * 1000 + 400;
        setTimeout(async () => {
            try {
                await interaction.followUp({ content: `🎉 **${options[winnerIdx]}** wins!` });
            } catch (e) {
                console.error('[wheel] winner follow-up failed:', e.message);
            }
        }, SPIN_DELAY_MS);
    } catch (err) {
        console.error('[wheel] render failed:', err);
        try { await interaction.editReply({ content: 'Wheel render failed: ' + (err.message || 'unknown error') }); } catch {}
    } finally {
        setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 30_000);
    }
}

async function renderWheelGif({ title, options, winnerIdx, sliceFrac, outPath }) {
    const { createCanvas, GifEncoder } = _wheelCanvas;
    const W = 720, H = 720;
    const FPS = 15; // GIFs balloon quickly above 15 fps; 15 is the sweet spot
    const FRAME_DELAY_MS = Math.round(1000 / FPS);
    const spinFrames = WHEEL_SPIN_SEC * FPS;
    const holdFrames = WHEEL_HOLD_SEC * FPS;
    const slice = (Math.PI * 2) / options.length;
    // Random offset within the winning slice (15–85% from the slice start);
    // makes the result read as genuinely random instead of dead-center.
    const winnerLanding = winnerIdx * slice + (typeof sliceFrac === 'number' ? sliceFrac : 0.5) * slice;
    const TOTAL_SPINS = 6;
    const finalRotation = TOTAL_SPINS * Math.PI * 2 + (-Math.PI / 2 - winnerLanding);
    // @napi-rs/canvas treats `repeat: 0` as "loop forever" and positive
    // values as "loop N extra times after the first play". Neither is the
    // "play once and freeze" behavior we want. Workaround: set repeat=0 +
    // give the LAST frame a 60-second delay, so the winner banner sits for
    // a full minute before the GIF eventually re-loops (by which time the
    // chat moment is long over).
    const TAIL_DELAY_MS = 60_000;
    const enc = new GifEncoder(W, H, { repeat: 0, quality: 10 });
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const renderFrame = (f) => {
        let rotation, showWinner = false;
        if (f < spinFrames) {
            const t = f / spinFrames;
            const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
            rotation = finalRotation * eased;
        } else {
            rotation = finalRotation;
            showWinner = true;
        }
        _drawWheelFrame(ctx, W, H, options, rotation, title, showWinner ? winnerIdx : null);
        return new Uint8Array(ctx.getImageData(0, 0, W, H).data.buffer);
    };
    // Spin + most of the hold at normal pace
    const animatedFrames = spinFrames + Math.max(1, holdFrames - 1);
    for (let f = 0; f < animatedFrames; f++) {
        enc.addFrame(renderFrame(f), W, H, { delay: FRAME_DELAY_MS });
    }
    // Final winner frame: holds for a minute before any potential re-loop
    enc.addFrame(renderFrame(animatedFrames), W, H, { delay: TAIL_DELAY_MS });
    const buf = enc.finish();
    fs.writeFileSync(outPath, buf);
}

function _drawWheelFrame(ctx, W, H, options, rotation, title, winnerIdx) {
    ctx.fillStyle = '#0e1014';
    ctx.fillRect(0, 0, W, H);
    if (title) {
        ctx.fillStyle = '#e6e6e6';
        ctx.font = 'bold 30px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(title.length > 40 ? title.slice(0, 39) + '…' : title, W / 2, 18);
    }
    const cx = W / 2;
    const cy = H / 2 + 24;
    const radius = Math.min(W, H) / 2 - 80;
    const slice = (Math.PI * 2) / options.length;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    for (let i = 0; i < options.length; i++) {
        const start = i * slice;
        ctx.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length];
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius, start, start + slice);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#0e1014';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.save();
        ctx.rotate(start + slice / 2);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const txt = options[i].length > 18 ? options[i].slice(0, 17) + '…' : options[i];
        ctx.fillText(txt, radius - 16, 0);
        ctx.restore();
    }
    ctx.restore();
    // Pointer (top, pointing down at the wheel)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius + 6);
    ctx.lineTo(cx - 18, cy - radius - 26);
    ctx.lineTo(cx + 18, cy - radius - 26);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#0e1014';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Center hub
    ctx.fillStyle = '#1a1d23';
    ctx.beginPath();
    ctx.arc(cx, cy, 38, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Winner banner on hold frames
    if (winnerIdx != null) {
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 34px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const txt = '🎉 ' + (options[winnerIdx].length > 28 ? options[winnerIdx].slice(0, 27) + '…' : options[winnerIdx]);
        ctx.fillText(txt, W / 2, H - 18);
    }
}

async function handlePlayAutocomplete(interaction) {
    const focused = String(interaction.options.getFocused() || '').toLowerCase();
    const meta = loadSoundsMeta();
    const items = [];
    for (const [filename, m] of Object.entries(meta)) {
        const displayName = String((m && m.displayName) || filename);
        const lower = displayName.toLowerCase();
        if (!focused || lower.includes(focused) || filename.toLowerCase().includes(focused)) {
            items.push({ name: displayName.length > 100 ? displayName.slice(0, 99) + '…' : displayName, value: filename });
            if (items.length >= 25) break;
        }
    }
    try { await interaction.respond(items); } catch {}
}

function handleSpeechResult(userId, text, firedThisUtterance = null) {
    const normalized = normalizeTriggerPhrase(text);
    if (!normalized) return;
    const list = loadVoiceTriggers();
    const now = Date.now();
    const globalCooldownMs = getVoiceTriggersGlobalCooldownSec() * 1000;
    const globalSkipping = globalCooldownMs && now - voiceTriggerGlobalLastFired < globalCooldownMs;
    for (const trigger of list) {
        if (!trigger.enabled) continue;
        if (trigger.speakerUserId && trigger.speakerUserId !== String(userId)) continue;
        if (!phraseMatchesTranscript(normalized, trigger.phrase)) continue;
        if (firedThisUtterance && firedThisUtterance.has(trigger.id)) {
            // Already fired on a partial earlier in this utterance — upgrade
            // the recorded transcript to the final, fuller sentence.
            const prev = firedThisUtterance.get(trigger.id);
            if (prev) prev.transcript = text;
            continue;
        }
        const baseEvent = {
            speakerUserId: String(userId),
            triggerId: trigger.id,
            phrase: trigger.phrase,
            transcript: text,
            soundFilename: trigger.soundFilename,
        };
        if (globalSkipping) {
            recordVoiceTriggerEvent({ ...baseEvent, status: 'global-cooldown-skipped' });
            continue;
        }
        const last = voiceTriggerLastFired.get(trigger.id) || 0;
        const cooldownMs = (trigger.cooldownSec || 0) * 1000;
        if (now - last < cooldownMs) {
            recordVoiceTriggerEvent({ ...baseEvent, status: 'cooldown-skipped' });
            continue;
        }
        voiceTriggerLastFired.set(trigger.id, now);
        voiceTriggerGlobalLastFired = now;
        const logEntry = recordVoiceTriggerEvent({ ...baseEvent, status: 'fired' });
        if (firedThisUtterance) firedThisUtterance.set(trigger.id, logEntry);
        console.log(`[voice-triggers] fired '${trigger.phrase}' for ${userId} (heard "${text}")`);
        // Voice triggers play as a regular 'user' so they obey the admin-only
        // / superadmin-only gates configured for the soundboard. Earlier this
        // ran with role 'superadmin', which silently bypassed every gate.
        // priority:true asks the mixer to duck other concurrent tracks
        // while the trigger sound plays, so the punchline sits above music.
        playSoundAsLinkedUser(trigger.soundFilename, { username: 'voice-trigger', role: 'user', priority: true })
            .then(r => { if (!r || !r.ok) console.warn('[voice-triggers] playback failed:', r?.reason); })
            .catch(err => console.error('[voice-triggers] playback error:', err.message));
        // Auto-clip: optionally save the last N seconds of channel audio
        // every time a trigger fires, so we keep the surrounding context
        // without anyone manually hitting /clip. Fire-and-forget; never
        // gates the trigger sound playback.
        const autoClipSec = getVoiceTriggersAutoClipSec();
        if (autoClipSec > 0) {
            captureClip(autoClipSec, { userId: String(userId), source: 'auto-trigger', triggerPhrase: trigger.phrase })
                .catch(err => console.warn('[voice-triggers] auto-clip failed:', err && err.message));
        }
        // After firing one trigger, respect global cooldown for subsequent matches in this utterance.
        if (globalCooldownMs) break;
    }
    handleWakeWord(userId, normalized, firedThisUtterance);
}

// "<wake> [hey/please/...] [play] <sound name>" — when the configured wake
// word is heard, look up the sound by display-name / filename substring and
// fire it as the linked user (so role gates apply). Per-utterance dedupe
// reuses the same firedThisUtterance Map by stashing a sentinel key.
const WAKE_WORD_KEY = '__wake__';
function handleWakeWord(userId, normalized, firedThisUtterance) {
    const wake = getVoiceTriggersWakeWord();
    if (!wake || !normalized) return;
    if (firedThisUtterance && firedThisUtterance.has(WAKE_WORD_KEY)) return;
    const wakeEsc = wake.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // After the wake word, allow filler words like "hey/please/can you" before
    // "play", and let "play" itself be optional ("soundboard airhorn").
    const re = new RegExp('\\b' + wakeEsc + '\\b[\\s,]+(?:(?:please|hey|can you|could you)\\s+)?(?:play\\s+)?(.+)$', 'i');
    const m = normalized.match(re);
    if (!m || !m[1]) return;
    const query = m[1].trim().replace(/[!?.,;:]+$/g, '').trim();
    if (!query || query.length < 2) return;
    const soundsMeta = loadSoundsMeta();
    const files = Object.keys(soundsMeta);
    const q = query.toLowerCase();
    const nameOf = (f) => String((soundsMeta[f] && soundsMeta[f].displayName) || f).toLowerCase();
    const matched =
        files.find(f => nameOf(f) === q) ||
        files.find(f => nameOf(f).startsWith(q)) ||
        files.find(f => nameOf(f).includes(q));
    if (!matched) {
        console.log(`[wake-word] heard "${query}" from ${userId} — no matching sound`);
        return;
    }
    if (firedThisUtterance) firedThisUtterance.set(WAKE_WORD_KEY, { transcript: normalized, query, sound: matched });
    console.log(`[wake-word] firing "${matched}" for ${userId} (heard: "${query}")`);
    playSoundAsLinkedUser(matched, { username: 'wake-word', role: 'user', priority: true })
        .then(r => { if (!r || !r.ok) console.warn('[wake-word] playback failed:', r?.reason); })
        .catch(err => console.error('[wake-word] playback error:', err.message));
}

// ---------------------------------------------------------------------------
// Voice connection lifecycle helpers
// ---------------------------------------------------------------------------
// DAVE (Discord E2EE voice) per-packet decrypt failures are emitted by the
// library on the connection 'debug' channel — at our volume that's ~2/sec of
// pure noise that drowns out real signal and churns through journald history.
// Drop them at the source and emit a 30s rollup with the count instead so
// you can still spot a sustained problem.
let daveDecryptFailCount = 0;
let daveDecryptFlushTimer = null;
function recordDaveDecryptFail() {
    daveDecryptFailCount++;
    if (daveDecryptFlushTimer) return;
    daveDecryptFlushTimer = setTimeout(() => {
        const n = daveDecryptFailCount;
        daveDecryptFailCount = 0;
        daveDecryptFlushTimer = null;
        if (n > 0) console.log(`[DIAG] voice.dave decrypt failures last 30s: ${n}`);
    }, 30_000);
    if (daveDecryptFlushTimer.unref) daveDecryptFlushTimer.unref();
}

let prematureCloseTimestamps = [];

function attachVoiceConnectionListeners(conn) {
    conn.on('error', err => {
        console.error('Voice connection error:', err.message);
        console.log('[DIAG] voice.connectionError', err.message);
        leaveVoiceChannel();
    });
    conn.on('close', code => { console.log('[DIAG] voice.close code=', code); });
    conn.on('debug', msg => {
        if (msg && typeof msg === 'string' && msg.includes('Failed to decrypt a packet')) {
            recordDaveDecryptFail();
            return;
        }
        console.log('[DIAG] voice.debug', msg);
    });
    conn.on('stateChange', (o, n) => {
        const rejoin = conn?.rejoinAttempts ?? '?';
        const nwCode = n.networking?.state?.code ?? '?';
        console.log('[DIAG] voice.stateChange', o.status, '->', n.status, 'rejoinAttempts=', rejoin, 'networkingCode=', nwCode);
    });
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
        // Standard discord.js voice pattern: race Signalling vs Connecting to
        // see whether the library is recovering on its own; if neither lands
        // within 5s the connection is truly gone and we force-rejoin.
        try {
            await Promise.race([
                entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
                entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
            ]);
            // If our reference moved on (manual /rejoin during the race),
            // don't log success on someone else's behalf.
            if (conn !== currentConnection) return;
            console.log('[DIAG] voice.disconnect recovering');
        } catch {
            // The 5s race can land 4-5s into a fresh manual /rejoin; without
            // this guard the stale handler would tear that new connection
            // down.
            if (conn !== currentConnection) return;
            requestRejoin('disconnected');
        }
    });
}

function joinChannelById(channel) {
    activeGuildId = channel.guild.id;
    currentConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        daveEncryption: true,
        debug: true,
        selfDeaf: false,
        selfMute: false,
    });
    attachVoiceConnectionListeners(currentConnection);
    currentConnection.subscribe(player);
    startVoiceTriggerCapture();
    startClipCapture();
    return currentConnection;
}

// Late-join guilds need slash commands too. registerSlashCommands iterates
// every guild in cache and writes the full set, so we can call it again
// safely on each guildCreate.
client.on('guildCreate', (guild) => {
    console.log(`[slash] joined guild ${guild.name} (${guild.id}) — re-registering commands`);
    registerSlashCommands().catch(err => console.error('[slash] re-register on guildCreate failed:', err.message));
});

client.once('ready', () => {
    console.log(`🤖 Bot logged in as ${client.user.tag}`);
    registerSlashCommands().catch(err => console.error('[slash] registration failed:', err.message));
    if (lastChannelId) {
        const channel = client.channels.cache.get(lastChannelId);
        if (channel?.isVoiceBased()) {
            joinChannelById(channel);
            console.log(`🔊 Auto-joined ${channel.name}`);
        }
    }
});

// Play entrance/exit sounds when linked users join or leave the bot's current channel.
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        // Linking master must be on AND the entrance/exit sub-toggle —
        // /play uses the master alone (it only needs role inheritance).
        if (!getDiscordLinkGlobalEnabled() || !getDiscordLinkEntranceExitEnabled()) return;
        if (!activeGuildId || !lastChannelId) return;
        if (newState.guild?.id !== activeGuildId && oldState.guild?.id !== activeGuildId) return;

        const discordUserId = newState.id || oldState.id;
        const username = findUsernameByDiscordId(discordUserId);
        if (!username) return;
        const link = getDiscordLinkForUser(username);
        if (!link || link.disabled) return;

        const user = USERS.get(username);
        if (!user || user.disabled) return;
        const role = user.role || 'user';

        const wasInBotChannel = oldState.channelId === lastChannelId;
        const isInBotChannel = newState.channelId === lastChannelId;

        if (!wasInBotChannel && isInBotChannel && link.entranceSound) {
            await playSoundAsLinkedUser(link.entranceSound, { username, role });
        } else if (wasInBotChannel && !isInBotChannel && link.exitSound) {
            await playSoundAsLinkedUser(link.exitSound, { username, role });
        }
    } catch (err) {
        console.error('[entrance-exit] voiceStateUpdate error:', err);
    }
});

// Per-IP login attempt tracker. 10 failed attempts in 10 minutes locks the
// IP out for the rest of the window. Memory-only; cleared on restart, which
// is fine for a private-Discord bot — this is a brute-force speed bump, not
// a stateful security boundary.
const LOGIN_RATELIMIT_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_RATELIMIT_MAX_FAILS = 10;
const loginAttempts = new Map(); // ip -> { failedAt: number[], lockedUntil?: number }
function recordLoginFailure(ip) {
    const now = Date.now();
    const rec = loginAttempts.get(ip) || { failedAt: [] };
    rec.failedAt = rec.failedAt.filter(t => now - t < LOGIN_RATELIMIT_WINDOW_MS);
    rec.failedAt.push(now);
    if (rec.failedAt.length >= LOGIN_RATELIMIT_MAX_FAILS) {
        rec.lockedUntil = now + LOGIN_RATELIMIT_WINDOW_MS;
    }
    loginAttempts.set(ip, rec);
}
function checkLoginRateLimit(ip) {
    const rec = loginAttempts.get(ip);
    if (!rec) return { allowed: true };
    const now = Date.now();
    if (rec.lockedUntil && rec.lockedUntil > now) {
        return { allowed: false, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
    }
    return { allowed: true };
}

// Generic per-IP sliding-window limiter for cheap-to-abuse unauthenticated
// endpoints (register, guest-start). Keeps a bounded map (evicts empty recs).
const _ipHits = new Map(); // key -> { hits: number[] }
function checkIpRateLimit(key, ip, max, windowMs) {
    const now = Date.now();
    const k = key + ':' + ip;
    const rec = _ipHits.get(k) || { hits: [] };
    rec.hits = rec.hits.filter(t => now - t < windowMs);
    if (rec.hits.length >= max) {
        _ipHits.set(k, rec);
        return { allowed: false, retryAfterSec: Math.ceil((windowMs - (now - rec.hits[0])) / 1000) };
    }
    rec.hits.push(now);
    _ipHits.set(k, rec);
    return { allowed: true };
}
// Periodically drop stale entries so the map can't grow unbounded.
setInterval(() => {
    const now = Date.now();
    for (const [k, rec] of _ipHits) {
        if (!rec.hits.some(t => now - t < 15 * 60 * 1000)) _ipHits.delete(k);
    }
}, 5 * 60 * 1000).unref();

app.post('/api/login', (req, res) => {
    const ip = getClientIP(req);
    const limit = checkLoginRateLimit(ip);
    if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSec));
        return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)}m.` });
    }
    const { username, password } = req.body || {};
    const user = checkCredentials(String(username || ''), String(password || ''));
    if (!user) {
        recordLoginFailure(ip);
        return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (user.disabled) return res.status(403).json({ error: 'Account is disabled. Contact an admin.' });
    // Successful login wipes the failure record so a real user who fat-fingers
    // a few times before getting it right doesn't stay locked.
    loginAttempts.delete(ip);
    req.session.user = user;
    req.session.save((err) => {
        if (err) return res.status(500).json({ error: 'Session error' });
        res.json(user);
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

const USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;
app.post('/api/register', (req, res) => {
    const ip = getClientIP(req);
    if (isIPBlocked(ip)) return res.status(403).json({ error: 'Your IP has been blocked.' });
    // Throttle: register hashes a password (blocking scrypt) and appends to a
    // file, so an unthrottled loop is an event-loop + disk DoS.
    const rl = checkIpRateLimit('register', ip, 5, 10 * 60 * 1000);
    if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSec));
        return res.status(429).json({ error: 'Too many signup attempts. Try again later.' });
    }
    const { username, password } = req.body || {};
    const un = String(username || '').trim();
    const pw = String(password || '');
    if (!un || !pw) return res.status(400).json({ error: 'Username and password required' });
    if (!USERNAME_RE.test(un)) return res.status(400).json({ error: 'Username must be 2–32 chars, letters, numbers, underscore, hyphen only' });
    if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const unLower = un.toLowerCase();
    if (USERS.has(unLower)) return res.status(400).json({ error: 'Username already taken' });
    const pending = loadPendingUsers();
    if (pending.length >= 200) return res.status(429).json({ error: 'The signup queue is full. Please try again later.' });
    if (pending.some(p => String(p.username || '').toLowerCase() === unLower)) return res.status(400).json({ error: 'Registration already pending' });
    pending.push({ username: unLower, password: hashPassword(pw), createdAt: Date.now() });
    savePendingUsers(pending);
    res.status(201).json({ message: 'Registration submitted. Awaiting admin approval.' });
});

app.get('/api/guest-status', (req, res) => {
    res.json({ guestEnabled: getGuestEnabled() });
});

app.post('/api/guest/start', (req, res) => {
    if (!getGuestEnabled()) return res.status(403).json({ error: 'Guest access is disabled.' });
    const ip = getClientIP(req);
    if (isIPBlocked(ip)) return res.status(403).json({ error: 'Your IP has been blocked.' });
    const rl = checkIpRateLimit('guest-start', ip, 20, 10 * 60 * 1000);
    if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSec));
        return res.status(429).json({ error: 'Too many guest sessions from this address. Try again later.' });
    }
    req.session.user = { username: 'guest', role: 'guest', ip };
    req.session.save((err) => {
        if (err) return res.status(500).json({ error: 'Session error' });
        res.json(req.session.user);
    });
});

app.get('/api/me', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const entry = req.session.user.role !== 'guest' ? USERS.get((req.session.user.username || '').toLowerCase()) : null;
    const u = { ...req.session.user };
    if (entry && entry.mustChangePassword !== undefined) u.mustChangePassword = entry.mustChangePassword === true;
    if (u.role === 'guest') delete u.ip;
    res.json(u);
});

// Per-account preferences (favorites, TTS presets, sort/filter, theme) so they
// follow a user across devices instead of being trapped in one browser's
// localStorage. Guests stay local-only.
const USER_PREFS_FILE = path.join(DATA_DIR, 'user-prefs.json');
function loadAllUserPrefs() { try { return JSON.parse(fs.readFileSync(USER_PREFS_FILE, 'utf8')); } catch { return {}; } }
function saveAllUserPrefs(all) { try { writeJsonAtomic(USER_PREFS_FILE, all); } catch (e) { console.warn('[prefs] save failed:', e.message); } }
app.get('/api/me/prefs', requireAuth, (req, res) => {
    const u = req.session.user;
    if (!u || u.role === 'guest') return res.json({ prefs: {} });
    const all = loadAllUserPrefs();
    res.json({ prefs: all[(u.username || '').toLowerCase()] || {} });
});
app.patch('/api/me/prefs', requireAuth, (req, res) => {
    const u = req.session.user;
    if (!u || u.role === 'guest') return res.json({ ok: true }); // guests stay local-only
    const incoming = (req.body && typeof req.body.prefs === 'object' && req.body.prefs) ? req.body.prefs : {};
    const key = (u.username || '').toLowerCase();
    const all = loadAllUserPrefs();
    const merged = { ...(all[key] || {}), ...incoming };
    if (JSON.stringify(merged).length > 20000) return res.status(413).json({ error: 'Preferences too large' });
    all[key] = merged;
    saveAllUserPrefs(all);
    res.json({ ok: true });
});

app.get('/api/channels', requireAdmin, (req, res) => {
    const channels = [];
    client.guilds.cache.forEach(guild => {
        guild.channels.cache.filter(c => c.isVoiceBased()).forEach(channel => {
            channels.push({ id: channel.id, name: `${guild.name} - ${channel.name}` });
        });
    });
    const voiceConnected = !!(activeGuildId && getVoiceConnection(activeGuildId));
    let voiceChannelName = null;
    if (voiceConnected && lastChannelId) {
        const ch = client.channels.cache.get(lastChannelId);
        if (ch) voiceChannelName = `${ch.guild.name} - ${ch.name}`;
    }
    res.json({ channels, lastChannelId: lastChannelId || null, voiceConnected, voiceChannelName });
});

let activeGuildId = null; // Track the server ID
let lastChannelId = null; // Persisted for auto-join on restart

(function initServerState() {
    const state = loadServerState();
    if (Number.isFinite(state.volume)) currentVolume = Math.max(0, Math.min(1, state.volume));
    if (typeof state.lastChannelId === 'string' && state.lastChannelId) lastChannelId = state.lastChannelId;
    if (typeof state.multiPlay === 'boolean') multiPlayEnabled = state.multiPlay;
})();

// Catch and log audio errors so the bot doesn't crash silently.
// Also clear the TTS-playing flag here so a broken resource can't wedge the
// queue: without this, a subsequent sound played before TTS recovers would
// overwrite playbackState, preventing the Idle handler from noticing that
// TTS had been playing and leaving ttsIsPlaying stuck true forever.
player.on('error', error => {
    const meta = error.resource?.metadata ?? 'unknown';
    console.error(`❌ Audio Player Error: ${error.message} (resource: ${meta})`);
    console.log('[DIAG] player.error', error.message, 'resource:', meta);
    finalizeAllOpenPlays(true);
    playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, duration: null, startedBy: null };
    if (activeMixer) { activeMixer.destroy(); activeMixer = null; }
    activeTracks.clear();
    ttsIsPlaying = false;
    processTtsQueue();
    // 3 "Premature close" errors inside 30s usually means the underlying voice
    // connection is flaky beyond what the library will self-heal — force a
    // leave+rejoin.
    if (error.message && error.message.includes('Premature close') && lastChannelId && activeGuildId) {
        const now = Date.now();
        prematureCloseTimestamps = prematureCloseTimestamps.filter(t => now - t < 30_000);
        prematureCloseTimestamps.push(now);
        if (prematureCloseTimestamps.length >= 3) {
            prematureCloseTimestamps = [];
            requestRejoin('premature-close-burst');
        }
    }
});

player.on('stateChange', (oldState, newState) => {
    console.log('[DIAG] player.stateChange', oldState.status, '->', newState.status);
    if (newState.status === AudioPlayerStatus.Idle) {
        finalizeAllOpenPlays();
        playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, duration: null, startedBy: null };
        if (activeMixer) { activeMixer.destroy(); activeMixer = null; }
        activeTracks.clear();
        // Whenever the shared player is idle, TTS can't be playing either.
        // (Previously this was gated on playbackState.tts, which meant a
        // non-TTS sound played between a TTS start and its end could leave
        // ttsIsPlaying stuck true.)
        ttsIsPlaying = false;
        urlSkipVotes.clear();
        processTtsQueue();
        // TTS gets first claim on the freed player; if it started something,
        // the guards inside processUrlQueue keep the URL queue waiting.
        processUrlQueue();
    } else if (
        (newState.status === AudioPlayerStatus.Playing || newState.status === AudioPlayerStatus.Buffering) &&
        ttsIsPlaying && newState.resource?.metadata?.filename !== 'tts'
    ) {
        // Resource swap mid-flight: a non-TTS sound took over the shared
        // player before the old TTS hit Idle. Without this reset the UI
        // keeps claiming "TTS playing" alongside the new sound.
        ttsIsPlaying = false;
    }
});

function playTtsBuffer(item) {
    const { wavBuffer, displayName, startedBy, voiceId, ttsVolume } = item;
    ttsIsPlaying = true;
    try {
        if (multiPlayEnabled) {
            const soundStopOthers = false;
            const currentStatus = player.state.status;
            const isSomeonePlaying = currentStatus === AudioPlayerStatus.Playing || currentStatus === AudioPlayerStatus.Paused || currentStatus === AudioPlayerStatus.Buffering || currentStatus === AudioPlayerStatus.AutoPaused;
            if (soundStopOthers || !isSomeonePlaying) {
                if (activeMixer) { activeMixer.removeAllTracks(); activeMixer.destroy(); activeMixer = null; }
                activeTracks.clear();
                player.stop();
            }
            if (!activeMixer || activeMixer.destroyed) {
                activeMixer = new AudioMixer();
                const resource = createAudioResource(activeMixer, { inputType: StreamType.Raw, inlineVolume: true });
                resource.volume.setVolume(currentVolume);
                player.play(resource);
            }
            const ff = spawn('ffmpeg', ['-nostdin', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', '-af', `volume=${ttsVolume}`, '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
            ff.stderr.on('data', () => {});
            ff.on('error', (err) => console.error('[TTS] ffmpeg multi-play error', err));
            ff.on('close', () => { ttsIsPlaying = false; processTtsQueue(); });
            Readable.from(wavBuffer).pipe(ff.stdin);
            const trackId = activeMixer.addTrack(ff.stdout, { filename: 'tts', displayName }, ff, { priority: true });
            activeTracks.set(trackId, { filename: 'tts', displayName, startTime: Date.now(), startTimeOffset: 0, duration: null, startedBy });
            playbackState = { status: 'playing', filename: 'tts', displayName, startTime: Date.now(), startTimeOffset: 0, duration: null, startedBy, tts: true, ttsVoice: voiceId };
        } else {
            const ff = spawn('ffmpeg', ['-nostdin', '-i', 'pipe:0', '-f', 'mp3', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
            ff.stderr.on('data', () => {});
            ff.on('error', (err) => console.error('[TTS] ffmpeg error', err));
            // Self-heal: if ffmpeg dies before the player reaches Playing,
            // ttsIsPlaying never clears because the Idle handler won't fire.
            // Mirror the multi-play branch's close handler.
            ff.on('close', () => { if (ttsIsPlaying) { ttsIsPlaying = false; processTtsQueue(); } });
            Readable.from(wavBuffer).pipe(ff.stdin);
            const resource = createAudioResource(ff.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true, metadata: { filename: 'tts', displayName } });
            resource.volume.setVolume(Math.max(0, Math.min(2, currentVolume * ttsVolume)));
            player.play(resource);
            playbackState = { status: 'playing', filename: 'tts', displayName, startTime: Date.now(), startTimeOffset: 0, duration: null, startedBy, tts: true, ttsVoice: voiceId };
        }
    } catch (err) {
        console.error('[TTS Queue] play error:', err);
        ttsIsPlaying = false;
        processTtsQueue();
    }
}

function processTtsQueue() {
    if (ttsQueue.length === 0) return;
    // Self-heal: if we think TTS is playing but the shared player is actually
    // idle, something went wrong earlier (e.g. ffmpeg crashed before emitting
    // close) and ttsIsPlaying is stale. Clear it and continue.
    if (ttsIsPlaying && player.state.status === AudioPlayerStatus.Idle) {
        console.warn('[TTS Queue] ttsIsPlaying was stuck — resetting (player is idle)');
        ttsIsPlaying = false;
    }
    if (ttsIsPlaying) return;
    // Don't start TTS if a non-TTS sound is currently playing
    const playerStatus = player.state.status;
    if ((playerStatus === AudioPlayerStatus.Playing || playerStatus === AudioPlayerStatus.Buffering) && !playbackState.tts) return;
    const item = ttsQueue.shift();
    console.log('[TTS Queue] playing next item, %d remaining', ttsQueue.length);
    addToRecentlyPlayedServer('tts', item.displayName, item.startedBy?.username ?? null, Date.now());
    playTtsBuffer(item);
}

// player.stop() during teardown fires the Idle handler synchronously while
// the voice connection still looks alive — without this flag the URL queue
// would start its next stream into a connection we're about to destroy.
let voiceTeardownInProgress = false;

function leaveVoiceChannel() {
    if (activeGuildId) {
        voiceTeardownInProgress = true;
        try {
            stopVoiceTriggerCapture();
            stopClipCapture();
            // Carrying premature-close timestamps across a leave can falsely
            // trip the 3-in-30s rejoin guard the moment we reconnect.
            prematureCloseTimestamps = [];
            player.stop();
            if (activeMixer) { activeMixer.destroy(); activeMixer = null; }
            activeTracks.clear();
            const connection = getVoiceConnection(activeGuildId);
            if (connection) connection.destroy();
            activeGuildId = null;
            currentConnection = null;
        } finally {
            voiceTeardownInProgress = false;
        }
        return true;
    }
    return false;
}

app.post('/api/join', requireAdmin, (req, res) => {
    const { channelId } = req.body;
    const channel = client.channels.cache.get(channelId);
    if (!channel) return res.status(404).send('Channel not found');

    // Leave current channel before joining a new one
    leaveVoiceChannel();

    joinChannelById(channel);
    console.log('[DIAG] voice.join channelId=', channelId, 'guildId=', channel.guild.id, 'connectionState=', currentConnection.state?.status ?? 'unknown');
    lastChannelId = channelId;
    saveServerState({ lastChannelId });
    // Rejoining voice resumes any URL streams still waiting in the queue.
    if (urlStreamQueue.length > 0) setTimeout(processUrlQueue, 1000);
    res.send(`Joined ${channel.name}`);
});

app.post('/api/leave', requireAdmin, (req, res) => {
    if (leaveVoiceChannel()) {
        res.send('Left channel');
    } else {
        res.send('Not in a channel');
    }
});

// /api/sounds is polled at 1-10s by every connected client and rebuilds a
// ~130 KB JSON payload that requires N statSync calls + a full meta JSON
// parse. Cache the body + ETag for SOUNDS_CACHE_TTL_MS and serve 304 on
// matching If-None-Match. Invalidations from sound writes/deletes/meta-
// edits null the cache so updates surface immediately.
let _soundsCache = null;
const SOUNDS_CACHE_TTL_MS = 10_000;

function buildSoundsResponse() {
    const files = fs.readdirSync(SOUNDS_DIR);
    const meta = loadSoundsMeta();
    const audioFiles = files.filter(f => f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.ogg'));
    const order = getSoundOrder(meta);
    const orderSet = new Set(order);
    const ordered = order.filter(f => audioFiles.includes(f));
    const rest = audioFiles.filter(f => !orderSet.has(f));
    const sorted = [...ordered, ...rest];
    const list = sorted.map(filename => {
        const m = meta[filename];
        const suno = (m && typeof m === 'object' && m.suno && typeof m.suno === 'object') ? m.suno : null;
        let mtime = null;
        try { mtime = fs.statSync(path.join(SOUNDS_DIR, filename)).mtimeMs; } catch {}
        return {
            filename,
            displayName: getDisplayName(meta, filename),
            duration: getDuration(meta, filename),
            tags: getTags(meta, filename),
            color: getColor(meta, filename),
            volume: getSoundVolume(meta, filename),
            startTime: getSoundStartTime(meta, filename),
            endTime: getSoundEndTime(meta, filename),
            stopOthers: getSoundStopOthers(meta, filename),
            tts: getSoundTts(meta, filename),
            mtime,
            suno: suno ? {
                model: suno.model || null,
                style: suno.style || null,
                cover: suno.cover || null,
                title: suno.title || null,
                has_lyrics: !!suno.lyrics,
            } : null,
        };
    });
    const tagOrder = getTagOrder(meta);
    const hidden = getHiddenTags(meta);
    const allTags = getAllTagsFromSounds(meta);
    const tags = tagOrder.length ? [...tagOrder, ...allTags.filter(t => !tagOrder.includes(t))] : allTags;
    return { list, tags: [...new Set(tags)], hidden };
}

function getCachedSoundsResponse() {
    const now = Date.now();
    if (_soundsCache && now - _soundsCache.builtAt < SOUNDS_CACHE_TTL_MS) {
        return _soundsCache;
    }
    const body = buildSoundsResponse();
    const json = JSON.stringify(body);
    const etag = '"' + crypto.createHash('sha1').update(json).digest('base64').slice(0, 22) + '"';
    _soundsCache = { body, json, etag, builtAt: now };
    return _soundsCache;
}

function invalidateSoundsCache() {
    _soundsCache = null;
}

app.get('/api/sounds', requireAuth, (req, res) => {
    let cache;
    try { cache = getCachedSoundsResponse(); }
    catch (err) { return res.status(500).send('Error reading sounds directory'); }
    if (req.headers['if-none-match'] === cache.etag) {
        res.setHeader('ETag', cache.etag);
        return res.status(304).end();
    }
    res.setHeader('ETag', cache.etag);
    res.setHeader('Cache-Control', 'private, max-age=10');
    res.type('application/json').send(cache.json);
});

app.patch('/api/sounds/order', requireAdmin, (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
    const safe = order.filter(f => typeof f === 'string' && /\.(mp3|wav|ogg)$/i.test(f));
    setSoundOrder(safe);
    res.json({ order: safe });
});

app.get('/api/sounds/cover/:cover', requireAuth, (req, res) => {
    // Cover images for saved Suno songs live under sounds/covers/*.jpg. Only
    // serve files that stay within that subdir (no traversal).
    const raw = req.params.cover;
    const safeName = path.basename(raw);
    if (!safeName || !/\.(jpg|jpeg|png|webp)$/i.test(safeName)) return res.status(400).send('Invalid cover');
    const coversDir = path.join(SOUNDS_DIR, 'covers');
    const filePath = path.join(coversDir, safeName);
    if (!path.resolve(filePath).startsWith(path.resolve(coversDir)) || !fs.existsSync(filePath)) return res.status(404).send('Not found');
    const ext = path.extname(safeName).toLowerCase();
    const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
});

app.get('/api/sounds/audio/:filename', requireAuth, (req, res) => {
    const raw = req.params.filename;
    const safeFilename = path.basename(raw);
    if (!safeFilename || !/\.(mp3|wav|ogg)$/i.test(safeFilename)) return res.status(400).send('Invalid file');
    const filePath = path.join(SOUNDS_DIR, safeFilename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(SOUNDS_DIR)) || !fs.existsSync(filePath)) return res.status(404).send('Not found');
    const ext = path.extname(safeFilename).toLowerCase();
    const mime = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' }[ext] || 'application/octet-stream';
    // Use file mtime for caching — ensures browser refetches after normalize
    const stat = fs.statSync(filePath);
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('ETag', etag);
    // Sound files are content-addressed by mtime via the ETag. 5 minutes of
    // browser-level caching covers most repeat plays without per-tap network
    // hits; normalize changes mtime so the new ETag invalidates.
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    const start = typeof req.query.start === 'string' ? parseFloat(req.query.start) : null;
    const end = typeof req.query.end === 'string' ? parseFloat(req.query.end) : null;
    const needsTrim = (start != null && start > 0) || (end != null && end > 0);
    if (needsTrim) {
        const startSec = start != null && start >= 0 ? start : 0;
        const endSec = end != null && end > startSec ? end : null;
        const duration = endSec != null ? endSec - startSec : null;
        const args = ['-nostdin'];
        if (startSec > 0) args.push('-ss', String(startSec));
        args.push('-i', filePath);
        if (duration != null && duration > 0) args.push('-t', String(duration));
        args.push('-f', 'mp3', '-');
        res.setHeader('Content-Type', 'audio/mpeg');
        const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        ff.stdout.pipe(res);
        ff.stderr.on('data', () => {});
        ff.on('error', (err) => { console.error('ffmpeg trim error', err); });
    } else {
        res.setHeader('Content-Type', mime);
        fs.createReadStream(filePath).pipe(res);
    }
});

const ARCHIVE_DIR = path.join(SOUNDS_DIR, '.archive');
function archiveSoundFile(filePath, safeFilename) {
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(ARCHIVE_DIR, `${ts}__${safeFilename}`);
    fs.renameSync(filePath, dest);
    return dest;
}

app.delete('/api/sounds/:filename', requireAuth, (req, res) => {
    const role = req.session.user.role;
    const un = req.session.user.username;
    if (!getSoundDeleteEnabled(role, un)) return res.status(403).json({ error: 'Sound delete is not enabled for your account' });
    const raw = req.params.filename;
    const safeFilename = path.basename(raw);
    if (!safeFilename || !/\.(mp3|wav|ogg)$/i.test(safeFilename)) return res.status(400).json({ error: 'Invalid filename' });
    const filePath = path.join(SOUNDS_DIR, safeFilename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(SOUNDS_DIR))) return res.status(403).json({ error: 'Invalid path' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    try {
        if (playbackState.filename === safeFilename) {
            player.stop();
            playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, startTimeOffset: null, duration: null, startedBy: null, pausedAt: null };
        }
        const archivedPath = archiveSoundFile(filePath, safeFilename);
        const meta = loadSoundsMeta();
        const snapshot = meta[safeFilename] || null;
        delete meta[safeFilename];
        const order = getSoundOrder(meta).filter(f => f !== safeFilename);
        meta._order = order;
        saveSoundsMeta(meta);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'sound.delete',
            target: safeFilename,
            details: { archivedPath: path.relative(SOUNDS_DIR, archivedPath), meta: snapshot },
        });
        res.json({ ok: true, archived: true });
    } catch (err) {
        console.error('Delete sound error:', err);
        res.status(500).json({ error: err.message || 'Failed to delete sound' });
    }
});

app.patch('/api/sounds/metadata', requireAdmin, (req, res) => {
    const { filename, displayName, tags, color, volume, startTime, endTime, stopOthers } = req.body;
    const safeFilename = filename && path.basename(filename);
    if (!safeFilename) return res.status(400).send('Filename required');
    const filePath = path.join(SOUNDS_DIR, safeFilename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    const updates = {};
    if (displayName !== undefined) updates.displayName = displayName != null ? String(displayName) : undefined;
    if (tags !== undefined) updates.tags = Array.isArray(tags) ? tags : (tags ? [tags] : []);
    if (color !== undefined) updates.color = color === null || color === '' ? null : String(color).trim();
    if (volume !== undefined) updates.volume = typeof volume === 'number' ? Math.max(0, Math.min(2, volume)) : undefined;
    if (startTime !== undefined) updates.startTime = (startTime === null || startTime === '') ? null : (typeof startTime === 'number' && startTime >= 0 ? startTime : undefined);
    if (endTime !== undefined) updates.endTime = (endTime === null || endTime === '') ? null : (typeof endTime === 'number' && endTime >= 0 ? endTime : undefined);
    if (stopOthers !== undefined) updates.stopOthers = !!stopOthers;
    setSoundMeta(safeFilename, updates);
    const meta = loadSoundsMeta();
    res.json({ filename: safeFilename, displayName: getDisplayName(meta, safeFilename), duration: getDuration(meta, safeFilename), tags: getTags(meta, safeFilename), color: getColor(meta, safeFilename), volume: getSoundVolume(meta, safeFilename), startTime: getSoundStartTime(meta, safeFilename), endTime: getSoundEndTime(meta, safeFilename), stopOthers: getSoundStopOthers(meta, safeFilename), tts: getSoundTts(meta, safeFilename) });
});

// Bulk delete — same semantics as the single DELETE (archive + remove from
// meta + drop from order). Honours per-user sound-delete permission.
app.post('/api/sounds/bulk-delete', requireAuth, (req, res) => {
    const role = req.session.user.role;
    const un = req.session.user.username;
    if (!getSoundDeleteEnabled(role, un)) return res.status(403).json({ error: 'Sound delete is not enabled for your account' });
    const incoming = Array.isArray(req.body?.filenames) ? req.body.filenames : [];
    const safe = [...new Set(incoming.map(f => path.basename(String(f))).filter(f => /\.(mp3|wav|ogg)$/i.test(f)))];
    if (!safe.length) return res.status(400).json({ error: 'No valid filenames' });
    if (safe.length > 200) return res.status(400).json({ error: 'Max 200 per request' });
    const deleted = [], failed = [];
    const meta = loadSoundsMeta();
    for (const filename of safe) {
        const filePath = path.join(SOUNDS_DIR, filename);
        if (!fs.existsSync(filePath)) { failed.push({ filename, reason: 'not-found' }); continue; }
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(path.resolve(SOUNDS_DIR))) { failed.push({ filename, reason: 'invalid-path' }); continue; }
        try {
            if (playbackState.filename === filename) {
                player.stop();
                playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, startTimeOffset: null, duration: null, startedBy: null, pausedAt: null };
            }
            archiveSoundFile(filePath, filename);
            delete meta[filename];
            deleted.push(filename);
        } catch (e) {
            failed.push({ filename, reason: e.message || 'unknown' });
        }
    }
    if (deleted.length) {
        meta._order = getSoundOrder(meta).filter(f => !deleted.includes(f));
        saveSoundsMeta(meta);
    }
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'sound.bulk-delete',
        target: null,
        details: { deleted_count: deleted.length, failed_count: failed.length },
    });
    res.json({ deleted, failed });
});

// Bulk retag — add and/or remove tags across a set of filenames in one
// pass. addTags / removeTags both arrays of strings.
app.post('/api/sounds/bulk-retag', requireAdmin, (req, res) => {
    const incoming = Array.isArray(req.body?.filenames) ? req.body.filenames : [];
    const addTags = Array.isArray(req.body?.addTags) ? req.body.addTags.map(s => String(s).trim()).filter(Boolean) : [];
    const removeTags = Array.isArray(req.body?.removeTags) ? req.body.removeTags.map(s => String(s).trim()).filter(Boolean) : [];
    const safe = [...new Set(incoming.map(f => path.basename(String(f))).filter(f => /\.(mp3|wav|ogg)$/i.test(f)))];
    if (!safe.length || (!addTags.length && !removeTags.length)) {
        return res.status(400).json({ error: 'Need filenames + at least one addTag/removeTag' });
    }
    const meta = loadSoundsMeta();
    let updated = 0;
    for (const filename of safe) {
        if (!(filename in meta) && !fs.existsSync(path.join(SOUNDS_DIR, filename))) continue;
        const cur = getTags(meta, filename);
        const set = new Set(cur);
        for (const t of removeTags) set.delete(t);
        for (const t of addTags) set.add(t);
        const next = [...set];
        const existing = meta[filename];
        if (typeof existing === 'object' && existing !== null) meta[filename] = { ...existing, tags: next };
        else meta[filename] = { displayName: typeof existing === 'string' ? existing : filename, tags: next };
        updated++;
    }
    if (updated) saveSoundsMeta(meta);
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'sound.bulk-retag',
        target: null,
        details: { count: updated, addTags, removeTags },
    });
    res.json({ updated, addTags, removeTags });
});

// Duplicate detection — group sounds by (filesize, rounded-duration). Two
// files with the same size to the byte AND the same duration to a tenth of
// a second are almost certainly the same audio.
app.get('/api/sounds/duplicates', requireAdmin, async (req, res) => {
    try {
        const files = fs.readdirSync(SOUNDS_DIR).filter(f => /\.(mp3|wav|ogg)$/i.test(f));
        const meta = loadSoundsMeta();
        const groups = new Map();
        for (const filename of files) {
            const fp = path.join(SOUNDS_DIR, filename);
            let stat;
            try { stat = fs.statSync(fp); } catch { continue; }
            let dur = getDuration(meta, filename);
            if (dur == null) {
                try { dur = await probeDurationAsync(fp); } catch {}
                if (dur != null) setSoundMeta(filename, { duration: dur });
            }
            const key = `${stat.size}_${dur != null ? Math.round(dur * 10) : 'na'}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({
                filename,
                displayName: getDisplayName(meta, filename),
                size: stat.size,
                duration: dur,
            });
        }
        const dupGroups = [...groups.values()].filter(g => g.length > 1);
        res.json({ groups: dupGroups, totalGroups: dupGroups.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/sounds/duplicate', requireAdmin, (req, res) => {
    const { filename, newName } = req.body || {};
    const safeFilename = filename && path.basename(String(filename));
    if (!safeFilename || !/\.(mp3|wav|ogg)$/i.test(safeFilename)) return res.status(400).json({ error: 'Invalid filename' });
    const srcPath = path.join(SOUNDS_DIR, safeFilename);
    if (!path.resolve(srcPath).startsWith(path.resolve(SOUNDS_DIR)) || !fs.existsSync(srcPath)) return res.status(404).json({ error: 'File not found' });

    const ext = path.extname(safeFilename);
    const base = path.basename(safeFilename, ext);
    let dstName = newName
        ? path.basename(String(newName)).replace(/[^a-zA-Z0-9._-]/g, '_')
        : `${base}_copy${ext}`;
    if (!/\.(mp3|wav|ogg)$/i.test(dstName)) dstName += ext;
    if (fs.existsSync(path.join(SOUNDS_DIR, dstName))) {
        dstName = `${path.basename(dstName, path.extname(dstName))}_${Date.now()}${path.extname(dstName)}`;
    }
    const dstPath = path.join(SOUNDS_DIR, dstName);
    if (!path.resolve(dstPath).startsWith(path.resolve(SOUNDS_DIR))) return res.status(403).json({ error: 'Invalid filename' });

    try {
        fs.copyFileSync(srcPath, dstPath);
        const meta = loadSoundsMeta();
        const srcMeta = meta[safeFilename];
        meta[dstName] = srcMeta && typeof srcMeta === 'object' ? { ...srcMeta } : (typeof srcMeta === 'string' ? { displayName: srcMeta } : {});
        const order = getSoundOrder(meta);
        const srcIdx = order.indexOf(safeFilename);
        if (srcIdx >= 0) order.splice(srcIdx + 1, 0, dstName);
        else order.push(dstName);
        meta._order = order;
        saveSoundsMeta(meta);
        res.json({ ok: true, filename: dstName });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to duplicate sound' });
    }
});

// Peak-based normalization using volumedetect. Writes to a .tmp.mp3 and
// renames over the original on success. Callback: cb(err, { skipped, gain }).
// Deterministic and idempotent — short files are safe (unlike loudnorm).
function normalizeFileInPlace(filePath, opts, cb) {
    // Back-compat: allow normalizeFileInPlace(path, cb).
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};
    const start = (typeof opts.start === 'number' && opts.start > 0) ? opts.start : 0;
    const end = (typeof opts.end === 'number' && opts.end > start) ? opts.end : null;
    // Measure peak volume over the SELECTED [start, end] window — the section
    // that actually plays — instead of the whole file. Trim is non-destructive
    // (applied at play time), so measuring the whole file computed the gain from
    // audio the user trimmed away. The gain pass below stays whole-file so the
    // trim stays re-editable.
    const measureArgs = ['-nostdin'];
    if (start > 0) measureArgs.push('-ss', String(start));
    measureArgs.push('-i', filePath);
    if (end != null) measureArgs.push('-t', String(end - start));
    measureArgs.push('-af', 'volumedetect', '-f', 'null', '-');
    const measure = spawn('ffmpeg', measureArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let measureErr = '';
    measure.stderr.on('data', chunk => { measureErr += chunk.toString(); });
    measure.on('error', err => cb(err));
    measure.on('close', code => {
        if (code !== 0) return cb(new Error('Volume measurement failed'));
        const maxMatch = measureErr.match(/max_volume:\s*([-\d.]+)\s*dB/);
        if (!maxMatch) return cb(new Error('Could not parse volume measurement'));
        const maxVolume = parseFloat(maxMatch[1]);
        const gain = -1.0 - maxVolume;
        console.log('[normalize]', path.basename(filePath), 'max_volume:', maxVolume, 'dB, gain:', gain.toFixed(1), 'dB');
        if (Math.abs(gain) < 0.5) return cb(null, { skipped: true, gain });
        const tmpPath = filePath + '.norm.tmp.mp3';
        const pass = spawn('ffmpeg', ['-nostdin', '-i', filePath, '-af', `volume=${gain}dB`, '-ar', '48000', '-y', tmpPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        pass.stderr.on('data', () => {});
        pass.on('error', err => { try { fs.unlinkSync(tmpPath); } catch {} ; cb(err); });
        pass.on('close', code2 => {
            if (code2 !== 0) {
                try { fs.unlinkSync(tmpPath); } catch {}
                return cb(new Error('Normalization failed'));
            }
            try {
                fs.renameSync(tmpPath, filePath);
                cb(null, { skipped: false, gain });
            } catch (err2) {
                cb(err2);
            }
        });
    });
}

app.post('/api/sounds/normalize/:filename', requireAdmin, (req, res) => {
    const safeFilename = path.basename(req.params.filename || '');
    if (!safeFilename || !/\.(mp3|wav|ogg)$/i.test(safeFilename)) return res.status(400).json({ error: 'Invalid filename' });
    const filePath = path.join(SOUNDS_DIR, safeFilename);
    if (!path.resolve(filePath).startsWith(path.resolve(SOUNDS_DIR)) || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    // Respect the sound's trim points so the gain is measured from the section
    // that actually plays, not the whole file.
    const nMeta = loadSoundsMeta();
    const nStart = getSoundStartTime(nMeta, safeFilename) || 0;
    const nEnd = getSoundEndTime(nMeta, safeFilename);
    normalizeFileInPlace(filePath, { start: nStart, end: nEnd }, (err, result) => {
        if (err) return res.status(500).json({ error: err.message || 'Normalization failed' });
        if (result.skipped) return res.json({ ok: true, skipped: true, message: 'Already normalized' });
        const duration = probeDuration(filePath);
        if (duration != null) setSoundMeta(safeFilename, { duration });
        res.json({ ok: true, gain: result.gain });
    });
});

app.get('/api/tags', requireAuth, (req, res) => {
    const meta = loadSoundsMeta();
    const order = getTagOrder(meta);
    const hidden = getHiddenTags(meta);
    const allTags = getAllTagsFromSounds(meta);
    const ordered = order.length ? [...order, ...allTags.filter(t => !order.includes(t))] : allTags;
    res.json({ tags: [...new Set(ordered)], hidden });
});

app.patch('/api/tags', requireAdmin, (req, res) => {
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
    const safe = tags.filter(f => typeof f === 'string' && f.trim() !== '').map(f => f.trim());
    setTagOrder(safe);
    res.json({ tags: safe });
});

app.patch('/api/tags/rename', requireAdmin, (req, res) => {
    const { oldName, newName } = req.body;
    const oldN = typeof oldName === 'string' ? oldName.trim() : '';
    const newN = typeof newName === 'string' ? newName.trim() : '';
    if (!oldN || !newN) return res.status(400).json({ error: 'oldName and newName required' });
    if (oldN === newN) return res.json({ ok: true });
    const meta = loadSoundsMeta();
    const order = getTagOrder(meta);
    if (!order.includes(oldN)) return res.status(404).json({ error: 'Tag not found' });
    if (order.includes(newN)) return res.status(400).json({ error: 'Target tag name already exists' });
    meta._tagOrder = order.map(f => f === oldN ? newN : f);
    Object.keys(meta).forEach(key => {
        if (key.startsWith('_')) return;
        const m = meta[key];
        if (m && typeof m === 'object' && Array.isArray(m.tags)) {
            m.tags = m.tags.map(t => t === oldN ? newN : t);
        }
    });
    if (meta._tagHidden && meta._tagHidden.includes(oldN)) {
        meta._tagHidden = meta._tagHidden.map(t => t === oldN ? newN : t);
    }
    saveSoundsMeta(meta);
    res.json({ ok: true, tags: meta._tagOrder });
});

app.patch('/api/tags/:name/hidden', requireAdmin, (req, res) => {
    const name = decodeURIComponent(req.params.name || '').trim();
    const { hidden } = req.body;
    if (!name) return res.status(400).json({ error: 'Tag name required' });
    const meta = loadSoundsMeta();
    const allTags = getAllTagsFromSounds(meta);
    if (!allTags.includes(name)) return res.status(404).json({ error: 'Tag not found' });
    setTagHidden(name, hidden === true);
    res.json({ ok: true, hidden: hidden === true });
});

app.delete('/api/tags/:name', requireAdmin, (req, res) => {
    const name = decodeURIComponent(req.params.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Tag name required' });
    const meta = loadSoundsMeta();
    const order = getTagOrder(meta);
    if (!order.includes(name) && !getAllTagsFromSounds(meta).includes(name)) return res.status(404).json({ error: 'Tag not found' });
    meta._tagOrder = (meta._tagOrder || []).filter(f => f !== name);
    meta._tagHidden = (meta._tagHidden || []).filter(f => f !== name);
    Object.keys(meta).forEach(key => {
        if (key.startsWith('_')) return;
        const m = meta[key];
        if (m && typeof m === 'object' && Array.isArray(m.tags)) {
            m.tags = m.tags.filter(t => t !== name);
        }
    });
    saveSoundsMeta(meta);
    res.json({ ok: true, tags: meta._tagOrder });
});

app.get('/api/settings', requireAuth, (req, res) => {
    const meta = loadSoundsMeta();
    const out = { playbackLocked: getPlaybackLocked(meta), playbackLockedBy: getPlaybackLocked(meta) ? getPlaybackLockedBy(meta) : null };
    if (req.session.user.role === 'superadmin') out.playbackSuperadminOnly = getPlaybackSuperadminOnly(meta);
    if (req.session.user.role === 'admin' || req.session.user.role === 'superadmin') {
        out.volume = currentVolume;
    }
    if (req.session.user.role === 'superadmin') {
        out.guestEnabled = getGuestEnabled();
        out.guestMaxDuration = getGuestMaxDuration();
        out.guestCooldownSec = getGuestCooldownSec();
        out.guestUploadEnabled = getGuestUploadEnabled();
        out.guestMaxUploadDuration = getGuestMaxUploadDuration();
        out.guestMaxUploadBytes = getGuestMaxUploadBytes();
        out.userUploadEnabled = getUserUploadEnabled();
        out.userMaxUploadDuration = getUserMaxUploadDuration();
        out.userMaxUploadBytes = getUserMaxUploadBytes();
        out.userMaxDuration = getUserMaxDuration();
        out.userCooldownSec = getUserCooldownSec();
        out.soundDeleteEnabled = {
            user: getSoundDeleteRoleDefault('user'),
            admin: getSoundDeleteRoleDefault('admin'),
        };
        out.autoNormalizeUploads = getAutoNormalizeUploads();
        const pending = (loadPendingMeta().uploads || []).filter(u => fs.existsSync(path.join(PENDING_DIR, u.filename)));
        out.pendingCount = pending.length;
        // TTS settings (superadmin)
        out.ttsEnabled = getTtsEnabled();
        out.ttsAvailable = !!TTS_API_URL;
        out.ttsMaxTextLength = { guest: getTtsMaxTextLength('guest'), user: getTtsMaxTextLength('user'), admin: getTtsMaxTextLength('admin'), superadmin: getTtsMaxTextLength('superadmin') };
        out.ttsCooldownSec = { guest: getTtsCooldownSec('guest'), user: getTtsCooldownSec('user'), admin: getTtsCooldownSec('admin'), superadmin: getTtsCooldownSec('superadmin') };
        out.ttsDisabledVoices = getTtsDisabledVoices();
        out.ttsPronunciationOverrides = getTtsPronunciationOverrides();
        out.ttsVoiceRvcOverrides = getTtsVoiceRvcOverrides();
        out.ttsMaxQueueSize = getTtsMaxQueueSize();
        // Suno settings (superadmin)
        out.sunoEnabled = getSunoEnabled();
        out.sunoAvailable = !!(process.env.SUNO_API_KEY || '').trim();
        out.sunoDailyLimit = { guest: getSunoDailyLimit('guest'), user: getSunoDailyLimit('user'), admin: getSunoDailyLimit('admin'), superadmin: getSunoDailyLimit('superadmin') };
    }
    // Suno: per-role availability for all users (honors per-user override).
    {
        const role = req.session.user.role;
        const un = req.session.user.username;
        const limit = getSunoDailyLimit(role, un);
        const used = getSunoUsageToday(un);
        out.sunoSelf = {
            available: getSunoEnabled() && !!(process.env.SUNO_API_KEY || '').trim() && limit > 0,
            limit,
            used_today: used,
            remaining: Math.max(0, limit - used),
        };
    }
    // TTS availability for all roles — self values reflect per-user overrides.
    const username = req.session.user.username;
    out.ttsEnabled = getTtsEnabled(username);
    out.ttsAvailable = !!TTS_API_URL;
    out.autoNormalizeUploads = getAutoNormalizeUploads();
    const role = req.session.user.role;
    out.ttsMaxTextLength_self = getTtsMaxTextLength(role, username);
    out.ttsCooldownSec_self = getTtsCooldownSec(role, username);
    // URL streaming: per-role config (superadmin sees full matrix, others get only their own).
    if (req.session.user.role === 'superadmin') {
        out.urlStreamEnabled = { guest: getUrlStreamEnabled('guest'), user: getUrlStreamEnabled('user'), admin: getUrlStreamEnabled('admin'), superadmin: getUrlStreamEnabled('superadmin') };
        out.urlStreamMaxDurationSec = { guest: getUrlStreamMaxDurationSec('guest'), user: getUrlStreamMaxDurationSec('user'), admin: getUrlStreamMaxDurationSec('admin'), superadmin: getUrlStreamMaxDurationSec('superadmin') };
        out.clipEnabled = { guest: getClipEnabled('guest'), user: getClipEnabled('user'), admin: getClipEnabled('admin'), superadmin: getClipEnabled('superadmin') };
        out.playQueueEnabled = { guest: getPlayQueueEnabled('guest'), user: getPlayQueueEnabled('user'), admin: getPlayQueueEnabled('admin'), superadmin: getPlayQueueEnabled('superadmin') };
        out.watchSyncStrategy = getWatchStrategy();
        out.watchSyncStrategies = WATCH_STRATEGIES.slice();
        out.watchPartyEnabled = { guest: getWatchPartyEnabled('guest'), user: getWatchPartyEnabled('user'), admin: getWatchPartyEnabled('admin'), superadmin: getWatchPartyEnabled('superadmin') };
        out.watchCdpTimeoutMs = getWatchCdpTimeoutMs();
        out.watchCaptureResolution = getWatchCaptureResolution();
        out.watchCaptureFramerate = getWatchCaptureFramerate();
        out.watchRoomTtlHours = getWatchRoomTtlHours();
    }
    out.urlStreamEnabled_self = getUrlStreamEnabled(role, username);
    out.urlStreamMaxDurationSec_self = getUrlStreamMaxDurationSec(role, username);
    out.clipEnabled_self = getClipEnabled(role, username);
    out.playQueueEnabled_self = getPlayQueueEnabled(role, username);
    if (role === 'admin' || role === 'user' || role === 'superadmin') {
        out.soundDeleteEnabled_self = getSoundDeleteEnabled(role, username);
    }
    out.absurdCaptchaEnabled_self = role !== 'guest' && getAbsurdCaptchaEnabled(username);
    if (req.session.user.role === 'user' || req.session.user.role === 'guest') {
        if (req.session.user.role === 'guest') {
            out.guestMaxDuration = getGuestMaxDuration();
            out.guestCooldownSec = getGuestCooldownSec();
            out.guestUploadEnabled = getGuestUploadEnabled();
            if (getGuestUploadEnabled()) {
                out.guestMaxUploadDuration = getGuestMaxUploadDuration();
                out.guestMaxUploadBytes = getGuestMaxUploadBytes();
            }
        } else {
            out.userMaxDuration = getUserMaxDuration(username);
            out.userCooldownSec = getUserCooldownSec(username);
            out.userUploadEnabled = getUserUploadEnabled(username);
            if (getUserUploadEnabled(username)) {
                out.userMaxUploadDuration = getUserMaxUploadDuration(username);
                out.userMaxUploadBytes = getUserMaxUploadBytes(username);
            }
        }
    }
    res.json(out);
});

app.patch('/api/settings', requireAdmin, (req, res) => {
    const { playbackLocked, playbackSuperadminOnly, guestEnabled, guestMaxDuration, guestCooldownSec, guestUploadEnabled, guestMaxUploadDuration, guestMaxUploadBytes, userUploadEnabled, userMaxUploadDuration, userMaxUploadBytes, userMaxDuration, userCooldownSec } = req.body;
    const out = {};
    if (typeof playbackLocked === 'boolean') {
        const byRole = req.session.user.role === 'superadmin' ? 'superadmin' : 'admin';
        setPlaybackLocked(playbackLocked, byRole);
        out.playbackLocked = playbackLocked;
    }
    if (req.session.user.role === 'superadmin') {
        if (typeof playbackSuperadminOnly === 'boolean') {
            const meta = loadSoundsMeta();
            setPlaybackSuperadminOnly(meta, playbackSuperadminOnly);
            saveSoundsMeta(meta);
            out.playbackSuperadminOnly = playbackSuperadminOnly;
        }
        if (typeof guestEnabled === 'boolean') { setGuestEnabled(guestEnabled); out.guestEnabled = guestEnabled; }
        if (typeof guestMaxDuration === 'number' && guestMaxDuration > 0) { setGuestMaxDuration(guestMaxDuration); out.guestMaxDuration = guestMaxDuration; }
        if (typeof guestCooldownSec === 'number' && guestCooldownSec >= 0) { setGuestCooldownSec(guestCooldownSec); out.guestCooldownSec = guestCooldownSec; }
        if (typeof guestUploadEnabled === 'boolean') { setGuestUploadEnabled(guestUploadEnabled); out.guestUploadEnabled = guestUploadEnabled; }
        if (typeof guestMaxUploadDuration === 'number' && guestMaxUploadDuration > 0) { setGuestMaxUploadDuration(guestMaxUploadDuration); out.guestMaxUploadDuration = guestMaxUploadDuration; }
        if (typeof guestMaxUploadBytes === 'number' && guestMaxUploadBytes > 0) { setGuestMaxUploadBytes(guestMaxUploadBytes); out.guestMaxUploadBytes = guestMaxUploadBytes; }
        if (typeof userUploadEnabled === 'boolean') { setUserUploadEnabled(userUploadEnabled); out.userUploadEnabled = userUploadEnabled; }
        if (typeof userMaxUploadDuration === 'number' && userMaxUploadDuration > 0) { setUserMaxUploadDuration(userMaxUploadDuration); out.userMaxUploadDuration = userMaxUploadDuration; }
        if (typeof userMaxUploadBytes === 'number' && userMaxUploadBytes > 0) { setUserMaxUploadBytes(userMaxUploadBytes); out.userMaxUploadBytes = userMaxUploadBytes; }
        if (typeof userMaxDuration === 'number' && userMaxDuration > 0) { setUserMaxDuration(userMaxDuration); out.userMaxDuration = userMaxDuration; }
        if (typeof userCooldownSec === 'number' && userCooldownSec >= 0) { setUserCooldownSec(userCooldownSec); out.userCooldownSec = userCooldownSec; }
        if (typeof req.body.autoNormalizeUploads === 'boolean') {
            setAutoNormalizeUploads(req.body.autoNormalizeUploads);
            out.autoNormalizeUploads = getAutoNormalizeUploads();
            statsDb.recordAdminAction({
                actor: req.session.user.username,
                actorRole: req.session.user.role,
                action: 'settings.autoNormalizeUploads',
                target: null,
                details: { enabled: req.body.autoNormalizeUploads === true },
            });
        }
        // TTS settings
        const { ttsEnabled, ttsMaxTextLength, ttsCooldownSec } = req.body;
        if (typeof ttsEnabled === 'boolean') { setTtsEnabled(ttsEnabled); out.ttsEnabled = ttsEnabled; }
        if (ttsMaxTextLength && typeof ttsMaxTextLength === 'object') {
            for (const r of ['guest', 'user', 'admin', 'superadmin']) {
                if (typeof ttsMaxTextLength[r] === 'number' && ttsMaxTextLength[r] >= 0) { setTtsMaxTextLength(r, ttsMaxTextLength[r]); }
            }
            out.ttsMaxTextLength = { guest: getTtsMaxTextLength('guest'), user: getTtsMaxTextLength('user'), admin: getTtsMaxTextLength('admin'), superadmin: getTtsMaxTextLength('superadmin') };
        }
        if (ttsCooldownSec && typeof ttsCooldownSec === 'object') {
            for (const r of ['guest', 'user', 'admin', 'superadmin']) {
                if (typeof ttsCooldownSec[r] === 'number' && ttsCooldownSec[r] >= 0) { setTtsCooldownSec(r, ttsCooldownSec[r]); }
            }
            out.ttsCooldownSec = { guest: getTtsCooldownSec('guest'), user: getTtsCooldownSec('user'), admin: getTtsCooldownSec('admin'), superadmin: getTtsCooldownSec('superadmin') };
        }
        // Voice management
        const { ttsDisabledVoices, ttsVoiceRvcOverrides, ttsMaxQueueSize, ttsPronunciationOverrides } = req.body;
        if (Array.isArray(ttsDisabledVoices)) { setTtsDisabledVoices(ttsDisabledVoices); out.ttsDisabledVoices = getTtsDisabledVoices(); }
        if (ttsVoiceRvcOverrides && typeof ttsVoiceRvcOverrides === 'object' && !Array.isArray(ttsVoiceRvcOverrides)) { setTtsVoiceRvcOverrides(ttsVoiceRvcOverrides); out.ttsVoiceRvcOverrides = getTtsVoiceRvcOverrides(); }
        if (typeof ttsMaxQueueSize === 'number') { setTtsMaxQueueSize(ttsMaxQueueSize); out.ttsMaxQueueSize = getTtsMaxQueueSize(); }
        if (ttsPronunciationOverrides && typeof ttsPronunciationOverrides === 'object' && !Array.isArray(ttsPronunciationOverrides)) {
            out.ttsPronunciationOverrides = setTtsPronunciationOverrides(ttsPronunciationOverrides);
            statsDb.recordAdminAction({
                actor: req.session.user.username,
                actorRole: req.session.user.role,
                action: 'settings.ttsPronunciation',
                target: null,
                details: { count: Object.keys(out.ttsPronunciationOverrides).length },
            });
        }
        // Suno settings
        const { sunoEnabled, sunoDailyLimit } = req.body;
        const sunoChanges = {};
        if (typeof sunoEnabled === 'boolean') { setSunoEnabled(sunoEnabled); out.sunoEnabled = sunoEnabled; sunoChanges.enabled = sunoEnabled; }
        if (sunoDailyLimit && typeof sunoDailyLimit === 'object') {
            const changed = {};
            for (const r of ['guest', 'user', 'admin', 'superadmin']) {
                if (typeof sunoDailyLimit[r] === 'number' && sunoDailyLimit[r] >= 0) {
                    setSunoDailyLimit(r, sunoDailyLimit[r]);
                    changed[r] = sunoDailyLimit[r];
                }
            }
            if (Object.keys(changed).length) sunoChanges.dailyLimit = changed;
            out.sunoDailyLimit = { guest: getSunoDailyLimit('guest'), user: getSunoDailyLimit('user'), admin: getSunoDailyLimit('admin'), superadmin: getSunoDailyLimit('superadmin') };
        }
        if (Object.keys(sunoChanges).length) {
            statsDb.recordAdminAction({
                actor: req.session.user.username,
                actorRole: req.session.user.role,
                action: 'settings.suno',
                target: null,
                details: sunoChanges,
            });
        }
        // URL streaming settings
        const { urlStreamEnabled, urlStreamMaxDurationSec } = req.body;
        if (urlStreamEnabled && typeof urlStreamEnabled === 'object') {
            for (const r of ['guest', 'user', 'admin', 'superadmin']) {
                if (typeof urlStreamEnabled[r] === 'boolean') setUrlStreamEnabled(r, urlStreamEnabled[r]);
            }
            out.urlStreamEnabled = { guest: getUrlStreamEnabled('guest'), user: getUrlStreamEnabled('user'), admin: getUrlStreamEnabled('admin'), superadmin: getUrlStreamEnabled('superadmin') };
        }
        if (urlStreamMaxDurationSec && typeof urlStreamMaxDurationSec === 'object') {
            for (const r of ['guest', 'user', 'admin', 'superadmin']) {
                if (typeof urlStreamMaxDurationSec[r] === 'number' && urlStreamMaxDurationSec[r] >= 0) setUrlStreamMaxDurationSec(r, urlStreamMaxDurationSec[r]);
            }
            out.urlStreamMaxDurationSec = { guest: getUrlStreamMaxDurationSec('guest'), user: getUrlStreamMaxDurationSec('user'), admin: getUrlStreamMaxDurationSec('admin'), superadmin: getUrlStreamMaxDurationSec('superadmin') };
        }
        const { clipEnabled } = req.body;
        if (clipEnabled && typeof clipEnabled === 'object') {
            for (const r of ['guest', 'user', 'admin', 'superadmin']) {
                if (typeof clipEnabled[r] === 'boolean') setClipEnabled(r, clipEnabled[r]);
            }
            out.clipEnabled = { guest: getClipEnabled('guest'), user: getClipEnabled('user'), admin: getClipEnabled('admin'), superadmin: getClipEnabled('superadmin') };
            statsDb.recordAdminAction({
                actor: req.session.user.username,
                actorRole: req.session.user.role,
                action: 'settings.clipEnabled',
                target: null,
                details: out.clipEnabled,
            });
        }
        const { playQueueEnabled } = req.body;
        if (playQueueEnabled && typeof playQueueEnabled === 'object') {
            for (const r of ['guest', 'user', 'admin', 'superadmin']) {
                if (typeof playQueueEnabled[r] === 'boolean') setPlayQueueEnabled(r, playQueueEnabled[r]);
            }
            out.playQueueEnabled = { guest: getPlayQueueEnabled('guest'), user: getPlayQueueEnabled('user'), admin: getPlayQueueEnabled('admin'), superadmin: getPlayQueueEnabled('superadmin') };
            statsDb.recordAdminAction({
                actor: req.session.user.username,
                actorRole: req.session.user.role,
                action: 'settings.playQueueEnabled',
                target: null,
                details: out.playQueueEnabled,
            });
        }
        if (typeof req.body.watchSyncStrategy === 'string') {
            if (setWatchStrategy(req.body.watchSyncStrategy)) {
                out.watchSyncStrategy = getWatchStrategy();
                statsDb.recordAdminAction({
                    actor: req.session.user.username,
                    actorRole: req.session.user.role,
                    action: 'settings.watchSyncStrategy',
                    target: null,
                    details: { strategy: out.watchSyncStrategy },
                });
            }
        }
        const { watchPartyEnabled } = req.body;
        if (watchPartyEnabled && typeof watchPartyEnabled === 'object') {
            for (const r of ['guest', 'user', 'admin', 'superadmin']) {
                if (typeof watchPartyEnabled[r] === 'boolean') setWatchPartyEnabled(r, watchPartyEnabled[r]);
            }
            out.watchPartyEnabled = { guest: getWatchPartyEnabled('guest'), user: getWatchPartyEnabled('user'), admin: getWatchPartyEnabled('admin'), superadmin: getWatchPartyEnabled('superadmin') };
            statsDb.recordAdminAction({
                actor: req.session.user.username,
                actorRole: req.session.user.role,
                action: 'settings.watchPartyEnabled',
                target: null,
                details: out.watchPartyEnabled,
            });
        }
        if (typeof req.body.watchCdpTimeoutMs === 'number') {
            if (setWatchCdpTimeoutMs(req.body.watchCdpTimeoutMs)) out.watchCdpTimeoutMs = getWatchCdpTimeoutMs();
        }
        if (typeof req.body.watchCaptureResolution === 'string') {
            if (setWatchCaptureResolution(req.body.watchCaptureResolution)) out.watchCaptureResolution = getWatchCaptureResolution();
        }
        if (typeof req.body.watchCaptureFramerate === 'number') {
            if (setWatchCaptureFramerate(req.body.watchCaptureFramerate)) out.watchCaptureFramerate = getWatchCaptureFramerate();
        }
        if (typeof req.body.watchRoomTtlHours === 'number') {
            if (setWatchRoomTtlHours(req.body.watchRoomTtlHours)) out.watchRoomTtlHours = getWatchRoomTtlHours();
        }
        const { soundDeleteEnabled } = req.body;
        if (soundDeleteEnabled && typeof soundDeleteEnabled === 'object') {
            for (const r of ['user', 'admin']) {
                if (typeof soundDeleteEnabled[r] === 'boolean') setSoundDeleteRoleDefault(r, soundDeleteEnabled[r]);
            }
            out.soundDeleteEnabled = {
                user: getSoundDeleteRoleDefault('user'),
                admin: getSoundDeleteRoleDefault('admin'),
            };
            statsDb.recordAdminAction({
                actor: req.session.user.username,
                actorRole: req.session.user.role,
                action: 'settings.soundDeleteEnabled',
                target: null,
                details: out.soundDeleteEnabled,
            });
        }
    }
    res.json(Object.keys(out).length ? out : { ok: true });
});

app.get('/api/superadmin/pending-count', requireSuperadmin, (req, res) => {
    const d = loadPendingMeta();
    const uploads = (d.uploads || []).filter(u => fs.existsSync(path.join(PENDING_DIR, u.filename)));
    const pendingSignups = loadPendingUsers();
    res.json({ count: uploads.length, pendingSignupsCount: pendingSignups.length });
});

app.get('/api/superadmin/pending-uploads', requireSuperadmin, (req, res) => {
    const d = loadPendingMeta();
    const uploads = (d.uploads || []).map(u => {
        const filePath = path.join(PENDING_DIR, u.filename);
        return { ...u, exists: fs.existsSync(filePath) };
    }).filter(u => u.exists);
    res.json(uploads);
});

app.post('/api/superadmin/pending-uploads/approve/:filename', requireSuperadmin, (req, res) => {
    const safeFilename = path.basename(req.params.filename || '');
    if (!safeFilename || !/\.(mp3|wav|ogg)$/i.test(safeFilename)) return res.status(400).json({ error: 'Invalid filename' });
    const pendingPath = path.join(PENDING_DIR, safeFilename);
    if (!fs.existsSync(pendingPath)) return res.status(404).json({ error: 'Pending file not found' });
    const ext = path.extname(safeFilename);
    const base = path.basename(safeFilename, ext);
    // Auto-rename on collision so multiple clips imported from the same source
    // (same auto-generated title) don't block each other at approval time.
    const finalFilename = findAvailableSoundName(base, ext, [SOUNDS_DIR]);
    const targetPath = path.join(SOUNDS_DIR, finalFilename);
    try {
        const pendingMeta = (loadPendingMeta().uploads || []).find(u => u.filename === safeFilename) || {};
        fs.renameSync(pendingPath, targetPath);
        const duration = probeDuration(targetPath);
        const metaPatch = {};
        if (duration != null) metaPatch.duration = duration;
        if (pendingMeta.originalName) metaPatch.displayName = pendingMeta.originalName;
        if (Object.keys(metaPatch).length) setSoundMeta(finalFilename, metaPatch);
        removePendingUpload(safeFilename);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'upload.approve',
            target: finalFilename,
            details: { uploader: pendingMeta.uploader || null, renamedFrom: finalFilename !== safeFilename ? safeFilename : undefined },
        });
        res.json({ ok: true, filename: finalFilename, renamedFrom: finalFilename !== safeFilename ? safeFilename : undefined });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to approve' });
    }
});

app.delete('/api/superadmin/pending-uploads/reject/:filename', requireSuperadmin, (req, res) => {
    const safeFilename = path.basename(req.params.filename || '');
    if (!safeFilename || !/\.(mp3|wav|ogg)$/i.test(safeFilename)) return res.status(400).json({ error: 'Invalid filename' });
    const pendingPath = path.join(PENDING_DIR, safeFilename);
    try {
        const pendingMeta = (loadPendingMeta().uploads || []).find(u => u.filename === safeFilename) || {};
        if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
        removePendingUpload(safeFilename);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'upload.reject',
            target: safeFilename,
            details: { uploader: pendingMeta.uploader || null },
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to reject' });
    }
});

app.get('/api/superadmin/pending-signups', requireSuperadmin, (req, res) => {
    const pending = loadPendingUsers();
    res.json(pending.map(p => ({ username: p.username, createdAt: p.createdAt })));
});

app.post('/api/superadmin/pending-signups/approve/:username', requireSuperadmin, (req, res) => {
    const un = String(req.params.username || '').trim().toLowerCase();
    if (!un) return res.status(400).json({ error: 'Username required' });
    const role = (req.body && req.body.role === 'admin') ? 'admin' : 'user';
    const pending = loadPendingUsers();
    const idx = pending.findIndex(p => String(p.username || '').toLowerCase() === un);
    if (idx < 0) return res.status(404).json({ error: 'Pending signup not found' });
    const { password } = pending[idx];
    if (!addApprovedUser(un, password, role)) return res.status(500).json({ error: 'Failed to add user' });
    pending.splice(idx, 1);
    savePendingUsers(pending);
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'signup.approve',
        target: un,
        details: { role },
    });
    res.json({ ok: true, username: un, role });
});

app.post('/api/superadmin/pending-signups/bulk-approve', requireSuperadmin, (req, res) => {
    const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
    const role = (req.body && req.body.role === 'admin') ? 'admin' : 'user';
    const pending = loadPendingUsers();
    const approved = [];
    const failed = [];
    for (const raw of usernames) {
        const un = String(raw || '').trim().toLowerCase();
        if (!un) continue;
        const idx = pending.findIndex(p => String(p.username || '').toLowerCase() === un);
        if (idx < 0) { failed.push({ username: un, reason: 'not found' }); continue; }
        const { password } = pending[idx];
        if (!addApprovedUser(un, password, role)) { failed.push({ username: un, reason: 'add failed' }); continue; }
        pending.splice(idx, 1);
        approved.push(un);
    }
    savePendingUsers(pending);
    if (approved.length) {
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'signup.bulk-approve',
            target: null,
            details: { approved, role, failedCount: failed.length },
        });
    }
    res.json({ approved, failed, role });
});

app.post('/api/superadmin/pending-signups/reject/:username', requireSuperadmin, (req, res) => {
    const un = String(req.params.username || '').trim().toLowerCase();
    if (!un) return res.status(400).json({ error: 'Username required' });
    const pending = loadPendingUsers();
    const idx = pending.findIndex(p => String(p.username || '').toLowerCase() === un);
    if (idx < 0) return res.status(404).json({ error: 'Pending signup not found' });
    pending.splice(idx, 1);
    savePendingUsers(pending);
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'signup.reject',
        target: un,
    });
    res.json({ ok: true });
});

app.get('/api/superadmin/users', requireSuperadmin, (req, res) => {
    const list = [];
    USERS.forEach((u, un) => {
        list.push({ username: un, role: u.role, managed: !envUsernames.has(un), disabled: u.disabled === true });
    });
    list.sort((a, b) => a.username.localeCompare(b.username));
    res.json(list);
});

app.patch('/api/superadmin/users/:username', requireSuperadmin, (req, res) => {
    const un = String(req.params.username || '').trim().toLowerCase();
    if (!un) return res.status(400).json({ error: 'Username required' });
    const body = req.body || {};
    const actor = req.session.user.username;
    const actorRole = req.session.user.role;
    if (body.role !== undefined) {
        const role = body.role === 'admin' ? 'admin' : 'user';
        if (!updateManagedUserRole(un, role)) return res.status(400).json({ error: 'User not found or cannot be modified (env-configured)' });
        statsDb.recordAdminAction({ actor, actorRole, action: 'user.role', target: un, details: { role } });
    }
    if (body.password !== undefined && body.password !== null && body.password !== '') {
        const newPw = String(body.password);
        const forceChange = body.forceChange === true;
        if (!updateManagedUserPassword(un, newPw, forceChange)) return res.status(400).json({ error: 'User not found, env-configured, or password too short (min 6 chars)' });
        statsDb.recordAdminAction({ actor, actorRole, action: 'user.password-reset', target: un, details: { forceChange } });
    }
    if (body.disabled !== undefined) {
        if (!setManagedUserDisabled(un, body.disabled === true)) return res.status(400).json({ error: 'User not found or cannot be modified (env-configured)' });
        statsDb.recordAdminAction({ actor, actorRole, action: body.disabled ? 'user.disable' : 'user.enable', target: un });
        if (body.disabled === true) destroySessionsForUsername(req.sessionStore, un);
    }
    res.json({ ok: true, username: un });
});

app.patch('/api/me/password', requireAuth, (req, res) => {
    if (req.session.user.role === 'guest') return res.status(403).json({ error: 'Guests cannot change password' });
    const { currentPassword, newPassword } = req.body || {};
    const un = (req.session.user.username || '').toLowerCase();
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
    if (!updateOwnPassword(un, String(currentPassword), String(newPassword))) return res.status(400).json({ error: 'Current password incorrect or new password too short (min 6 chars)' });
    req.session.user.mustChangePassword = false;
    res.json({ ok: true });
});

// --- Per-user permission overrides ---------------------------------------
// Return the entire override map + the list of known usernames so the UI
// can render a settings table keyed by user. Role defaults are already
// exposed via /api/settings; this endpoint is purely the "override
// against the role default" layer.
app.get('/api/superadmin/user-overrides', requireSuperadmin, (req, res) => {
    const users = [];
    USERS.forEach((u, un) => {
        users.push({ username: un, role: u.role, managed: !envUsernames.has(un), disabled: u.disabled === true });
    });
    users.sort((a, b) => a.username.localeCompare(b.username));
    res.json({
        users,
        overrides: getAllUserOverrides(),
        fields: USER_OVERRIDE_FIELDS,
    });
});

// Set / clear overrides for a single user. Body is a partial map — include
// only the fields you want to change. Pass `null` / `""` / `undefined` for
// a field to clear it (fall back to role default).
app.put('/api/superadmin/user-overrides/:username', requireSuperadmin, (req, res) => {
    const un = _normalizeUsername(req.params.username);
    if (!un) return res.status(400).json({ error: 'Username required' });
    if (!USERS.has(un)) return res.status(404).json({ error: 'User not found' });
    const body = req.body || {};
    if (!setUserOverrides(un, body)) return res.status(400).json({ error: 'Invalid override payload' });
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'user.overrides.set',
        target: un,
        details: body,
    });
    const all = getAllUserOverrides();
    res.json({ ok: true, username: un, overrides: all[un] || {} });
});

// Clear ALL overrides for a user — faster than sending null for every
// field individually.
app.delete('/api/superadmin/user-overrides/:username', requireSuperadmin, (req, res) => {
    const un = _normalizeUsername(req.params.username);
    if (!un) return res.status(400).json({ error: 'Username required' });
    if (!clearAllUserOverrides(un)) return res.status(404).json({ error: 'No overrides for this user' });
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'user.overrides.clear',
        target: un,
    });
    res.json({ ok: true });
});

// --- Absurd per-user captcha gate -----------------------------------------
// Enabled only through the per-user override map. Solving a challenge issues a
// one-time token that /api/play consumes immediately before starting playback.
const ABSURD_CAPTCHA_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const ABSURD_CAPTCHA_TOKEN_TTL_MS = 75 * 1000;
const ABSURD_CAPTCHA_MIN_SOLVE_MS = 2500;

function _absurdCaptchaRequiredForSession(req) {
    const u = req.session && req.session.user;
    if (!u || u.role === 'guest') return false;
    return getAbsurdCaptchaEnabled(u.username);
}

function _randInt(min, maxInclusive) {
    return crypto.randomInt(min, maxInclusive + 1);
}

function _pick(list) {
    return list[_randInt(0, list.length - 1)];
}

function _reverseText(s) {
    return String(s || '').split('').reverse().join('');
}

function _shuffle(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = _randInt(0, i);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function _buildAbsurdCaptchaChallenge() {
    const id = crypto.randomBytes(12).toString('hex');
    const phrase = _pick([
        'frozen dial tone',
        'taxable confetti',
        'authorized lasagna',
        'printer permission slip',
        'hold music affidavit',
        'certified nonsense',
    ]);
    const fakeCase = `${_pick(['KBG', 'FAX', 'BEEP', 'VOID'])}-${_randInt(100, 999)}-${_randInt(10, 99)}`;
    const shuffledMonths = _shuffle(['April', 'July', 'November', 'Smarch']);
    const variants = [
        () => {
            const word = _pick(['MODEM', 'LASAGNA', 'SPREADSHEET', 'CRANKSHAFT', 'PUDDING', 'FAX']);
            const clicks = _randInt(4, 9);
            const slider = _randInt(17, 83);
            return {
                id,
                title: 'Printer Oracle Checkpoint',
                story: `The printer says "${word}" is suspiciously normal. Prove you are authorized for nonsense.`,
                tasks: [
                    { type: 'clicks', key: 'clicks', label: `Stamp the imaginary form exactly ${clicks} times.`, target: clicks, buttonLabel: 'Stamp form' },
                    { type: 'slider', key: 'slider', label: `Set the compliance dial to ${slider}.`, min: 0, max: 100, target: slider },
                    { type: 'text', key: 'text', label: `Type ${word} backwards.`, placeholder: _reverseText(word) },
                    { type: 'checkbox', key: 'checkbox', label: 'Certify that the printer has no financial authority.' },
                ],
                answer: { clicks, slider, text: _reverseText(word).toLowerCase(), checkbox: true },
            };
        },
        () => {
            const a = _randInt(3, 12);
            const b = _randInt(2, 9);
            const c = _randInt(5, 18);
            const clicks = _randInt(3, 8);
            const slider = (a * b + c) % 101;
            return {
                id,
                title: 'Hold Music Arithmetic',
                story: 'The hold music has escalated to basic accounting. Balance the noise invoice.',
                tasks: [
                    { type: 'clicks', key: 'clicks', label: `Approve ${clicks} fake invoices.`, target: clicks, buttonLabel: 'Approve invoice' },
                    { type: 'slider', key: 'slider', label: `Set the dial to (${a} x ${b}) + ${c}.`, min: 0, max: 100, target: slider },
                    { type: 'text', key: 'text', label: 'Type the ceremonial phrase: let me play the sound', placeholder: 'let me play the sound' },
                    { type: 'select', key: 'select', label: 'Choose the least credible department.', options: _shuffle(['Refund Verification Dungeon', 'Normal Help Desk', 'Billing', 'Support']) },
                ],
                answer: { clicks, slider, text: 'let me play the sound', select: 'Refund Verification Dungeon'.toLowerCase() },
            };
        },
        () => {
            const code = _pick(['BLUE WAFFLE IRON', 'TAXABLE CONFETTI', 'NOISE PERMIT', 'WINDOWLESS BANJO']);
            const clicks = _randInt(5, 11);
            const slider = _randInt(10, 90);
            return {
                id,
                title: 'Department Of Mild Inconvenience',
                story: 'A very official laminated badge is demanding unnecessary ceremony.',
                tasks: [
                    { type: 'clicks', key: 'clicks', label: `Press the tiny approval button ${clicks} times, no more and no less.`, target: clicks, buttonLabel: 'Tiny approval' },
                    { type: 'slider', key: 'slider', label: `Rotate the nonsense dial to ${slider}.`, min: 0, max: 100, target: slider },
                    { type: 'text', key: 'text', label: `Type this permit code in lowercase: ${code}`, placeholder: code.toLowerCase() },
                ],
                answer: { clicks, slider, text: code.toLowerCase() },
            };
        },
        () => {
            const clicks = _randInt(2, 7);
            const lastTwo = Number(fakeCase.slice(-2));
            const target = (lastTwo + 13) % 101;
            return {
                id,
                title: 'Anti-Scam Sound Authorization',
                story: `Case ${fakeCase} has been escalated to the imaginary verification floor.`,
                tasks: [
                    { type: 'select', key: 'select', label: 'Select the official payment method for this sound.', options: _shuffle(['Gift cards in a shoebox', 'No payment method', 'Loose arcade tokens', 'One heroic coupon']) },
                    { type: 'clicks', key: 'clicks', label: `Interrupt the hold music exactly ${clicks} times.`, target: clicks, buttonLabel: 'Interrupt' },
                    { type: 'slider', key: 'slider', label: `Set the case dial to the last two digits of ${fakeCase}, plus 13, wrapping after 100.`, min: 0, max: 100, target },
                    { type: 'text', key: 'text', label: `Type the case code without dashes: ${fakeCase}`, placeholder: fakeCase.replace(/-/g, '') },
                ],
                answer: { select: 'No payment method'.toLowerCase(), clicks, slider: target, text: fakeCase.replace(/-/g, '').toLowerCase() },
            };
        },
        () => {
            const clicks = _randInt(6, 12);
            const slider = _randInt(25, 75);
            const safeWord = _pick(['unplug', 'refund', 'beep', 'receipt']);
            return {
                id,
                title: 'Compliance Clown Car',
                story: 'A fake manager is demanding three forms and one emotional support checkbox.',
                tasks: [
                    { type: 'checkbox', key: 'checkbox', label: 'Confirm you will not read any gift card numbers to the soundboard.' },
                    { type: 'clicks', key: 'clicks', label: `File ${clicks} duplicate complaints with the Department of Sounds.`, target: clicks, buttonLabel: 'File complaint' },
                    { type: 'slider', key: 'slider', label: `Set inconvenience intensity to ${slider}.`, min: 0, max: 100, target: slider },
                    { type: 'text', key: 'text', label: `Type the safe word twice with a space: ${safeWord}`, placeholder: `${safeWord} ${safeWord}` },
                ],
                answer: { checkbox: true, clicks, slider, text: `${safeWord} ${safeWord}` },
            };
        },
        () => {
            const targetMonth = shuffledMonths.indexOf('Smarch') + 1;
            const clicks = _randInt(3, 10);
            return {
                id,
                title: 'Calendar Fraud Prevention',
                story: 'The calendar has invented a month and would like you to respect its privacy.',
                tasks: [
                    { type: 'select', key: 'select', label: 'Which listed month is definitely fake?', options: shuffledMonths },
                    { type: 'clicks', key: 'clicks', label: `Notarize the fake calendar ${clicks} times.`, target: clicks, buttonLabel: 'Notarize' },
                    { type: 'slider', key: 'slider', label: 'Set the month dial to the position of the fake month in the dropdown list.', min: 1, max: 4, target: targetMonth },
                    { type: 'text', key: 'text', label: `Type "${phrase}" in reverse word order.`, placeholder: phrase.split(/\s+/).reverse().join(' ') },
                ],
                answer: { select: 'Smarch'.toLowerCase(), clicks, slider: targetMonth, text: phrase.split(/\s+/).reverse().join(' ').toLowerCase() },
            };
        },
    ];
    return _pick(variants)();
}

function _publicAbsurdCaptcha(challenge) {
    return {
        id: challenge.id,
        title: challenge.title,
        story: challenge.story,
        tasks: challenge.tasks,
        expiresInMs: ABSURD_CAPTCHA_CHALLENGE_TTL_MS,
    };
}

function _consumeAbsurdCaptchaToken(req, safeFilename) {
    if (!_absurdCaptchaRequiredForSession(req)) return { ok: true };
    const token = String(req.body?.absurdCaptchaToken || '');
    const record = req.session.absurdCaptchaToken;
    if (!record || !record.token || record.expiresAt < Date.now()) {
        delete req.session.absurdCaptchaToken;
        return { ok: false, status: 428, body: { error: 'Absurd captcha required.', captchaRequired: true } };
    }
    if (!record.filename || record.filename !== safeFilename) {
        delete req.session.absurdCaptchaToken;
        return { ok: false, status: 428, body: { error: 'Finish the absurd captcha for this sound first.', captchaRequired: true } };
    }
    if (!token || !record.token) {
        return { ok: false, status: 428, body: { error: 'Finish the absurd captcha first.', captchaRequired: true } };
    }
    const a = Buffer.from(String(token), 'utf8');
    const b = Buffer.from(String(record.token), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { ok: false, status: 428, body: { error: 'Finish the absurd captcha first.', captchaRequired: true } };
    }
    delete req.session.absurdCaptchaToken;
    return { ok: true };
}

app.post('/api/absurd-captcha/challenge', requireAuth, (req, res) => {
    if (!_absurdCaptchaRequiredForSession(req)) return res.json({ required: false });
    const safeFilename = path.basename(String(req.body?.filename || ''));
    if (!safeFilename) return res.status(400).json({ error: 'Filename required' });
    const filePath = path.join(SOUNDS_DIR, safeFilename);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(SOUNDS_DIR)) || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Sound not found' });
    const challenge = _buildAbsurdCaptchaChallenge();
    req.session.absurdCaptchaChallenge = {
        id: challenge.id,
        filename: safeFilename,
        answer: challenge.answer,
        createdAt: Date.now(),
        expiresAt: Date.now() + ABSURD_CAPTCHA_CHALLENGE_TTL_MS,
    };
    res.json({ required: true, challenge: _publicAbsurdCaptcha(challenge) });
});

app.post('/api/absurd-captcha/solve', requireAuth, (req, res) => {
    if (!_absurdCaptchaRequiredForSession(req)) return res.json({ ok: true, required: false, token: null });
    const record = req.session.absurdCaptchaChallenge;
    const body = req.body || {};
    if (!record || record.expiresAt < Date.now()) {
        delete req.session.absurdCaptchaChallenge;
        return res.status(400).json({ error: 'That captcha expired. Generate a new one.' });
    }
    if (Date.now() - Number(record.createdAt || 0) < ABSURD_CAPTCHA_MIN_SOLVE_MS) {
        return res.status(429).json({ error: 'That was suspiciously fast. Let the paperwork breathe for a second.' });
    }
    if (String(body.id || '') !== record.id) return res.status(400).json({ error: 'Captcha mismatch. Generate a new one.' });
    const submitted = body.answer && typeof body.answer === 'object' ? body.answer : {};
    const expected = record.answer || {};
    for (const [key, expectedValue] of Object.entries(expected)) {
        const got = submitted[key];
        if (typeof expectedValue === 'number') {
            if (Number(got) !== expectedValue) return res.status(400).json({ error: 'One of the numeric rituals is wrong.' });
        } else if (typeof expectedValue === 'boolean') {
            if ((got === true || got === 'true') !== expectedValue) return res.status(400).json({ error: 'The required certification is missing.' });
        } else if (String(got || '').trim().toLowerCase() !== String(expectedValue).trim().toLowerCase()) {
            return res.status(400).json({ error: 'The ceremonial text or selection is incorrect.' });
        }
    }
    const token = crypto.randomBytes(18).toString('hex');
    req.session.absurdCaptchaToken = { token, filename: record.filename, expiresAt: Date.now() + ABSURD_CAPTCHA_TOKEN_TTL_MS };
    delete req.session.absurdCaptchaChallenge;
    res.json({ ok: true, token, expiresInMs: ABSURD_CAPTCHA_TOKEN_TTL_MS });
});

app.delete('/api/superadmin/users/:username', requireSuperadmin, (req, res) => {
    const un = String(req.params.username || '').trim().toLowerCase();
    if (!un) return res.status(400).json({ error: 'Username required' });
    if (!removeManagedUser(un)) return res.status(400).json({ error: 'User not found or cannot be removed (env-configured)' });
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'user.delete',
        target: un,
    });
    res.json({ ok: true });
});

// --- Entrance / exit sounds ---
app.get('/api/me/entrance-exit', requireAuth, (req, res) => {
    if (req.session.user.role === 'guest') return res.status(403).json({ error: 'Guests not supported' });
    const un = (req.session.user.username || '').toLowerCase();
    const link = getDiscordLinkForUser(un) || { discordId: null, entranceSound: null, exitSound: null, disabled: false };
    res.json({
        globalEnabled: getDiscordLinkGlobalEnabled(),
        entranceExitEnabled: getDiscordLinkEntranceExitEnabled(),
        discordId: link.discordId || null,
        entranceSound: link.entranceSound || null,
        exitSound: link.exitSound || null,
        disabled: link.disabled === true,
    });
});

app.patch('/api/me/entrance-exit', requireAuth, (req, res) => {
    if (req.session.user.role === 'guest') return res.status(403).json({ error: 'Guests not supported' });
    const un = (req.session.user.username || '').toLowerCase();
    const link = getDiscordLinkForUser(un);
    if (!link || !link.discordId) return res.status(400).json({ error: 'Your account is not linked to a Discord user. Ask a superadmin.' });
    const body = req.body || {};
    const patch = {};
    if ('entranceSound' in body) patch.entranceSound = body.entranceSound || null;
    if ('exitSound' in body) patch.exitSound = body.exitSound || null;
    setDiscordLinkForUser(un, patch);
    const updated = getDiscordLinkForUser(un);
    res.json({ ok: true, entranceSound: updated.entranceSound, exitSound: updated.exitSound });
});

app.get('/api/superadmin/entrance-exit', requireSuperadmin, (req, res) => {
    const d = loadDiscordLinks();
    const list = [];
    USERS.forEach((u, un) => {
        const l = d.users[un] || {};
        list.push({
            username: un,
            role: u.role,
            discordId: l.discordId || null,
            entranceSound: l.entranceSound || null,
            exitSound: l.exitSound || null,
            disabled: l.disabled === true,
        });
    });
    list.sort((a, b) => a.username.localeCompare(b.username));
    res.json({
        globalEnabled: d.globalEnabled === true,
        entranceExitEnabled: d.entranceExitEnabled !== false,
        users: list,
    });
});

app.patch('/api/superadmin/entrance-exit-config', requireSuperadmin, (req, res) => {
    const body = req.body || {};
    const details = {};
    if ('globalEnabled' in body) {
        setDiscordLinkGlobalEnabled(body.globalEnabled === true);
        details.globalEnabled = body.globalEnabled === true;
    }
    if ('entranceExitEnabled' in body) {
        setDiscordLinkEntranceExitEnabled(body.entranceExitEnabled !== false);
        details.entranceExitEnabled = body.entranceExitEnabled !== false;
    }
    if (Object.keys(details).length) {
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'discord-linking.config',
            target: null,
            details,
        });
    }
    res.json({
        ok: true,
        globalEnabled: getDiscordLinkGlobalEnabled(),
        entranceExitEnabled: getDiscordLinkEntranceExitEnabled(),
    });
});

app.patch('/api/superadmin/entrance-exit/:username', requireSuperadmin, (req, res) => {
    const un = String(req.params.username || '').trim().toLowerCase();
    if (!un || !USERS.has(un)) return res.status(400).json({ error: 'Unknown user' });
    const body = req.body || {};
    const patch = {};
    if ('discordId' in body) {
        const id = body.discordId ? String(body.discordId).trim() : null;
        if (id && !/^\d{5,32}$/.test(id)) return res.status(400).json({ error: 'Discord ID must be a numeric snowflake' });
        if (id) {
            const existing = findUsernameByDiscordId(id);
            if (existing && existing !== un) return res.status(400).json({ error: `Discord ID already linked to ${existing}` });
        }
        patch.discordId = id;
    }
    if ('entranceSound' in body) patch.entranceSound = body.entranceSound || null;
    if ('exitSound' in body) patch.exitSound = body.exitSound || null;
    if ('disabled' in body) patch.disabled = body.disabled === true;
    setDiscordLinkForUser(un, patch);
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'entrance-exit.user-update',
        target: un,
        details: patch,
    });
    const updated = getDiscordLinkForUser(un);
    res.json({ ok: true, username: un, ...updated });
});

// List Discord users currently visible to the bot (members in any voice channel of the active guild).
// This avoids needing the privileged GuildMembers intent.
app.get('/api/superadmin/discord-members', requireSuperadmin, (req, res) => {
    const out = [];
    try {
        if (!activeGuildId) return res.json({ members: [], note: 'Bot not connected to a guild.' });
        const guild = client.guilds.cache.get(activeGuildId);
        if (!guild) return res.json({ members: [], note: 'Guild not in cache.' });
        const seen = new Set();
        for (const [, vs] of guild.voiceStates.cache) {
            if (!vs.member || seen.has(vs.id)) continue;
            seen.add(vs.id);
            out.push({
                id: vs.id,
                username: vs.member.user?.username || null,
                displayName: vs.member.displayName || vs.member.user?.username || null,
                channelId: vs.channelId,
                channelName: vs.channel?.name || null,
            });
        }
        out.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')));
        res.json({ members: out });
    } catch (err) {
        console.error('[discord-members] error', err);
        res.status(500).json({ members: [], error: err.message });
    }
});

// --- Voice triggers (keyword → sound) ---
app.get('/api/superadmin/voice-triggers', requireSuperadmin, (req, res) => {
    res.json({
        enabled: getVoiceTriggersEnabled(),
        globalCooldownSec: getVoiceTriggersGlobalCooldownSec(),
        autoClipSec: getVoiceTriggersAutoClipSec(),
        wakeWord: getVoiceTriggersWakeWord(),
        modelReady: voiceTriggerModelReady(),
        triggers: loadVoiceTriggers(),
    });
});

app.patch('/api/superadmin/voice-triggers/config', requireSuperadmin, (req, res) => {
    const body = req.body || {};
    const details = {};
    if ('enabled' in body) {
        const next = body.enabled === true;
        setVoiceTriggersEnabled(next);
        if (next) startVoiceTriggerCapture(); else stopVoiceTriggerCapture();
        details.enabled = next;
    }
    if ('globalCooldownSec' in body) {
        setVoiceTriggersGlobalCooldownSec(body.globalCooldownSec);
        details.globalCooldownSec = getVoiceTriggersGlobalCooldownSec();
    }
    if ('autoClipSec' in body) {
        setVoiceTriggersAutoClipSec(body.autoClipSec);
        details.autoClipSec = getVoiceTriggersAutoClipSec();
    }
    if ('wakeWord' in body) {
        setVoiceTriggersWakeWord(body.wakeWord);
        details.wakeWord = getVoiceTriggersWakeWord();
    }
    if (Object.keys(details).length) {
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'voice-triggers.config',
            target: null,
            details,
        });
    }
    res.json({
        ok: true,
        enabled: getVoiceTriggersEnabled(),
        globalCooldownSec: getVoiceTriggersGlobalCooldownSec(),
        modelReady: voiceTriggerModelReady(),
    });
});

app.post('/api/superadmin/voice-triggers', requireSuperadmin, (req, res) => {
    const body = req.body || {};
    const phrase = normalizeTriggerPhrase(body.phrase);
    if (!phrase) return res.status(400).json({ error: 'Phrase is required' });
    if (phrase.length > 64) return res.status(400).json({ error: 'Phrase too long (max 64 chars)' });
    if (!/^[a-z0-9' ]+$/.test(phrase)) return res.status(400).json({ error: 'Phrase must be lowercase letters, numbers, spaces, or apostrophes' });
    const soundFilename = body.soundFilename ? path.basename(String(body.soundFilename)) : null;
    if (!soundFilename) return res.status(400).json({ error: 'soundFilename is required' });
    if (!fs.existsSync(path.join(SOUNDS_DIR, soundFilename))) return res.status(400).json({ error: 'Sound file not found' });
    const cooldownSec = Math.max(0, Math.min(3600, Number(body.cooldownSec) || 5));
    const speakerUserId = body.speakerUserId ? String(body.speakerUserId).trim() : null;
    if (speakerUserId && !/^\d{5,32}$/.test(speakerUserId)) return res.status(400).json({ error: 'speakerUserId must be a Discord snowflake or null' });
    const list = loadVoiceTriggers();
    const item = {
        id: makeTriggerId(),
        phrase,
        soundFilename,
        cooldownSec,
        enabled: body.enabled !== false,
        speakerUserId: speakerUserId || null,
        createdBy: req.session.user.username,
        createdAt: Date.now(),
    };
    list.push(item);
    saveVoiceTriggers(list);
    rebuildVoiceTriggerGrammar();
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'voice-triggers.create',
        target: item.id,
        details: { phrase, soundFilename, cooldownSec, speakerUserId },
    });
    res.json({ ok: true, trigger: item });
});

app.patch('/api/superadmin/voice-triggers/:id', requireSuperadmin, (req, res) => {
    const id = String(req.params.id || '');
    const list = loadVoiceTriggers();
    const idx = list.findIndex(t => t.id === id);
    if (idx < 0) return res.status(404).json({ error: 'Trigger not found' });
    const body = req.body || {};
    const patch = {};
    if ('phrase' in body) {
        const phrase = normalizeTriggerPhrase(body.phrase);
        if (!phrase) return res.status(400).json({ error: 'Phrase is required' });
        if (phrase.length > 64) return res.status(400).json({ error: 'Phrase too long' });
        if (!/^[a-z0-9' ]+$/.test(phrase)) return res.status(400).json({ error: 'Phrase must be lowercase letters, numbers, spaces, or apostrophes' });
        patch.phrase = phrase;
    }
    if ('soundFilename' in body) {
        const f = body.soundFilename ? path.basename(String(body.soundFilename)) : null;
        if (!f) return res.status(400).json({ error: 'soundFilename is required' });
        if (!fs.existsSync(path.join(SOUNDS_DIR, f))) return res.status(400).json({ error: 'Sound file not found' });
        patch.soundFilename = f;
    }
    if ('cooldownSec' in body) patch.cooldownSec = Math.max(0, Math.min(3600, Number(body.cooldownSec) || 0));
    if ('enabled' in body) patch.enabled = body.enabled === true;
    if ('speakerUserId' in body) {
        const id2 = body.speakerUserId ? String(body.speakerUserId).trim() : null;
        if (id2 && !/^\d{5,32}$/.test(id2)) return res.status(400).json({ error: 'speakerUserId must be a Discord snowflake or null' });
        patch.speakerUserId = id2 || null;
    }
    list[idx] = { ...list[idx], ...patch };
    saveVoiceTriggers(list);
    rebuildVoiceTriggerGrammar();
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'voice-triggers.update',
        target: id,
        details: patch,
    });
    res.json({ ok: true, trigger: list[idx] });
});

app.get('/api/superadmin/voice-triggers/log', requireSuperadmin, (req, res) => {
    // Decorate each event with current display info (sound display name + speaker
    // display name when the speaker is currently in a guild voice channel the
    // bot can see). The raw IDs are still returned so the UI can fall back.
    const meta = loadSoundsMeta();
    const memberNameById = new Map();
    try {
        if (activeGuildId) {
            const guild = client.guilds.cache.get(activeGuildId);
            if (guild) {
                for (const [, vs] of guild.voiceStates.cache) {
                    if (vs.member) memberNameById.set(vs.id, vs.member.displayName || vs.member.user?.username || vs.id);
                }
            }
        }
    } catch {}
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const events = statsDb.listVoiceTriggerEvents(limit).map(ev => ({
        ...ev,
        soundDisplayName: ev.soundFilename ? getDisplayName(meta, ev.soundFilename) : null,
        speakerDisplayName: memberNameById.get(ev.speakerUserId) || null,
    }));
    res.json({ events, max: limit });
});

app.delete('/api/superadmin/voice-triggers/:id', requireSuperadmin, (req, res) => {
    const id = String(req.params.id || '');
    const list = loadVoiceTriggers();
    const idx = list.findIndex(t => t.id === id);
    if (idx < 0) return res.status(404).json({ error: 'Trigger not found' });
    const removed = list.splice(idx, 1)[0];
    saveVoiceTriggers(list);
    rebuildVoiceTriggerGrammar();
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'voice-triggers.delete',
        target: id,
        details: { phrase: removed.phrase },
    });
    res.json({ ok: true });
});

// --- Voting (kick / timeout via slash commands) ---
app.get('/api/superadmin/voting', requireSuperadmin, (req, res) => {
    const cfg = getVotingConfig();
    const roles = [];
    try {
        if (activeGuildId) {
            const guild = client.guilds.cache.get(activeGuildId);
            if (guild) {
                guild.roles.cache.forEach(r => {
                    if (r.id !== guild.id) roles.push({ id: r.id, name: r.name, color: r.color, position: r.position });
                });
                roles.sort((a, b) => b.position - a.position);
            }
        }
    } catch {}
    const activeVotesCount = activeVotes ? activeVotes.size : 0;
    res.json({ ...cfg, roles, activeVotesCount });
});

app.patch('/api/superadmin/voting', requireSuperadmin, (req, res) => {
    const body = req.body || {};
    const patch = {};
    for (const key of ['enabled', 'thresholdPct', 'windowSec', 'minVoters', 'targetCooldownSec', 'maxTimeoutMinutes']) {
        if (key in body) patch[key] = body[key];
    }
    if (Array.isArray(body.immuneRoleIds)) patch.immuneRoleIds = body.immuneRoleIds;
    const next = setVotingConfig(patch);
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'voting.config',
        target: null,
        details: patch,
    });
    res.json({ ok: true, ...next });
});

app.get('/api/superadmin/voting/log', requireSuperadmin, (req, res) => {
    const memberNameById = new Map();
    try {
        if (activeGuildId) {
            const guild = client.guilds.cache.get(activeGuildId);
            if (guild) {
                for (const [, vs] of guild.voiceStates.cache) {
                    if (vs.member) memberNameById.set(vs.id, vs.member.displayName || vs.member.user?.username || vs.id);
                }
            }
        }
    } catch {}
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const events = statsDb.listVoteEvents(limit).map(ev => ({
        ...ev,
        targetDisplayName: memberNameById.get(ev.targetUserId) || ev.targetDisplayName || ev.targetUsername || null,
        initiatorDisplayName: memberNameById.get(ev.initiatorUserId) || ev.initiatorDisplayName || ev.initiatorUsername || null,
    }));
    res.json({ events, max: limit });
});

app.get('/api/superadmin/pending-uploads/audio/:filename', requireSuperadmin, (req, res) => {
    const safeFilename = path.basename(req.params.filename || '');
    if (!safeFilename || !/\.(mp3|wav|ogg)$/i.test(safeFilename)) return res.status(400).send('Invalid file');
    const filePath = path.join(PENDING_DIR, safeFilename);
    if (!path.resolve(filePath).startsWith(path.resolve(PENDING_DIR)) || !fs.existsSync(filePath)) return res.status(404).send('Not found');
    const ext = path.extname(safeFilename).toLowerCase();
    const mime = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' }[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    fs.createReadStream(filePath).pipe(res);
});

app.get('/api/guest/history', requireSuperadmin, (req, res) => {
    const d = loadGuestData();
    const history = Array.isArray(d.history) ? d.history : [];
    res.json(history.slice().reverse());
});

app.get('/api/guest/blocked', requireSuperadmin, (req, res) => {
    const d = loadGuestData();
    res.json(Array.isArray(d.blockedIPs) ? d.blockedIPs : []);
});

app.post('/api/guest/block-ip', requireSuperadmin, (req, res) => {
    const { ip } = req.body;
    const s = (ip != null ? String(ip) : '').trim();
    if (!s) return res.status(400).json({ error: 'IP required' });
    blockIP(s);
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'ip.block',
        target: s,
    });
    res.json({ ok: true, blocked: s });
});

app.delete('/api/guest/block-ip/:ip', requireSuperadmin, (req, res) => {
    const ip = decodeURIComponent(req.params.ip || '').trim();
    if (!ip) return res.status(400).json({ error: 'IP required' });
    unblockIP(ip);
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'ip.unblock',
        target: ip,
    });
    res.json({ ok: true });
});

function parseIpList(raw) {
    if (Array.isArray(raw)) {
        return raw.map(x => String(x).trim()).filter(Boolean);
    }
    if (typeof raw === 'string') {
        return raw.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    }
    return [];
}

app.post('/api/guest/block-ip/bulk', requireSuperadmin, (req, res) => {
    const ips = parseIpList(req.body?.ips);
    if (!ips.length) return res.status(400).json({ error: 'No IPs provided' });
    const blocked = [];
    for (const ip of ips) {
        if (!isIPBlocked(ip)) {
            blockIP(ip);
            blocked.push(ip);
        }
    }
    if (blocked.length) {
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'ip.bulk-block',
            target: null,
            details: { blocked, total: ips.length },
        });
    }
    res.json({ blocked, skipped: ips.length - blocked.length });
});

app.post('/api/guest/unblock-ip/bulk', requireSuperadmin, (req, res) => {
    const ips = parseIpList(req.body?.ips);
    if (!ips.length) return res.status(400).json({ error: 'No IPs provided' });
    const unblocked = [];
    for (const ip of ips) {
        if (isIPBlocked(ip)) {
            unblockIP(ip);
            unblocked.push(ip);
        }
    }
    if (unblocked.length) {
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'ip.bulk-unblock',
            target: null,
            details: { unblocked, total: ips.length },
        });
    }
    res.json({ unblocked, skipped: ips.length - unblocked.length });
});

app.get('/api/guest/cooldown-overrides', requireSuperadmin, (req, res) => {
    res.json(getCooldownOverrides());
});

app.put('/api/guest/cooldown-override', requireSuperadmin, (req, res) => {
    const { ip, cooldownSec } = req.body || {};
    const key = (ip != null ? String(ip) : '').trim();
    if (!key) return res.status(400).json({ error: 'IP required' });
    if (!setCooldownOverride(key, cooldownSec)) return res.status(400).json({ error: 'Invalid cooldown value' });
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'ip.cooldown-override.set',
        target: key,
        details: { cooldownSec: Number(cooldownSec) },
    });
    res.json({ ok: true, ip: key, cooldownSec: Number(cooldownSec) });
});

app.delete('/api/guest/cooldown-override/:ip', requireSuperadmin, (req, res) => {
    const ip = decodeURIComponent(req.params.ip || '').trim();
    if (!ip) return res.status(400).json({ error: 'IP required' });
    if (!deleteCooldownOverride(ip)) return res.status(404).json({ error: 'Override not found' });
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'ip.cooldown-override.clear',
        target: ip,
    });
    res.json({ ok: true });
});

function uploadHandler(req, res, next) {
    const role = req.session?.user?.role;
    const un = req.session?.user?.username;
    const isAdminOrSuper = role === 'admin' || role === 'superadmin';
    const canDirectUpload = isAdminOrSuper;
    const canGuestPendingUpload = role === 'guest' && getGuestUploadEnabled();
    const canUserPendingUpload = role === 'user' && getUserUploadEnabled(un);
    const canPendingUpload = canGuestPendingUpload || canUserPendingUpload;
    if (!canDirectUpload && !canPendingUpload) return res.status(403).json({ error: 'Upload not allowed for your role.' });
    upload.single('soundFile')(req, res, (err) => {
        if (err) return res.status(500).json({ error: err.message || 'Upload failed' });
        if (!req.file) return res.status(400).json({ error: 'No file received' });
        req._uploadMode = canDirectUpload ? 'direct' : 'pending';
        next();
    });
}

app.post('/api/upload', requireAuth, uploadHandler, (req, res) => {
    const tempPath = req.file.path;
    const origName = (req.file.originalname || 'sound').trim();
    let safeName = path.basename(origName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'sound';
    if (!/\.(mp3|wav|ogg)$/i.test(safeName)) safeName += '.mp3';

    const mode = req._uploadMode;
    const role = req.session.user.role;
    const uploadedBy = role === 'guest' ? `guest:${getClientIP(req)}` : req.session.user.username;
    const uploadedByRole = role;
    const uploadedByIP = role === 'guest' ? getClientIP(req) : null;

    // Normalization runs by default but the caller can opt out with
    // skipNormalize=1 on the form, and the global toggle disables it entirely.
    const skipNormalize = String(req.body?.skipNormalize || '').toLowerCase();
    const callerSkipped = skipNormalize === '1' || skipNormalize === 'true' || skipNormalize === 'on';
    const shouldNormalize = getAutoNormalizeUploads() && !callerSkipped;

    const finalizeWithNormalize = (finalPath, afterCb) => {
        if (!shouldNormalize) return afterCb(null);
        normalizeFileInPlace(finalPath, (err) => {
            // Normalization is best-effort — log but don't block the upload.
            if (err) console.warn('[upload.normalize] failed for', finalPath, err.message);
            afterCb(null);
        });
    };

    if (mode === 'direct') {
        // Don't silently overwrite an existing sound — POSIX rename would clobber
        // it irreversibly while the old filename-keyed metadata (tags/trim) stays
        // attached to the new audio. Pick the next free name instead, matching the
        // pending path's behavior.
        if (fs.existsSync(path.join(SOUNDS_DIR, safeName))) {
            const dExt = path.extname(safeName);
            safeName = findAvailableSoundName(path.basename(safeName, dExt), dExt, [SOUNDS_DIR, PENDING_DIR]);
        }
        const targetPath = path.join(SOUNDS_DIR, safeName);
        const resolvedPath = path.resolve(targetPath);
        if (!resolvedPath.startsWith(path.resolve(SOUNDS_DIR))) return res.status(403).json({ error: 'Invalid filename' });
        fs.rename(tempPath, targetPath, (err) => {
            if (err) return res.status(500).json({ error: 'Error saving file' });
            finalizeWithNormalize(targetPath, () => {
                const duration = probeDuration(targetPath);
                if (duration != null) setSoundMeta(safeName, { duration });
                res.json({ ok: true, message: 'File uploaded!', pending: false, normalized: shouldNormalize });
            });
        });
        return;
    }

    const uploadExt = path.extname(safeName);
    const uploadBase = path.basename(safeName, uploadExt);
    safeName = findAvailableSoundName(uploadBase, uploadExt, [SOUNDS_DIR, PENDING_DIR]);
    let targetPath = path.join(PENDING_DIR, safeName);
    const resolvedPath = path.resolve(targetPath);
    if (!resolvedPath.startsWith(path.resolve(PENDING_DIR))) return res.status(403).json({ error: 'Invalid filename' });

    const stat = fs.statSync(tempPath);
    const size = stat.size;
    const un2 = req.session?.user?.username;
    const maxBytes = role === 'guest' ? getGuestMaxUploadBytes() : getUserMaxUploadBytes(un2);
    if (size > maxBytes) {
        fs.unlink(tempPath, () => {});
        return res.status(400).json({ error: `File too large. Max ${Math.round(maxBytes / 1024)}KB.` });
    }

    fs.rename(tempPath, targetPath, (err) => {
        if (err) return res.status(500).json({ error: 'Error saving file' });
        const duration = probeDuration(targetPath);
        const maxDur = role === 'guest' ? getGuestMaxUploadDuration() : getUserMaxUploadDuration(un2);
        if (duration != null && duration > maxDur) {
            fs.unlinkSync(targetPath);
            return res.status(400).json({ error: `File too long. Max ${maxDur} seconds. This file is ${Math.ceil(duration)}s.` });
        }
        finalizeWithNormalize(targetPath, () => {
            // Re-stat after possible normalize (file contents change).
            let finalSize = size;
            try { finalSize = fs.statSync(targetPath).size; } catch {}
            addPendingUpload(safeName, {
                uploadedBy,
                uploadedByRole,
                uploadedByIP,
                uploadedAt: Date.now(),
                duration: duration ?? null,
                size: finalSize,
                originalName: origName,
            });
            res.json({ ok: true, message: 'Upload sent for moderation. A superadmin will review it.', pending: true, normalized: shouldNormalize });
        });
    });
});

// Play a sound on behalf of a linked user (entrance/exit). Reuses the single/multi-play
// code paths and honors role hierarchy — a lower-role entrance sound is silently skipped
// if a higher role is currently playing, same as a manual /api/play would be.
async function playSoundAsLinkedUser(filename, startedBy) {
    try {
        if (!filename || !startedBy || !startedBy.username || !startedBy.role) return { ok: false, reason: 'bad-args' };
        const safeFilename = path.basename(filename);
        const filePath = path.join(SOUNDS_DIR, safeFilename);
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(path.resolve(SOUNDS_DIR))) return { ok: false, reason: 'invalid-path' };
        if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing-file' };
        if (!activeGuildId || !getVoiceConnection(activeGuildId)) return { ok: false, reason: 'no-voice' };

        const meta = loadSoundsMeta();
        let duration = getDuration(meta, safeFilename);
        if (duration == null) {
            duration = await probeDurationAsync(filePath);
            if (duration != null) setSoundMeta(safeFilename, { duration });
        }
        const displayName = getDisplayName(meta, safeFilename);
        const role = startedBy.role;

        if (getPlaybackSuperadminOnly(meta) && role !== 'superadmin') return { ok: false, reason: 'superadmin-only' };
        if (getPlaybackLocked(meta)) {
            const lockedBy = getPlaybackLockedBy(meta);
            if (lockedBy === 'superadmin') return { ok: false, reason: 'locked' };
            if (role === 'user') return { ok: false, reason: 'locked' };
        }

        const currentStatus = player.state.status;
        const isSomeonePlaying = currentStatus === AudioPlayerStatus.Playing || currentStatus === AudioPlayerStatus.Paused || currentStatus === AudioPlayerStatus.Buffering || currentStatus === AudioPlayerStatus.AutoPaused;
        const startedByRole = playbackState.startedBy?.role;

        if (!multiPlayEnabled && isSomeonePlaying) {
            if ((startedByRole === 'admin' || startedByRole === 'superadmin') && role === 'user') return { ok: false, reason: 'lower-role' };
            if (startedByRole === 'superadmin' && role === 'admin') return { ok: false, reason: 'lower-role' };
        }
        if (multiPlayEnabled && isSomeonePlaying) {
            let highestActiveRole = startedByRole;
            for (const [, t] of activeTracks) {
                if (t.startedBy?.role === 'superadmin') { highestActiveRole = 'superadmin'; break; }
                if (t.startedBy?.role === 'admin' && highestActiveRole !== 'superadmin') highestActiveRole = 'admin';
            }
            if ((highestActiveRole === 'admin' || highestActiveRole === 'superadmin') && role === 'user') return { ok: false, reason: 'lower-role' };
            if (highestActiveRole === 'superadmin' && role === 'admin') return { ok: false, reason: 'lower-role' };
        }

        const metaStart = getSoundStartTime(meta, safeFilename);
        const metaEnd = getSoundEndTime(meta, safeFilename);
        const metaVolume = getSoundVolume(meta, safeFilename);
        const soundStopOthers = getSoundStopOthers(meta, safeFilename);
        const startTime = metaStart != null ? metaStart : 0;
        const maxEnd = metaEnd != null ? metaEnd : (duration != null ? duration : 999999);
        if (startTime >= maxEnd) return { ok: false, reason: 'bad-trim' };
        const endTime = metaEnd != null && metaEnd > startTime ? metaEnd : null;
        const playDuration = endTime != null ? endTime - startTime : null;
        const volMult = metaVolume != null ? metaVolume : 1;
        const effectiveVolume = Math.max(0, Math.min(2, currentVolume * volMult));

        const conn = getVoiceConnection(activeGuildId);
        if (conn && conn.state?.status !== 'ready') {
            try { await entersState(conn, VoiceConnectionStatus.Ready, 15_000); }
            catch { return { ok: false, reason: 'voice-not-ready' }; }
        }

        const effectivePlayDuration = playDuration != null ? playDuration : duration;
        const plannedDurationMs = effectivePlayDuration != null ? Math.round(effectivePlayDuration * 1000) : null;
        const newPlayId = statsDb.recordPlayStart({
            filename: safeFilename,
            displayName,
            userId: startedBy.username,
            userRole: role,
            guestIp: null,
            plannedDurationMs,
        });

        if (multiPlayEnabled) {
            const ffArgs = ['-nostdin'];
            if (startTime > 0) ffArgs.push('-ss', String(startTime));
            ffArgs.push('-i', filePath);
            if (playDuration != null && playDuration > 0) ffArgs.push('-t', String(playDuration));
            ffArgs.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-af', `volume=${volMult}`, '-');
            const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
            ff.stderr.on('data', () => {});
            ff.on('error', (err) => console.error('ffmpeg multi-play error', err));

            if (soundStopOthers || !isSomeonePlaying) {
                finalizeAllOpenPlays(true);
                if (activeMixer) { activeMixer.removeAllTracks(); activeMixer.destroy(); activeMixer = null; }
                activeTracks.clear();
                player.stop();
            }
            if (!activeMixer || activeMixer.destroyed) {
                activeMixer = new AudioMixer();
                const resource = createAudioResource(activeMixer, { inputType: StreamType.Raw, inlineVolume: true });
                resource.volume.setVolume(currentVolume);
                player.play(resource);
            }
            const trackId = activeMixer.addTrack(ff.stdout, { filename: safeFilename, displayName }, ff, { priority: !!(startedBy && startedBy.priority) });
            activeTracks.set(trackId, {
                filename: safeFilename, displayName,
                startTime: Date.now(), startTimeOffset: startTime,
                duration: effectivePlayDuration, startedBy, playId: newPlayId,
            });
            ff.on('close', () => {
                const track = activeTracks.get(trackId);
                if (track && track.playId != null) {
                    const elapsedMs = Date.now() - track.startTime;
                    const plannedMs = track.duration != null ? track.duration * 1000 : null;
                    const stoppedEarly = plannedMs != null && elapsedMs < plannedMs - 250;
                    statsDb.recordPlayEnd(track.playId, { stoppedEarly });
                    track.playId = null;
                }
            });
            playbackState = {
                status: 'playing', filename: safeFilename, displayName,
                startTime: Date.now(), startTimeOffset: startTime,
                duration: effectivePlayDuration, startedBy,
            };
        } else {
            if (currentSinglePlayId != null) {
                statsDb.recordPlayEnd(currentSinglePlayId, { stoppedEarly: true });
                currentSinglePlayId = null;
            }
            let stream;
            const needsFfmpeg = startTime > 0 || playDuration != null;
            if (needsFfmpeg) {
                const args = ['-nostdin'];
                if (startTime > 0) args.push('-ss', String(startTime));
                args.push('-i', filePath);
                if (playDuration != null && playDuration > 0) args.push('-t', String(playDuration));
                args.push('-f', 'mp3', '-');
                const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
                stream = ff.stdout;
                ff.stderr.on('data', () => {});
                ff.on('error', (err) => console.error('ffmpeg spawn error', err));
            } else {
                stream = fs.createReadStream(filePath);
            }
            const resource = createAudioResource(stream, {
                inputType: StreamType.Arbitrary, inlineVolume: true,
                metadata: { filename: safeFilename, displayName },
            });
            resource.volume.setVolume(effectiveVolume);
            player.play(resource);
            currentSinglePlayId = newPlayId;
            playbackState = {
                status: 'playing', filename: safeFilename, displayName,
                startTime: Date.now(), startTimeOffset: startTime,
                duration: effectivePlayDuration, startedBy,
            };
        }
        addToRecentlyPlayedServer(safeFilename, displayName, startedBy.username, Date.now());
        return { ok: true };
    } catch (err) {
        console.error('[entrance-exit] playback error:', err);
        return { ok: false, reason: 'exception' };
    }
}

app.post('/api/play', requireAuth, async (req, res) => {
    const { filename } = req.body;
    if (!filename || typeof filename !== 'string') return res.status(400).json({ error: 'Filename required' });

    const safeFilename = path.basename(filename);
    const filePath = path.join(SOUNDS_DIR, safeFilename);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(SOUNDS_DIR))) return res.status(403).json({ error: 'Invalid path' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    if (!activeGuildId || !getVoiceConnection(activeGuildId)) {
        return res.status(400).json({ error: 'Join a voice channel first' });
    }

    const meta = loadSoundsMeta();
    let duration = getDuration(meta, safeFilename);
    if (duration == null) {
        duration = await probeDurationAsync(filePath);
        if (duration != null) setSoundMeta(safeFilename, { duration });
    }
    const displayName = getDisplayName(meta, safeFilename);

    const role = req.session.user.role;
    const isGuest = role === 'guest';

    if (isGuest) {
        if (!getGuestEnabled()) return res.status(403).json({ error: 'Guest access is disabled.' });
        const ip = getClientIP(req);
        if (isIPBlocked(ip)) return res.status(403).json({ error: 'Your IP has been blocked.' });
        const lastPlay = guestLastPlayByIP.get(ip);
        const cooldownSec = getGuestCooldownSec(ip);
        if (lastPlay != null && cooldownSec > 0) {
            const elapsed = (Date.now() - lastPlay) / 1000;
            if (elapsed < cooldownSec) {
                return res.status(429).json({ error: `Wait ${Math.ceil(cooldownSec - elapsed)} seconds before playing again.`, cooldownRemaining: Math.ceil(cooldownSec - elapsed) });
            }
        }
    } else if (role === 'user') {
        const un = req.session.user.username;
        const lastPlay = userLastPlayByUsername.get(un);
        const cooldownSec = getUserCooldownSec(un);
        if (lastPlay != null && cooldownSec > 0) {
            const elapsed = (Date.now() - lastPlay) / 1000;
            if (elapsed < cooldownSec) {
                return res.status(429).json({ error: `Wait ${Math.ceil(cooldownSec - elapsed)} seconds before playing again.`, cooldownRemaining: Math.ceil(cooldownSec - elapsed) });
            }
        }
    }

    const metaStart = getSoundStartTime(meta, safeFilename);
    const metaEnd = getSoundEndTime(meta, safeFilename);
    let effectiveDuration = duration;
    if (duration != null && (metaStart != null || metaEnd != null)) {
        const start = metaStart != null ? metaStart : 0;
        const end = metaEnd != null && metaEnd <= duration ? metaEnd : duration;
        effectiveDuration = Math.max(0, end - start);
    }
    const maxDur = isGuest ? getGuestMaxDuration() : getUserMaxDuration(req.session?.user?.username);
    if ((role === 'user' || isGuest) && effectiveDuration != null && effectiveDuration > maxDur) {
        return res.status(403).json({ error: `Only sounds ${maxDur} seconds or shorter are allowed. This sound is ${Math.ceil(effectiveDuration)}s.` });
    }

    if (getPlaybackSuperadminOnly(meta) && role !== 'superadmin') {
        return res.status(403).json({ error: 'Only superadmin can play.' });
    }
    if (getPlaybackLocked(meta)) {
        const lockedBy = getPlaybackLockedBy(meta);
        if (lockedBy === 'superadmin') {
            return res.status(403).json({ error: 'Playback is locked by superadmin.' });
        }
        if (role === 'user' || isGuest) {
            return res.status(403).json({ error: 'Playback is locked by an admin.' });
        }
    }

    const currentStatus = player.state.status;
    const isSomeonePlaying = currentStatus === AudioPlayerStatus.Playing || currentStatus === AudioPlayerStatus.Paused || currentStatus === AudioPlayerStatus.Buffering || currentStatus === AudioPlayerStatus.AutoPaused;
    const startedByRole = playbackState.startedBy?.role;

    // In single-play mode, enforce override rules
    if (!multiPlayEnabled && isSomeonePlaying) {
        if ((startedByRole === 'admin' || startedByRole === 'superadmin') && (role === 'user' || isGuest)) {
            return res.status(403).json({ error: 'An admin or superadmin is playing. You cannot override their playback.' });
        }
        if (startedByRole === 'superadmin' && role === 'admin') {
            return res.status(403).json({ error: 'A superadmin is playing. You cannot override their playback.' });
        }
    }
    // In multi-play mode, users/guests still can't play while a higher role is playing
    if (multiPlayEnabled && isSomeonePlaying) {
        // Check highest role among active tracks
        let highestActiveRole = startedByRole;
        for (const [, t] of activeTracks) {
            if (t.startedBy?.role === 'superadmin') { highestActiveRole = 'superadmin'; break; }
            if (t.startedBy?.role === 'admin' && highestActiveRole !== 'superadmin') highestActiveRole = 'admin';
        }
        if ((highestActiveRole === 'admin' || highestActiveRole === 'superadmin') && (role === 'user' || isGuest)) {
            return res.status(403).json({ error: 'An admin or superadmin is playing. You cannot override their playback.' });
        }
        if (highestActiveRole === 'superadmin' && role === 'admin') {
            return res.status(403).json({ error: 'A superadmin is playing. You cannot override their playback.' });
        }
    }

    const captchaCheck = _consumeAbsurdCaptchaToken(req, safeFilename);
    if (!captchaCheck.ok) return res.status(captchaCheck.status).json(captchaCheck.body);

    const metaVolume = getSoundVolume(meta, safeFilename);
    const soundStopOthers = getSoundStopOthers(meta, safeFilename);
    let startTime = typeof req.body.startTime === 'number' && req.body.startTime >= 0 ? req.body.startTime : (metaStart != null ? metaStart : 0);
    const maxEnd = metaEnd != null ? metaEnd : (duration != null ? duration : 999999);
    if (startTime >= maxEnd) return res.status(400).json({ error: 'Start position is past the end of the trimmed sound.' });
    let endTime = metaEnd != null && metaEnd > startTime ? metaEnd : null;
    const playDuration = endTime != null ? endTime - startTime : null;
    const volMult = metaVolume != null ? metaVolume : 1;
    const effectiveVolume = Math.max(0, Math.min(2, currentVolume * volMult));

    try {
        // Ensure voice connection is ready
        const conn = getVoiceConnection(activeGuildId);
        const connStatus = conn?.state?.status ?? 'no-connection';
        console.log('[DIAG] play.start filename=', safeFilename, 'effectiveVolume=', effectiveVolume, 'multiPlay=', multiPlayEnabled, 'voiceConnectionStatus=', connStatus);
        if (conn && connStatus !== 'ready') {
            try {
                await entersState(conn, VoiceConnectionStatus.Ready, 15_000);
            } catch (err) {
                console.error('[DIAG] voice connection never reached ready:', err.message);
                return res.status(503).json({
                    error: "Voice connection failed to establish. Discord voice requires UDP outbound. If you're running in a container or behind a firewall, ensure UDP is allowed.",
                });
            }
        }

        const startedBy = { username: req.session.user.username, role: req.session.user.role };
        const effectivePlayDuration = playDuration != null ? playDuration : duration;
        const plannedDurationMs = effectivePlayDuration != null ? Math.round(effectivePlayDuration * 1000) : null;
        const newPlayId = statsDb.recordPlayStart({
            filename: safeFilename,
            displayName,
            userId: isGuest ? null : req.session.user.username,
            userRole: role,
            guestIp: isGuest ? getClientIP(req) : null,
            plannedDurationMs,
        });

        if (multiPlayEnabled) {
            // --- Multi-play mode: use PCM mixer ---
            // Build ffmpeg args to produce raw PCM s16le 48kHz stereo
            const ffArgs = ['-nostdin'];
            if (startTime > 0) ffArgs.push('-ss', String(startTime));
            ffArgs.push('-i', filePath);
            if (playDuration != null && playDuration > 0) ffArgs.push('-t', String(playDuration));
            ffArgs.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-af', `volume=${volMult}`, '-');
            const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
            ff.stderr.on('data', () => {});
            ff.on('error', (err) => console.error('ffmpeg multi-play error', err));

            // If this sound has stopOthers, clear everything first
            if (soundStopOthers || !isSomeonePlaying) {
                // Stop existing mixer if any — finalize any open plays as stopped-early first
                finalizeAllOpenPlays(true);
                if (activeMixer) { activeMixer.removeAllTracks(); activeMixer.destroy(); activeMixer = null; }
                activeTracks.clear();
                player.stop();
            }

            // Create mixer if needed
            if (!activeMixer || activeMixer.destroyed) {
                activeMixer = new AudioMixer();
                const resource = createAudioResource(activeMixer, {
                    inputType: StreamType.Raw,
                    inlineVolume: true,
                });
                resource.volume.setVolume(currentVolume);
                player.play(resource);
            }

            const trackId = activeMixer.addTrack(ff.stdout, { filename: safeFilename, displayName }, ff, { priority: !!(startedBy && startedBy.priority) });
            activeTracks.set(trackId, {
                filename: safeFilename,
                displayName,
                startTime: Date.now(),
                startTimeOffset: startTime,
                duration: effectivePlayDuration,
                startedBy,
                playId: newPlayId,
            });
            ff.on('close', () => {
                const track = activeTracks.get(trackId);
                if (track && track.playId != null) {
                    const elapsedMs = Date.now() - track.startTime;
                    const plannedMs = track.duration != null ? track.duration * 1000 : null;
                    const stoppedEarly = plannedMs != null && elapsedMs < plannedMs - 250;
                    statsDb.recordPlayEnd(track.playId, { stoppedEarly });
                    track.playId = null;
                }
            });

            // Update primary playback state to latest track
            playbackState = {
                status: 'playing',
                filename: safeFilename,
                displayName,
                startTime: Date.now(),
                startTimeOffset: startTime,
                duration: effectivePlayDuration,
                startedBy,
            };
        } else {
            // --- Single-play mode: existing behavior ---
            // A new single-play preempts whatever was playing — finalize the prior row.
            if (currentSinglePlayId != null) {
                statsDb.recordPlayEnd(currentSinglePlayId, { stoppedEarly: true });
                currentSinglePlayId = null;
            }
            let stream;
            const needsFfmpeg = startTime > 0 || playDuration != null;
            if (needsFfmpeg) {
                const args = ['-nostdin'];
                if (startTime > 0) args.push('-ss', String(startTime));
                args.push('-i', filePath);
                if (playDuration != null && playDuration > 0) args.push('-t', String(playDuration));
                args.push('-f', 'mp3', '-');
                const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
                stream = ff.stdout;
                ff.stderr.on('data', () => {});
                ff.on('error', (err) => console.error('ffmpeg spawn error', err));
            } else {
                stream = fs.createReadStream(filePath);
            }
            const resource = createAudioResource(stream, {
                inputType: StreamType.Arbitrary,
                inlineVolume: true,
                metadata: { filename: safeFilename, displayName },
            });
            resource.volume.setVolume(effectiveVolume);
            player.play(resource);
            currentSinglePlayId = newPlayId;
            playbackState = {
                status: 'playing',
                filename: safeFilename,
                displayName,
                startTime: Date.now(),
                startTimeOffset: startTime,
                duration: effectivePlayDuration,
                startedBy,
            };
        }

        if (isGuest) {
            guestLastPlayByIP.set(getClientIP(req), Date.now());
            appendGuestHistory(getClientIP(req), safeFilename, displayName);
        } else if (role === 'user') {
            userLastPlayByUsername.set(req.session.user.username, Date.now());
        }
        addToRecentlyPlayedServer(safeFilename, displayName, startedBy?.username ?? null, Date.now());
        const playDurationRes = playDuration != null ? playDuration : duration;
        res.json({ ok: true, duration: playDurationRes, displayName, startTimeOffset: startTime, startedBy, multiPlay: multiPlayEnabled });
    } catch (err) {
        console.error('Play error:', err);
        res.status(500).json({ error: err.message || 'Failed to play audio' });
    }
});

// --- URL streaming (YouTube / TikTok / SoundCloud / anything yt-dlp supports) ---
const URL_STREAM_PROBE_TIMEOUT_MS = 20_000;
const URL_STREAM_DOWNLOAD_TIMEOUT_MS = 300_000; // 5 min
const URL_PREVIEW_DIR = path.join(DATA_DIR, 'url-stream-cache');
const URL_PREVIEW_TTL_MS = 30 * 60 * 1000; // 30 min
if (!fs.existsSync(URL_PREVIEW_DIR)) fs.mkdirSync(URL_PREVIEW_DIR, { recursive: true });
const YT_DLP_BIN = process.env.YT_DLP_BIN || 'yt-dlp';

// Args applied to every yt-dlp invocation. Three layers stack here to defeat
// YouTube's 2025-era anti-scraping:
//   1. android/ios/web player_client list -- avoids the bare-web bot wall and
//      exposes Shorts formats.
//   2. bgutil-pot-provider script path (auto-detected when present) -- supplies
//      the GVS PO Tokens YouTube now requires for non-storyboard formats.
//      Paired with the local 127.0.0.1:4416 HTTP server that the pip plugin
//      auto-discovers, plus Deno on PATH for the nsig JS challenge.
//   3. Cookies (browser profile OR file) -- only needed for videos that hit
//      the "Sign in to confirm you're not a bot" wall even with PO tokens.
//      YTDLP_COOKIES_FROM_BROWSER takes precedence (e.g.
//      "chromium:/opt/discord-soundboard/yt-profile" from the noVNC-managed
//      Chromium session); YTDLP_COOKIES_FILE accepts a Netscape cookies.txt.
const BGUTIL_POT_SCRIPT = '/opt/bgutil-pot-server/server/build/generate_once.js';
function ytdlpCommonArgs() {
    const args = ['--extractor-args', 'youtube:player_client=android,ios,web'];
    try {
        if (fs.existsSync(BGUTIL_POT_SCRIPT)) {
            args.push('--extractor-args', `youtubepot-bgutilscript:script_path=${BGUTIL_POT_SCRIPT}`);
        }
    } catch {}
    const fromBrowser = (process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim();
    if (fromBrowser) args.push('--cookies-from-browser', fromBrowser);
    const cookies = (process.env.YTDLP_COOKIES_FILE || '').trim();
    if (cookies) args.push('--cookies', cookies);
    const extra = (process.env.YTDLP_EXTRA_ARGS || '').trim();
    if (extra) args.push(...extra.split(/\s+/));
    return args;
}
let activeUrlStream = null; // { ytdlp, ff, killTimer, previewFilePath }
// FIFO of URL streams waiting for the player: submitting a URL while one is
// already streaming queues it instead of preempting.
// [{ id, url, title, effectiveDuration, trimStart, trimEnd, previewFilePath, requestedBy, maxDur }]
const urlStreamQueue = [];
let urlQueueNextId = 1;
const URL_QUEUE_MAX = 20;
// Skip crossfade: pre-spool the next stream, fade the current one down,
// swap resources (no player Idle in between), fade the new one up.
const URL_SKIP_FADEOUT_MS = 1200;
const URL_SKIP_FADEIN_MS = 900;
const URL_SKIP_PREBUFFER_TIMEOUT_MS = 8000;
let urlSkipInProgress = false;
let urlSkipAbort = false; // set by /api/stop to cancel an in-flight crossfade
const urlSkipVotes = new Map(); // presenceKey -> display name, reset per stream
// previewId -> { filePath, url, title, duration, createdAt, username }
const urlPreviewCache = new Map();

function sweepUrlPreviews() {
    const now = Date.now();
    // Preview files backing the active stream or queued items must survive
    // the TTL — a queued trim can sit longer than 30 min before it plays.
    const pinned = new Set();
    if (activeUrlStream?.previewFilePath) pinned.add(activeUrlStream.previewFilePath);
    for (const q of urlStreamQueue) if (q.previewFilePath) pinned.add(q.previewFilePath);
    for (const [id, entry] of urlPreviewCache) {
        if (pinned.has(entry.filePath)) continue;
        if (now - entry.createdAt > URL_PREVIEW_TTL_MS) {
            try { fs.unlinkSync(entry.filePath); } catch {}
            urlPreviewCache.delete(id);
        }
    }
    try {
        for (const name of fs.readdirSync(URL_PREVIEW_DIR)) {
            const full = path.join(URL_PREVIEW_DIR, name);
            if (pinned.has(full)) continue;
            const st = fs.statSync(full);
            if (now - st.mtimeMs > URL_PREVIEW_TTL_MS) {
                try { fs.unlinkSync(full); } catch {}
            }
        }
    } catch {}
}
setInterval(sweepUrlPreviews, 10 * 60 * 1000).unref();

// Shared SSRF guard: is this hostname a private / loopback / link-local target
// that a user shouldn't be able to make the server fetch or capture? Covers
// IPv4 literals, IPv6 loopback/ULA/link-local, IPv4-mapped IPv6, 0.0.0.0, and
// CGNAT. DNS-rebinding (a public name resolving to a private IP) is caught by
// _assertPublicUrl below, which resolves the name first.
function _isPrivateHost(hostname) {
    let host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    // IPv6 loopback / unspecified / ULA (fc00::/7) / link-local (fe80::/10)
    if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1' || host === '0:0:0:0:0:0:0:0') return true;
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true;
    // IPv4-mapped IPv6: Node's URL parser normalizes [::ffff:127.0.0.1] to the
    // hex form ::ffff:7f00:1, which slips past dotted-quad prefix checks. Extract
    // the embedded IPv4 (hex OR dotted) and fall through to the v4 rules.
    let m = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (m) {
        const a = parseInt(m[1], 16), b = parseInt(m[2], 16);
        host = `${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`;
    } else {
        m = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
        if (m) host = m[1];
    }
    if (host === '0.0.0.0') return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^0\./.test(host)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return true;
    if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(host)) return true; // CGNAT 100.64/10
    return false;
}
// Async: reject the URL if its host is private OR resolves to a private IP
// (DNS rebinding). Returns true if safe to fetch, false otherwise.
async function _assertPublicUrl(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    if (_isPrivateHost(u.hostname)) return false;
    try {
        const dns = require('dns').promises;
        const results = await dns.lookup(u.hostname, { all: true });
        if (results.some(r => _isPrivateHost(r.address))) return false;
    } catch { /* resolution failure — let the actual fetch fail normally */ }
    return true;
}

function validateStreamUrl(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    if (_isPrivateHost(u.hostname)) return null;
    return u.toString();
}

function ytdlpRun(args, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve) => {
        const fullArgs = [...ytdlpCommonArgs(), ...args];
        const p = spawn(YT_DLP_BIN, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        p.stdout.on('data', (d) => { stdout += d.toString(); });
        p.stderr.on('data', (d) => { stderr += d.toString(); });
        const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
        p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
        p.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err) }); });
    });
}

function killActiveUrlStream() {
    if (!activeUrlStream) return;
    try { activeUrlStream.ff?.kill('SIGKILL'); } catch {}
    try { activeUrlStream.ytdlp?.kill('SIGKILL'); } catch {}
    if (activeUrlStream.killTimer) clearTimeout(activeUrlStream.killTimer);
    activeUrlStream = null;
}

// Advance the URL queue when the shared player is free. Called from the
// player Idle transition, after each stream's ffmpeg exits, on enqueue, and
// on skip — all guarded, so redundant calls are harmless.
function processUrlQueue() {
    if (urlStreamQueue.length === 0) return;
    if (voiceTeardownInProgress) return;
    if (urlSkipInProgress) return; // crossfade orchestration owns the player right now
    if (activeUrlStream) return;
    if (player.state.status !== AudioPlayerStatus.Idle) return;
    // Let TTS drain first — its own Idle transition re-triggers this.
    if (ttsIsPlaying || ttsQueue.length > 0) return;
    if (!activeGuildId || !getVoiceConnection(activeGuildId)) return;
    const item = urlStreamQueue.shift();
    if (item.previewFilePath && !fs.existsSync(item.previewFilePath)) {
        console.warn('[url-queue] cached preview missing, skipping "%s"', item.title);
        setImmediate(processUrlQueue);
        return;
    }
    console.log('[url-queue] starting "%s" (%d left in queue)', item.title, urlStreamQueue.length);
    startUrlStreamPlayback(item).catch((err) => {
        console.error('[url-queue] failed to start "%s":', item.title, err.message || err);
        setImmediate(processUrlQueue);
    });
}

// Spawn the yt-dlp/ffmpeg pipeline for a queue item without touching the
// player — split out so a crossfade can pre-spool the next stream while
// the current one is still audible.
function spawnUrlStreamPipeline(item) {
    const { url, trimStart, trimEnd, previewFilePath } = item;
    let ytdlp = null, ff;
    if (previewFilePath) {
        // Stream from cached WAV through ffmpeg with trim.
        const ffArgs = ['-nostdin'];
        if (trimStart > 0) ffArgs.push('-ss', String(trimStart));
        ffArgs.push('-i', previewFilePath);
        if (trimEnd != null) ffArgs.push('-t', String(trimEnd - trimStart));
        ffArgs.push('-vn', '-f', 'mp3', '-');
        ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        ff.stderr.on('data', () => {});
        ff.on('error', (err) => console.error('[url-stream] ffmpeg error', err));
    } else {
        ytdlp = spawn(YT_DLP_BIN, [...ytdlpCommonArgs(), '-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '--quiet', '-o', '-', url], { stdio: ['ignore', 'pipe', 'pipe'] });
        ytdlp.stderr.on('data', () => {});
        ytdlp.on('error', (err) => console.error('[url-stream] yt-dlp error', err));
        ff = spawn('ffmpeg', ['-nostdin', '-i', 'pipe:0', '-vn', '-f', 'mp3', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
        ytdlp.stdout.pipe(ff.stdin).on('error', () => {});
        ff.stderr.on('data', () => {});
        ff.on('error', (err) => console.error('[url-stream] ffmpeg error', err));
    }
    return { ytdlp, ff };
}

function killUrlPipeline(pipeline) {
    if (!pipeline) return;
    try { pipeline.ff?.kill('SIGKILL'); } catch {}
    try { pipeline.ytdlp?.kill('SIGKILL'); } catch {}
}

// Resolves once the pipeline has produced its first audio bytes (buffered,
// not consumed), so a crossfade never swaps to dead air.
function waitForFirstData(stream, timeoutMs) {
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            stream.off('readable', onReadable);
            stream.off('end', onEnd);
            stream.off('close', onEnd);
            stream.off('error', onError);
            err ? reject(err) : resolve();
        };
        const onReadable = () => {
            if (stream.readableLength > 0) return finish();
            // A zero-byte 'readable' is the EOF signal on an unread stream;
            // read() returns null there and unblocks the 'end' emission.
            stream.read();
        };
        const onEnd = () => { if (stream.readableLength === 0) finish(new Error('stream ended before producing audio')); };
        const onError = (e) => finish(e);
        const timer = setTimeout(() => finish(new Error('timed out waiting for audio')), timeoutMs);
        stream.on('readable', onReadable);
        stream.on('end', onEnd);
        stream.on('close', onEnd);
        stream.on('error', onError);
        onReadable();
    });
}

// Ramp the current resource's inline volume to 0 over ~ms. Bails out if the
// resource gets swapped or stopped underneath us mid-fade.
async function fadeOutCurrentPlayback(ms) {
    const st = player.state;
    if (st.status !== AudioPlayerStatus.Playing && st.status !== AudioPlayerStatus.Buffering) return;
    const res = st.resource;
    if (!res || !res.volume) return;
    const steps = 15;
    const base = typeof res.volume.volume === 'number' ? res.volume.volume : currentVolume;
    for (let i = 1; i <= steps; i++) {
        await new Promise(r => setTimeout(r, Math.max(20, Math.round(ms / steps))));
        if (player.state.resource !== res) return;
        try { res.volume.setVolume(base * (1 - i / steps)); } catch { return; }
    }
}

function fadeInResource(resource, target, ms) {
    const steps = Math.max(4, Math.round(ms / 80));
    let i = 0;
    const iv = setInterval(() => {
        i++;
        const done = i >= steps || player.state.resource !== resource;
        try { resource.volume.setVolume(done ? target : target * (i / steps)); } catch {}
        if (done) clearInterval(iv);
    }, Math.max(30, Math.round(ms / steps)));
    if (iv.unref) iv.unref();
}

// Wire a spawned pipeline into the shared player and take over playback
// state. Assumes the caller has already dealt with whatever was playing.
function attachUrlStreamPipeline(item, pipeline, { fadeInMs = 0 } = {}) {
    const { url, title, effectiveDuration, trimStart, trimEnd, previewFilePath, requestedBy, maxDur, mystery } = item;
    const { ytdlp, ff } = pipeline;
    // Mystery picks hide the title from everyone while queued and while
    // playing; the real title only lands in Recently Played once the
    // stream ends (the reveal). Stats/audit rows keep the real title.
    const publicTitle = mystery ? `🎭 Mystery pick from ${requestedBy.username}` : title;

    const crypto = require('crypto');
    const safeName = 'url:' + crypto.createHash('sha1').update(url + ':' + trimStart + ':' + (trimEnd || '')).digest('hex').slice(0, 10);
    const startedBy = { username: requestedBy.username, role: requestedBy.role };
    const plannedDurationMs = effectiveDuration != null ? Math.round(effectiveDuration * 1000) : null;
    const newPlayId = statsDb.recordPlayStart({
        filename: safeName, displayName: title,
        userId: requestedBy.username, userRole: requestedBy.role,
        guestIp: null, plannedDurationMs,
    });

    const killAfterMs = ((effectiveDuration != null ? effectiveDuration : maxDur) || 600) * 1000 + 10_000;
    const killTimer = setTimeout(() => {
        console.log('[url-stream] hard-killing stream after max duration');
        killUrlPipeline(pipeline);
    }, killAfterMs);

    urlSkipVotes.clear();
    activeUrlStream = { ytdlp, ff, killTimer, previewFilePath: previewFilePath || null };

    ff.on('close', () => {
        clearTimeout(killTimer);
        try { ytdlp?.kill('SIGTERM'); } catch {}
        if (activeUrlStream && activeUrlStream.ff === ff) activeUrlStream = null;
        if (currentSinglePlayId === newPlayId) {
            statsDb.recordPlayEnd(newPlayId, { stoppedEarly: false });
            currentSinglePlayId = null;
        }
        // The reveal: mystery picks enter Recently Played with their real
        // title only after the stream is over.
        if (mystery) addToRecentlyPlayedServer(safeName, title, requestedBy.username, Date.now());
        setImmediate(processUrlQueue);
    });

    const resource = createAudioResource(ff.stdout, {
        inputType: StreamType.Arbitrary, inlineVolume: true,
        metadata: { filename: safeName, displayName: publicTitle },
    });
    if (fadeInMs > 0) {
        resource.volume.setVolume(0);
        fadeInResource(resource, currentVolume, fadeInMs);
    } else {
        resource.volume.setVolume(currentVolume);
    }
    player.play(resource);
    currentSinglePlayId = newPlayId;
    playbackState = {
        status: 'playing',
        filename: safeName,
        displayName: publicTitle,
        startTime: Date.now(),
        startTimeOffset: 0,
        duration: effectiveDuration,
        startedBy,
        mystery: !!mystery,
    };
    if (!mystery) addToRecentlyPlayedServer(safeName, title, startedBy.username, Date.now());
    statsDb.recordAdminAction({
        actor: requestedBy.username,
        actorRole: requestedBy.role,
        action: 'url-stream.play',
        target: safeName,
        details: { url, title, duration: effectiveDuration, trimStart, trimEnd, fromPreview: !!previewFilePath, mystery: !!mystery },
    });
    return { title, duration: effectiveDuration, url, trimStart, trimEnd, mystery: !!mystery };
}

// Start a URL stream on the shared player. `item` carries everything needed
// so queued entries can start after the originating request is long gone.
async function startUrlStreamPlayback(item) {
    const conn = activeGuildId ? getVoiceConnection(activeGuildId) : null;
    if (!conn) { const e = new Error('Not connected to a voice channel.'); e.statusCode = 400; throw e; }
    if (conn.state?.status !== 'ready') {
        try { await entersState(conn, VoiceConnectionStatus.Ready, 15_000); }
        catch { const e = new Error('Voice connection failed to establish.'); e.statusCode = 503; throw e; }
    }

    // Preempt — a starting URL stream owns the single-play slot.
    killActiveUrlStream();
    if (currentSinglePlayId != null) {
        statsDb.recordPlayEnd(currentSinglePlayId, { stoppedEarly: true });
        currentSinglePlayId = null;
    }
    if (multiPlayEnabled) {
        finalizeAllOpenPlays(true);
        if (activeMixer) { activeMixer.removeAllTracks(); activeMixer.destroy(); activeMixer = null; }
        activeTracks.clear();
    }
    player.stop();

    return attachUrlStreamPipeline(item, spawnUrlStreamPipeline(item));
}

// Skip the current URL stream with a crossfade: pre-spool the next queued
// item, fade the current stream out, swap the player resource (no Idle
// transition, so nothing else can steal the slot), fade the next one in.
// With an empty queue it's just a fade-to-stop.
async function performUrlSkip() {
    if (urlSkipInProgress) { const e = new Error('A skip is already in progress.'); e.statusCode = 409; throw e; }
    urlSkipInProgress = true;
    urlSkipAbort = false;
    try {
        urlSkipVotes.clear();
        let next = null;
        while (urlStreamQueue.length > 0 && !next) {
            const cand = urlStreamQueue.shift();
            if (cand.previewFilePath && !fs.existsSync(cand.previewFilePath)) {
                console.warn('[url-queue] cached preview missing, skipping "%s"', cand.title);
                continue;
            }
            next = cand;
        }

        let pipeline = null;
        if (next) {
            try {
                pipeline = spawnUrlStreamPipeline(next);
                await waitForFirstData(pipeline.ff.stdout, URL_SKIP_PREBUFFER_TIMEOUT_MS);
            } catch (err) {
                console.warn('[url-queue] crossfade pre-spool failed for "%s":', next.title, err.message || err);
                killUrlPipeline(pipeline);
                pipeline = null;
                next = null; // drop the broken item; remaining queue advances normally
            }
        }

        await fadeOutCurrentPlayback(URL_SKIP_FADEOUT_MS);

        if (urlSkipAbort) { // /api/stop won mid-fade — leave everything stopped
            killUrlPipeline(pipeline);
            return { skipped: false, aborted: true };
        }

        killActiveUrlStream();
        if (currentSinglePlayId != null) {
            statsDb.recordPlayEnd(currentSinglePlayId, { stoppedEarly: true });
            currentSinglePlayId = null;
        }

        if (pipeline && next) {
            // player.play() swaps the resource directly — no Idle event, so
            // TTS/queue handlers never see a free player mid-crossfade.
            attachUrlStreamPipeline(next, pipeline, { fadeInMs: URL_SKIP_FADEIN_MS });
            return { skipped: true, next: { title: next.mystery ? null : next.title, mystery: !!next.mystery, username: next.requestedBy?.username || null } };
        }
        player.stop();
        return { skipped: true, next: null };
    } finally {
        urlSkipInProgress = false;
        setImmediate(processUrlQueue);
    }
}

// Download the URL audio to a server-side cache so the client can render a
// waveform, scrub locally, and then either stream the trimmed segment to
// Discord or import it as a sound — all without re-downloading.
app.post('/api/stream-url/preview', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    const un = req.session.user.username;
    if (!getUrlStreamEnabled(role, un)) return res.status(403).json({ error: 'URL streaming is disabled for your role.' });
    const url = validateStreamUrl(req.body?.url);
    if (!url) return res.status(400).json({ error: 'Invalid URL.' });
    sweepUrlPreviews();

    const probe = await ytdlpRun(['--dump-single-json', '--no-playlist', '--no-warnings', '--quiet', url], { timeoutMs: URL_STREAM_PROBE_TIMEOUT_MS });
    let title = '', duration = null, uploader = '';
    if (probe.code === 0) {
        try {
            const info = JSON.parse(probe.stdout);
            title = info.title || '';
            uploader = info.uploader || info.channel || '';
            if (typeof info.duration === 'number') duration = info.duration;
        } catch {}
    } else {
        const msg = (probe.stderr || probe.stdout || '').trim().split('\n').slice(-3).join(' / ');
        return res.status(502).json({ error: 'Failed to probe URL: ' + (msg || 'unknown error') });
    }
    // Cap preview download by the play-max for this role so we don't
    // spend minutes downloading a source a user role couldn't stream anyway.
    const maxPlay = getUrlStreamMaxDurationSec(role, un);
    if (maxPlay > 0 && duration != null && duration > maxPlay) {
        return res.status(403).json({ error: `This clip is ${Math.ceil(duration)}s. Your role is limited to ${maxPlay}s.` });
    }

    const crypto = require('crypto');
    const previewId = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(URL_PREVIEW_DIR, `preview-${previewId}.wav`);
    const tmpOut = path.join(URL_PREVIEW_DIR, `preview-${previewId}.dl.%(ext)s`);

    const r = await ytdlpRun([
        '-f', 'bestaudio/best',
        '-x', '--audio-format', 'wav',
        '--audio-quality', '5',
        '--no-playlist',
        '--no-warnings',
        '--quiet',
        '-o', tmpOut,
        url,
    ], { timeoutMs: URL_STREAM_DOWNLOAD_TIMEOUT_MS });
    if (r.code !== 0) {
        const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' / ');
        return res.status(502).json({ error: 'Failed to download: ' + (msg || 'unknown error') });
    }
    const dlPath = path.join(URL_PREVIEW_DIR, `preview-${previewId}.dl.wav`);
    if (!fs.existsSync(dlPath)) return res.status(502).json({ error: 'yt-dlp did not produce a WAV.' });
    fs.renameSync(dlPath, filePath);

    // Re-probe precise duration from the file we actually have.
    let actualDuration = duration;
    try {
        const probed = await new Promise((resolve) => {
            const ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath]);
            let out = '';
            ff.stdout.on('data', (d) => { out += d.toString(); });
            ff.on('close', () => resolve(parseFloat(out.trim()) || null));
            ff.on('error', () => resolve(null));
        });
        if (probed) actualDuration = probed;
    } catch {}

    urlPreviewCache.set(previewId, {
        filePath,
        url,
        title,
        uploader,
        duration: actualDuration,
        createdAt: Date.now(),
        username: req.session.user.username,
    });
    res.json({ previewId, title, uploader, duration: actualDuration, url });
});

app.get('/api/stream-url/preview/:id/audio', requireAuth, (req, res) => {
    const entry = urlPreviewCache.get(String(req.params.id || ''));
    if (!entry || !fs.existsSync(entry.filePath)) return res.status(404).send('Not found');
    // Cross-user IDOR guard: a leaked preview id shouldn't let another
    // logged-in user stream / play the previewer's clip.
    if (entry.username && entry.username !== req.session.user.username) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, max-age=900');
    fs.createReadStream(entry.filePath).pipe(res);
});

// Trim a preview and save it to the sounds library. Admin/superadmin get direct
// save; user/guest goes into the existing pending-upload queue.
app.post('/api/stream-url/import', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    const un = req.session.user.username;
    if (!getUrlStreamEnabled(role, un)) return res.status(403).json({ error: 'URL streaming is disabled for your role.' });
    const isAdminOrSuper = role === 'admin' || role === 'superadmin';
    const canDirectUpload = isAdminOrSuper;
    const canGuestPendingUpload = role === 'guest' && getGuestUploadEnabled();
    const canUserPendingUpload = role === 'user' && getUserUploadEnabled(un);
    const canPendingUpload = canGuestPendingUpload || canUserPendingUpload;
    if (!canDirectUpload && !canPendingUpload) return res.status(403).json({ error: 'Importing to the library is not allowed for your role.' });

    const body = req.body || {};
    const previewId = String(body.previewId || '').trim();
    const entry = urlPreviewCache.get(previewId);
    if (!entry || !fs.existsSync(entry.filePath)) return res.status(400).json({ error: 'Preview expired. Load the URL again.' });
    if (entry.username && entry.username !== req.session.user.username) return res.status(400).json({ error: 'Preview expired. Load the URL again.' });

    let trimStart = Number(body.trimStart);
    let trimEnd = Number(body.trimEnd);
    const dur = entry.duration || 0;
    if (!Number.isFinite(trimStart) || trimStart < 0) trimStart = 0;
    if (!Number.isFinite(trimEnd) || trimEnd <= trimStart) trimEnd = dur || (trimStart + 1);
    if (dur && trimEnd > dur) trimEnd = dur;
    const trimLen = Math.max(0, trimEnd - trimStart);
    if (trimLen < 0.25) return res.status(400).json({ error: 'Trim length must be at least 0.25s.' });

    // Enforce the user's upload-duration cap (same as /api/upload).
    const maxDur = role === 'guest' ? getGuestMaxUploadDuration() : (role === 'user' ? getUserMaxUploadDuration(un) : null);
    if (maxDur != null && trimLen > maxDur) {
        return res.status(400).json({ error: `Trim length ${Math.ceil(trimLen)}s exceeds your ${maxDur}s limit.` });
    }

    const rawName = String(body.displayName || entry.title || 'url-import').trim();
    const baseName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'url-import';
    const targetDir = canDirectUpload ? SOUNDS_DIR : PENDING_DIR;
    // Check collisions in both dirs so pending sounds don't break at approval time.
    const safeName = findAvailableSoundName(baseName, '.mp3', [SOUNDS_DIR, PENDING_DIR]);
    const targetPath = path.join(targetDir, safeName);
    const resolvedPath = path.resolve(targetPath);
    if (!resolvedPath.startsWith(path.resolve(targetDir))) return res.status(403).json({ error: 'Invalid path' });

    // Extract trimmed segment via ffmpeg.
    const args = ['-nostdin', '-y', '-ss', String(trimStart), '-i', entry.filePath, '-t', String(trimLen), '-acodec', 'libmp3lame', '-q:a', '4', targetPath];
    const code = await new Promise((resolve) => {
        const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        ff.stderr.on('data', () => {});
        ff.on('error', () => resolve(-1));
        ff.on('close', (c) => resolve(c));
    });
    if (code !== 0 || !fs.existsSync(targetPath)) {
        try { fs.unlinkSync(targetPath); } catch {}
        return res.status(500).json({ error: 'Failed to extract audio segment.' });
    }

    const finalizeWithNormalize = (cb) => {
        const skipNormalize = body.skipNormalize === true;
        const shouldNormalize = getAutoNormalizeUploads() && !skipNormalize;
        if (!shouldNormalize) return cb();
        normalizeFileInPlace(targetPath, () => cb());
    };

    finalizeWithNormalize(() => {
        const finalDuration = probeDuration(targetPath) ?? trimLen;
        if (canDirectUpload) {
            setSoundMeta(safeName, { duration: finalDuration, displayName: rawName });
            statsDb.recordAdminAction({
                actor: req.session.user.username,
                actorRole: role,
                action: 'url-stream.import',
                target: safeName,
                details: { url: entry.url, trimStart, trimEnd },
            });
            return res.json({ ok: true, pending: false, filename: safeName, displayName: rawName, duration: finalDuration });
        }
        let finalSize = 0;
        try { finalSize = fs.statSync(targetPath).size; } catch {}
        addPendingUpload(safeName, {
            uploadedBy: req.session.user.username,
            uploadedByRole: role,
            uploadedByIP: null,
            uploadedAt: Date.now(),
            duration: finalDuration,
            size: finalSize,
            originalName: rawName,
            sourceUrl: entry.url,
        });
        res.json({ ok: true, pending: true, filename: safeName, displayName: rawName, duration: finalDuration });
    });
});

app.post('/api/stream-url/probe', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    const un = req.session.user.username;
    if (!getUrlStreamEnabled(role, un)) return res.status(403).json({ error: 'URL streaming is disabled for your role.' });
    const url = validateStreamUrl(req.body?.url);
    if (!url) return res.status(400).json({ error: 'Invalid URL.' });
    const r = await ytdlpRun(['--dump-single-json', '--no-playlist', '--no-warnings', '--quiet', url], { timeoutMs: URL_STREAM_PROBE_TIMEOUT_MS });
    if (r.code !== 0) {
        const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' / ');
        return res.status(502).json({ error: 'Failed to probe URL: ' + (msg || 'unknown error') });
    }
    try {
        const info = JSON.parse(r.stdout);
        res.json({
            title: info.title || '',
            uploader: info.uploader || info.channel || '',
            duration: typeof info.duration === 'number' ? info.duration : null,
            thumbnail: info.thumbnail || null,
            extractor: info.extractor_key || info.extractor || null,
            webpage_url: info.webpage_url || url,
        });
    } catch {
        res.status(502).json({ error: 'Could not parse metadata.' });
    }
});

app.post('/api/stream-url', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    const un = req.session.user.username;
    if (role === 'guest') return res.status(403).json({ error: 'Guests cannot stream URLs.' });
    if (!getUrlStreamEnabled(role, un)) return res.status(403).json({ error: 'URL streaming is disabled for your role.' });
    if (!activeGuildId || !getVoiceConnection(activeGuildId)) return res.status(400).json({ error: 'Join a voice channel first.' });

    const body = req.body || {};
    const previewId = body.previewId ? String(body.previewId).trim() : '';
    let previewEntry = previewId ? urlPreviewCache.get(previewId) : null;
    if (previewEntry && previewEntry.username && previewEntry.username !== req.session.user.username) previewEntry = null;
    let url, title, duration;

    if (previewId) {
        if (!previewEntry || !fs.existsSync(previewEntry.filePath)) return res.status(400).json({ error: 'Preview expired. Load the URL again.' });
        url = previewEntry.url;
        title = previewEntry.title || url;
        duration = previewEntry.duration;
    } else {
        url = validateStreamUrl(body.url);
        if (!url) return res.status(400).json({ error: 'Invalid URL.' });
        title = url;
        duration = null;
    }

    const meta = loadSoundsMeta();
    if (getPlaybackSuperadminOnly(meta) && role !== 'superadmin') return res.status(403).json({ error: 'Only superadmin can play.' });
    if (getPlaybackLocked(meta)) {
        const lockedBy = getPlaybackLockedBy(meta);
        if (lockedBy === 'superadmin') return res.status(403).json({ error: 'Playback is locked by superadmin.' });
        if (role === 'user') return res.status(403).json({ error: 'Playback is locked by an admin.' });
    }

    // When a URL stream is already active (or others are waiting), the new
    // request queues instead of preempting — so the override checks below
    // only apply when we're about to cut something off.
    const willQueue = !!activeUrlStream || urlStreamQueue.length > 0;
    if (willQueue && urlStreamQueue.length >= URL_QUEUE_MAX) {
        return res.status(429).json({ error: `URL queue is full (${URL_QUEUE_MAX} max).` });
    }
    const currentStatus = player.state.status;
    const isSomeonePlaying = currentStatus === AudioPlayerStatus.Playing || currentStatus === AudioPlayerStatus.Paused || currentStatus === AudioPlayerStatus.Buffering || currentStatus === AudioPlayerStatus.AutoPaused;
    const startedByRole = playbackState.startedBy?.role;
    if (isSomeonePlaying && !willQueue) {
        if ((startedByRole === 'admin' || startedByRole === 'superadmin') && role === 'user') return res.status(403).json({ error: 'An admin or superadmin is playing. You cannot override their playback.' });
        if (startedByRole === 'superadmin' && role === 'admin') return res.status(403).json({ error: 'A superadmin is playing. You cannot override their playback.' });
    }

    // Resolve trim for preview-backed streams.
    let trimStart = 0, trimEnd = null;
    if (previewEntry) {
        trimStart = Number(body.trimStart);
        trimEnd = Number(body.trimEnd);
        if (!Number.isFinite(trimStart) || trimStart < 0) trimStart = 0;
        if (!Number.isFinite(trimEnd) || trimEnd <= trimStart) trimEnd = duration || null;
        if (duration && trimEnd && trimEnd > duration) trimEnd = duration;
    }
    // If we didn't get a live-URL duration, probe yt-dlp for it (skipped when preview is in use).
    if (!previewEntry) {
        const probe = await ytdlpRun(['--dump-single-json', '--no-playlist', '--no-warnings', '--quiet', url], { timeoutMs: URL_STREAM_PROBE_TIMEOUT_MS });
        if (probe.code === 0) {
            try {
                const info = JSON.parse(probe.stdout);
                title = info.title || title;
                if (typeof info.duration === 'number') duration = info.duration;
            } catch {}
        } else {
            const msg = (probe.stderr || probe.stdout || '').trim().split('\n').slice(-3).join(' / ');
            return res.status(502).json({ error: 'Failed to probe URL: ' + (msg || 'unknown error') });
        }
    }

    const effectiveDuration = previewEntry ? (trimEnd != null ? trimEnd - trimStart : duration) : duration;

    const maxDur = getUrlStreamMaxDurationSec(role, un);
    if (maxDur > 0 && effectiveDuration != null && effectiveDuration > maxDur) {
        return res.status(403).json({ error: `Length ${Math.ceil(effectiveDuration)}s exceeds your ${maxDur}s cap.` });
    }

    const item = {
        id: urlQueueNextId++,
        url, title,
        effectiveDuration, trimStart, trimEnd,
        previewFilePath: previewEntry ? previewEntry.filePath : null,
        requestedBy: { username: un, role },
        maxDur,
        mystery: !!body.mystery,
    };

    // Re-check after the async probe: another stream may have started since.
    if (activeUrlStream || urlStreamQueue.length > 0) {
        if (urlStreamQueue.length >= URL_QUEUE_MAX) {
            return res.status(429).json({ error: `URL queue is full (${URL_QUEUE_MAX} max).` });
        }
        urlStreamQueue.push(item);
        statsDb.recordAdminAction({
            actor: un, actorRole: role,
            action: 'url-stream.queue',
            target: 'queue',
            details: { url, title, duration: effectiveDuration, position: urlStreamQueue.length },
        });
        // In case playback ended while we were probing.
        setImmediate(processUrlQueue);
        return res.json({ ok: true, queued: true, id: item.id, position: urlStreamQueue.length, title, duration: effectiveDuration });
    }

    try {
        const result = await startUrlStreamPlayback(item);
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('[url-stream] fatal', err);
        res.status(err.statusCode || 500).json({ error: err.message || 'Failed to start stream' });
    }
});

// Skip the current URL stream (crossfade into the next queued item).
// Allowed for admins+ and whoever started the current stream.
app.post('/api/stream-url/skip', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    const un = req.session.user.username;
    const isAdmin = role === 'admin' || role === 'superadmin';
    if (activeUrlStream) {
        const current = playbackState.startedBy;
        const isOwn = current && current.username === un;
        if (!isOwn && !isAdmin) return res.status(403).json({ error: 'You can only skip your own stream.' });
        if (!isOwn && role === 'admin' && current?.role === 'superadmin') return res.status(403).json({ error: 'Only superadmin can skip superadmin playback.' });
        statsDb.recordAdminAction({ actor: un, actorRole: role, action: 'url-stream.skip', target: playbackState.filename || 'url', details: null });
        try {
            await performUrlSkip();
        } catch (err) {
            return res.status(err.statusCode || 500).json({ error: err.message || 'Skip failed' });
        }
    } else if (urlStreamQueue.length === 0) {
        return res.status(400).json({ error: 'No URL stream is playing or queued.' });
    } else {
        setImmediate(processUrlQueue);
    }
    res.json({ ok: true, queued: urlStreamQueue.length });
});

// Anyone (incl. guests) can request a skip; enough requests and the skip
// fires on its own. Threshold = half the users active on the web UI in the
// last 45s. Voting again withdraws the vote. The stream's owner voting
// skips immediately (it's theirs).
function urlSkipVoteThreshold() {
    const now = Date.now();
    let active = 0;
    for (const [, p] of activePresence) {
        if (now - p.lastSeen < PRESENCE_TIMEOUT_MS) active++;
    }
    return Math.max(1, Math.ceil(active / 2));
}

app.post('/api/stream-url/vote-skip', requireAuth, async (req, res) => {
    if (!activeUrlStream) return res.status(400).json({ error: 'No URL stream is playing.' });
    const u = req.session.user;
    const key = presenceKey(req);
    const display = u.role === 'guest' ? 'guest' : u.username;
    let voted;
    if (urlSkipVotes.has(key)) {
        urlSkipVotes.delete(key);
        voted = false;
    } else {
        urlSkipVotes.set(key, display);
        voted = true;
    }
    const threshold = urlSkipVoteThreshold();
    const isOwn = u.role !== 'guest' && playbackState.startedBy && playbackState.startedBy.username === u.username;
    let skipped = false;
    if (voted && (isOwn || urlSkipVotes.size >= threshold)) {
        statsDb.recordAdminAction({
            actor: display, actorRole: u.role,
            action: 'url-stream.vote-skip',
            target: playbackState.filename || 'url',
            details: { votes: urlSkipVotes.size, threshold, ownSkip: !!isOwn, voters: [...urlSkipVotes.values()] },
        });
        try {
            await performUrlSkip();
            skipped = true;
        } catch (err) {
            if (err.statusCode !== 409) console.error('[url-stream] vote-skip failed:', err.message || err);
        }
    }
    res.json({ ok: true, voted, votes: urlSkipVotes.size, threshold, skipped });
});

// Remove one queued item — its requester or an admin+.
app.delete('/api/stream-url/queue/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const idx = urlStreamQueue.findIndex(q => q.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Queue item not found.' });
    const role = req.session.user.role;
    const un = req.session.user.username;
    const isAdmin = role === 'admin' || role === 'superadmin';
    if (urlStreamQueue[idx].requestedBy.username !== un && !isAdmin) {
        return res.status(403).json({ error: 'You can only remove your own queued items.' });
    }
    urlStreamQueue.splice(idx, 1);
    res.json({ ok: true, queued: urlStreamQueue.length });
});

app.post('/api/stream-url/queue/clear', requireAdmin, (req, res) => {
    const removed = urlStreamQueue.length;
    urlStreamQueue.length = 0;
    res.json({ ok: true, removed });
});

// ============================================================
// YouTube cookie-session (Tier-1 bot-wall bypass)
// ============================================================
// A persistent Chromium runs under Xvfb on the host (yt-chromium.service),
// keeping a logged-in YouTube tab alive so yt-dlp can read its cookies via
// --cookies-from-browser. Superadmins reach the Chromium UI through a
// reverse-proxied noVNC tunnel mounted at /admin/yt-vnc/.

const YT_NOVNC_HOST = '127.0.0.1';
const YT_NOVNC_PORT = 6081;
const YT_VNC_PROXY_PREFIX = '/admin/yt-vnc';
const YT_TEST_CANARY = 'https://www.youtube.com/shorts/D84MXHJiqz4';
let ytSessionLastTest = null; // { ts, ok, message, url }

app.get('/api/admin/yt-session/status', requireSuperadmin, (req, res) => {
    const fromBrowser = (process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim();
    const novncQuery = 'autoconnect=true&resize=remote&reconnect=true&path=' + encodeURIComponent(YT_VNC_PROXY_PREFIX.slice(1) + '/websockify');
    res.json({
        cookiesFromBrowser: fromBrowser || null,
        novncUrl: `${YT_VNC_PROXY_PREFIX}/vnc.html?${novncQuery}`,
        lastTest: ytSessionLastTest,
    });
});

app.post('/api/admin/yt-session/test', requireSuperadmin, async (req, res) => {
    const supplied = validateStreamUrl(req.body?.url);
    const canary = supplied || YT_TEST_CANARY;
    const r = await ytdlpRun(['--dump-single-json', '--no-playlist', '--no-warnings', '--quiet', canary], { timeoutMs: URL_STREAM_PROBE_TIMEOUT_MS });
    const ok = r.code === 0;
    let message = '';
    if (ok) {
        try { message = (JSON.parse(r.stdout || '{}').title) || 'OK'; } catch { message = 'OK'; }
    } else {
        message = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' / ') || 'unknown error';
    }
    ytSessionLastTest = { ts: Date.now(), ok, message, url: canary };
    res.json(ytSessionLastTest);
});

app.post('/api/admin/yt-session/restart-chromium', requireSuperadmin, (req, res) => {
    const cp = require('child_process');
    cp.spawn('systemctl', ['restart', 'yt-chromium.service'], { stdio: 'ignore', detached: true }).unref();
    res.json({ ok: true });
});

// Toggle YTDLP_COOKIES_FROM_BROWSER for both the live process and the .env
// file so the setting survives restarts. No service restart needed —
// ytdlpCommonArgs() reads process.env on every call.
app.post('/api/admin/yt-session/cookies/:state', requireSuperadmin, (req, res) => {
    const state = req.params.state;
    if (state !== 'on' && state !== 'off') return res.status(400).json({ error: 'state must be on|off' });
    const profileDefault = 'chromium:/opt/discord-soundboard/yt-profile';
    const envPath = path.join(__dirname, '.env');
    let raw = '';
    try { raw = fs.readFileSync(envPath, 'utf8'); } catch { raw = ''; }
    // Remove any existing definitions (commented or not) to keep the file tidy.
    const lines = raw.split(/\r?\n/).filter(l => !/^\s*#?\s*YTDLP_COOKIES_FROM_BROWSER\s*=/.test(l));
    if (state === 'on') {
        lines.push(`YTDLP_COOKIES_FROM_BROWSER=${profileDefault}`);
        process.env.YTDLP_COOKIES_FROM_BROWSER = profileDefault;
    } else {
        lines.push(`# YTDLP_COOKIES_FROM_BROWSER=${profileDefault}`);
        delete process.env.YTDLP_COOKIES_FROM_BROWSER;
    }
    // Strip trailing empty lines, then end with one newline.
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    try {
        fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to write .env: ' + e.message });
    }
    res.json({ ok: true, cookiesFromBrowser: state === 'on' ? profileDefault : null });
});

// Watch Party superadmin state — feeds the "Watch Party" panel: active
// /watch + /movienight rooms, active capture proxies, and which of the
// underlying binaries (Xvfb, chromium, ffmpeg, yt-dlp) are present. Pure
// read-only; rooms can be force-closed via the existing DELETE endpoints
// since those already accept superadmin.
function _execProbe(cmd) {
    return new Promise((resolve) => {
        const p = spawn('which', [cmd], { stdio: 'ignore' });
        p.on('exit', (code) => resolve(code === 0));
        p.on('error', () => resolve(false));
    });
}
app.get('/api/admin/watch/state', requireSuperadmin, async (req, res) => {
    const now = Date.now();
    const rooms = [];
    for (const r of watchRooms.values()) {
        rooms.push({
            id: r.id,
            hostUsername: r.hostUsername,
            hostRole: r.hostRole,
            url: r.url,
            sourceType: r.sourceType,
            via: r.sourceMeta?.via || null,
            captureId: r.sourceMeta?.captureId || null,
            viewerCount: r.viewers.size,
            createdAt: r.createdAt,
            ageMs: now - r.createdAt,
            idleMs: now - r.lastActivity,
            playing: !!r.state?.playing,
            position: r.state?.position || 0,
        });
    }
    const mnRooms = [];
    for (const r of movieNightRooms.values()) {
        mnRooms.push({
            id: r.id,
            hostUsername: r.hostUsername,
            hostRole: r.hostRole,
            phase: r.phase,
            candidateCount: (r.candidates || []).length,
            viewerCount: r.viewers.size,
            createdAt: r.createdAt,
            ageMs: now - r.createdAt,
            idleMs: now - r.lastActivity,
            winnerWatchRoomId: r.winnerWatchRoomId || null,
        });
    }
    const captures = [];
    for (const [id, cap] of captureProxies) {
        captures.push({
            captureId: id,
            url: cap.url,
            display: cap.display,
            audio: !!cap.audio,
            startedAt: cap.startedAt,
            ageMs: now - cap.startedAt,
            ffmpegAlive: !!(cap.ffmpeg && !cap.ffmpeg.killed && cap.ffmpeg.exitCode == null),
            chromiumAlive: !!(cap.chromium && !cap.chromium.killed && cap.chromium.exitCode == null),
            xvfbAlive: !!(cap.xvfb && !cap.xvfb.killed && cap.xvfb.exitCode == null),
            pulseAlive: !!(cap.pulseaudio && !cap.pulseaudio.killed && cap.pulseaudio.exitCode == null),
        });
    }
    const [xvfb, chromium, ffmpeg, ytDlp, pulseaudio] = await Promise.all([
        _execProbe('Xvfb'), _execProbe('chromium'), _execProbe('ffmpeg'), _execProbe('yt-dlp'), _execProbe('pulseaudio'),
    ]);
    res.json({
        rooms,
        mnRooms,
        captures,
        diagnostics: {
            xvfb, chromium, ffmpeg, ytDlp, pulseaudio,
            ytCookiesEnabled: !!process.env.YTDLP_COOKIES_FROM_BROWSER,
            captureDir: CAPTURES_DIR,
            captureResolution: getWatchCaptureResolution(),
            captureFramerate: getWatchCaptureFramerate(),
            cdpTimeoutMs: getWatchCdpTimeoutMs(),
            ttlHours: getWatchRoomTtlHours(),
            strategy: getWatchStrategy(),
        },
    });
});
app.post('/api/admin/watch/captures/:id/stop', requireSuperadmin, (req, res) => {
    const id = String(req.params.id || '');
    if (!/^cap_[a-f0-9]+$/.test(id)) return res.status(400).json({ error: 'Bad capture id' });
    const ok = stopCaptureProxy(id);
    if (!ok) return res.status(404).json({ error: 'Capture not found' });
    res.json({ ok: true });
});

// Reverse-proxy regular HTTP under /admin/yt-vnc/* to the local websockify.
// req.url has the prefix stripped by app.use(prefix, ...).
const ytProxyAgent = new (require('http').Agent)({ keepAlive: true });
app.use(YT_VNC_PROXY_PREFIX, requireSuperadmin, (req, res) => {
    const upstreamPath = req.url || '/';
    const upstream = require('http').request({
        host: YT_NOVNC_HOST,
        port: YT_NOVNC_PORT,
        method: req.method,
        path: upstreamPath,
        headers: { ...req.headers, host: `${YT_NOVNC_HOST}:${YT_NOVNC_PORT}` },
        agent: ytProxyAgent,
    }, (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
    });
    upstream.on('error', () => { try { res.status(502).type('text/plain').send('yt-session upstream unreachable'); } catch {} });
    req.pipe(upstream);
});

app.get('/api/playback-state', requireAuth, (req, res) => {
    const statusMap = {
        [AudioPlayerStatus.Idle]: 'idle',
        [AudioPlayerStatus.Playing]: 'playing',
        [AudioPlayerStatus.Paused]: 'paused',
        [AudioPlayerStatus.Buffering]: 'buffering',
        [AudioPlayerStatus.AutoPaused]: 'paused',
    };
    let status = statusMap[player.state.status] || 'idle';
    let state = { ...playbackState, status };
    if (status === 'playing' && player.state.resource?.metadata) {
        const meta = player.state.resource.metadata;
        state.filename = meta.filename;
        state.displayName = meta.displayName ?? meta.filename;
        state.startTime = typeof playbackState.startTime === 'number' ? playbackState.startTime : Date.now();
        if (state.duration == null && playbackState.filename === meta.filename) state.duration = playbackState.duration;
        const offset = playbackState.startTimeOffset || 0;
        const maxPos = (state.duration != null && state.duration > 0) ? offset + state.duration : 999999;
        const elapsed = (Date.now() - (playbackState.startTime || Date.now())) / 1000;
        state.currentTime = Math.max(0, Math.min(maxPos, offset + elapsed));
    } else if (status === 'paused' && playbackState.pausedAt != null) {
        state.currentTime = playbackState.pausedAt;
    }
    if (req.session.user.role === 'admin' || req.session.user.role === 'superadmin') {
        state.voiceConnected = !!(activeGuildId && getVoiceConnection(activeGuildId));
        if (state.voiceConnected && lastChannelId) {
            const ch = client.channels.cache.get(lastChannelId);
            state.voiceChannelName = ch ? `${ch.guild.name} - ${ch.name}` : null;
        } else {
            state.voiceChannelName = null;
        }
    }
    state.recentlyPlayed = getRecentlyPlayedFromState();
    state.volume = currentVolume;
    state.multiPlay = multiPlayEnabled;
    state.ttsQueue = { length: ttsQueue.length, playing: ttsIsPlaying, synthPending: ttsSynthPending, items: ttsQueue.map(q => ({ id: q.id, displayName: q.displayName, username: q.username })) };
    // Vote-skip status for the current URL stream (null when none playing).
    state.urlSkipVote = activeUrlStream ? {
        votes: urlSkipVotes.size,
        threshold: urlSkipVoteThreshold(),
        voters: [...urlSkipVotes.values()],
        voted: urlSkipVotes.has(presenceKey(req)),
    } : null;
    // Mystery queue entries hide title + length from everyone except the
    // person who queued them — the list still shows who it came from.
    state.urlQueue = { length: urlStreamQueue.length, items: urlStreamQueue.map(q => {
        const isOwn = q.requestedBy?.username === req.session.user.username;
        const hide = q.mystery && !isOwn;
        return { id: q.id, title: hide ? null : q.title, duration: hide ? null : q.effectiveDuration, username: q.requestedBy?.username || null, mystery: !!q.mystery };
    }) };
    // Include all active tracks for multi-play
    if (multiPlayEnabled && activeTracks.size > 0) {
        const now = Date.now();
        state.tracks = [];
        for (const [id, t] of activeTracks) {
            const offset = t.startTimeOffset || 0;
            const elapsed = (now - (t.startTime || now)) / 1000;
            const maxPos = (t.duration != null && t.duration > 0) ? offset + t.duration : 999999;
            state.tracks.push({
                id,
                filename: t.filename,
                displayName: t.displayName,
                startTime: t.startTime,
                startTimeOffset: t.startTimeOffset,
                duration: t.duration,
                currentTime: Math.max(0, Math.min(maxPos, offset + elapsed)),
                startedBy: t.startedBy,
            });
        }
    }
    res.json(state);
});

// Play-count map keyed by filename — safe for all authenticated users (drives heatmap, badges).
app.get('/api/stats/play-counts', requireAuth, (req, res) => {
    res.json(statsDb.getPlayCounts());
});

// Paginated audit list — admin+ only.
app.get('/api/stats/plays', requireAdmin, (req, res) => {
    const toInt = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const from = toInt(req.query.from);
    const to = toInt(req.query.to);
    const user = req.query.user ? String(req.query.user) : null;
    const sound = req.query.sound ? String(req.query.sound) : null;
    const limit = toInt(req.query.limit) ?? 100;
    const offset = toInt(req.query.offset) ?? 0;
    res.json(statsDb.listPlays({ from, to, user, sound, limit, offset }));
});

function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/api/stats/plays.csv', requireAdmin, (req, res) => {
    const toInt = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const from = toInt(req.query.from);
    const to = toInt(req.query.to);
    const user = req.query.user ? String(req.query.user) : null;
    const sound = req.query.sound ? String(req.query.sound) : null;
    const { rows } = statsDb.listPlays({ from, to, user, sound, limit: 10000, offset: 0 });
    const header = ['id', 'sound_filename', 'display_name', 'user_id', 'user_role', 'guest_ip', 'started_at_iso', 'ended_at_iso', 'planned_duration_ms', 'actual_duration_ms', 'stopped_early'];
    const lines = [header.join(',')];
    for (const r of rows) {
        lines.push([
            r.id,
            csvEscape(r.sound_filename),
            csvEscape(r.display_name),
            csvEscape(r.user_id),
            csvEscape(r.user_role),
            csvEscape(r.guest_ip),
            r.started_at ? new Date(r.started_at).toISOString() : '',
            r.ended_at ? new Date(r.ended_at).toISOString() : '',
            r.planned_duration_ms ?? '',
            r.actual_duration_ms ?? '',
            r.stopped_early ? 1 : 0,
        ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="plays-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
});

// Daily play counts for heatmap (default last 90 days).
app.get('/api/stats/plays-per-day', requireAdmin, (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 90));
    const fromMs = Date.now() - days * 24 * 60 * 60 * 1000;
    res.json({ days, rows: statsDb.getPlaysPerDay(fromMs) });
});

// Admin action log (admin+ read, anyone with admin role).
app.get('/api/stats/admin-actions', requireAdmin, (req, res) => {
    const toInt = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const from = toInt(req.query.from);
    const to = toInt(req.query.to);
    const actor = req.query.actor ? String(req.query.actor) : null;
    const action = req.query.action ? String(req.query.action) : null;
    const limit = toInt(req.query.limit) ?? 100;
    const offset = toInt(req.query.offset) ?? 0;
    res.json(statsDb.listAdminActions({ from, to, actor, action, limit, offset }));
});

// Stop everything: active URL stream, both queues, the mixer, and reset state.
// Shared by POST /api/stop and the /stop slash command.
function stopAllPlayback() {
    // Clear the queues and the active URL stream before player.stop() — the Idle
    // handler it fires synchronously would otherwise start the next queued URL
    // stream we're trying to stop.
    if (urlSkipInProgress) urlSkipAbort = true; // cancel an in-flight crossfade
    killActiveUrlStream();
    urlStreamQueue.length = 0;
    urlSkipVotes.clear();
    ttsQueue.length = 0;
    ttsIsPlaying = false;
    player.stop();
    if (activeMixer) { activeMixer.destroy(); activeMixer = null; }
    activeTracks.clear();
    playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, startTimeOffset: null, duration: null, startedBy: null, pausedAt: null };
}

app.post('/api/stop', requireAdmin, (req, res) => {
    const role = req.session.user.role;
    const startedBy = playbackState.startedBy;
    if (role === 'admin' && startedBy && startedBy.role === 'superadmin') {
        return res.status(403).json({ error: 'Only superadmin can stop superadmin playback.' });
    }
    stopAllPlayback();
    res.json({ ok: true });
});

app.post('/api/pause', requireAdmin, async (req, res) => {
    const role = req.session.user.role;
    const startedBy = playbackState.startedBy;
    if (role === 'admin' && startedBy && startedBy.role === 'superadmin') {
        return res.status(403).json({ error: 'Only superadmin can pause superadmin playback.' });
    }
    const status = player.state.status;
    if (status === AudioPlayerStatus.Idle) {
        return res.status(400).json({ error: 'Nothing is playing.' });
    }
    if (status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused) {
        return res.json({ ok: true });
    }
    try {
        if (status === AudioPlayerStatus.Buffering) {
            await entersState(player, AudioPlayerStatus.Playing, 3000);
        }
        const offset = playbackState.startTimeOffset || 0;
        const maxPos = (playbackState.duration != null && playbackState.duration > 0) ? offset + playbackState.duration : 999999;
        const elapsed = (Date.now() - (playbackState.startTime || Date.now())) / 1000;
        playbackState.pausedAt = Math.max(0, Math.min(maxPos, offset + elapsed));
        const paused = player.pause(true);
        if (!paused) return res.status(500).json({ error: 'Could not pause playback.' });
        res.json({ ok: true });
    } catch (err) {
        console.error('Pause error:', err);
        res.status(500).json({ error: err.message || 'Could not pause playback.' });
    }
});

app.post('/api/resume', requireAdmin, (req, res) => {
    const role = req.session.user.role;
    const startedBy = playbackState.startedBy;
    if (role === 'admin' && startedBy && startedBy.role === 'superadmin') {
        return res.status(403).json({ error: 'Only superadmin can resume superadmin playback.' });
    }
    if (player.state.status !== AudioPlayerStatus.Paused && player.state.status !== AudioPlayerStatus.AutoPaused) {
        return res.json({ ok: true });
    }
    const fromPaused = playbackState.pausedAt ?? 0;
    playbackState.startTime = Date.now();
    playbackState.startTimeOffset = fromPaused;
    playbackState.pausedAt = undefined;
    const unpaused = player.unpause();
    if (!unpaused) return res.status(500).json({ error: 'Could not resume playback.' });
    res.json({ ok: true });
});

app.post('/api/volume', requireAdmin, (req, res) => {
    const { volume } = req.body;
    const v = parseFloat(volume);
    if (Number.isFinite(v)) {
        currentVolume = Math.max(0, Math.min(1, v));
        saveServerState({ volume: currentVolume });
    }
    if (player.state.resource?.volume) player.state.resource.volume.setVolume(currentVolume);
    res.send(`Volume set to ${currentVolume}`);
});

app.get('/api/volume', requireAuth, (req, res) => res.json({ volume: currentVolume }));

app.get('/api/settings/multi-play', requireAuth, (req, res) => res.json({ multiPlay: multiPlayEnabled }));
app.post('/api/settings/multi-play', requireAdmin, (req, res) => {
    multiPlayEnabled = !!req.body.enabled;
    saveServerState({ multiPlay: multiPlayEnabled });
    // If disabling multi-play and there are active mixed tracks, stop them
    if (!multiPlayEnabled && activeMixer && activeTracks.size > 0) {
        player.stop();
        if (activeMixer) { activeMixer.destroy(); activeMixer = null; }
        activeTracks.clear();
        playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, startTimeOffset: null, duration: null, startedBy: null, pausedAt: null };
    }
    res.json({ ok: true, multiPlay: multiPlayEnabled });
});

// --- Presence / online users ---
const PRESENCE_TIMEOUT_MS = 45 * 1000;
const activePresence = new Map(); // key -> { username, role, lastSeen }

function presenceKey(req) {
    const u = req.session.user;
    return u.role === 'guest' ? `guest:${u.ip || getClientIP(req)}` : `user:${u.username}`;
}

app.post('/api/heartbeat', requireAuth, (req, res) => {
    const u = req.session.user;
    const key = presenceKey(req);
    activePresence.set(key, { username: u.role === 'guest' ? null : u.username, role: u.role, lastSeen: Date.now() });
    res.json({ ok: true });
});

app.get('/api/online', requireAuth, (req, res) => {
    const now = Date.now();
    const online = [];
    activePresence.forEach((v, k) => {
        if (now - v.lastSeen <= PRESENCE_TIMEOUT_MS) {
            online.push({ username: v.username, role: v.role });
        } else {
            activePresence.delete(k);
        }
    });
    res.json(online);
});

// --- TTS endpoints ---

// Helper: fetch from TTS service with timeout
async function ttsFetch(urlPath, opts = {}) {
    if (!TTS_API_URL) return null;
    const controller = new AbortController();
    const timeoutMs = opts.timeout || 30000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Auto-attach the admin token for any /admin/* call so individual
    // proxies don't have to remember it (forgetting it returns 401 from
    // the TTS server, which the soundboard UI used to interpret as a
    // session expiry and kick to login).
    const headers = { ...(opts.headers || {}) };
    if (urlPath.startsWith('/admin/') && !headers['X-Admin-Token'] && !headers['x-admin-token']) {
        headers['X-Admin-Token'] = TTS_ADMIN_TOKEN || '';
    }
    try {
        const res = await fetch(`${TTS_API_URL}${urlPath}`, { ...opts, headers, signal: controller.signal });
        return res;
    } catch (e) {
        if (e.name === 'AbortError') {
            return { ok: false, status: 504, statusText: 'TTS service timeout', text: async () => 'Request timed out', arrayBuffer: async () => new ArrayBuffer(0) };
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
}

app.get('/api/tts/status', requireAuth, async (req, res) => {
    const available = !!TTS_API_URL;
    const enabled = getTtsEnabled();
    if (!available || !enabled) return res.json({ available, enabled, voices: [] });
    try {
        const r = await ttsFetch('/voices', { timeout: 5000 });
        if (!r || !r.ok) return res.json({ available: false, enabled, voices: [] });
        const allVoices = await r.json();
        const disabled = getTtsDisabledVoices();
        const role = req.session.user.role;
        if (role === 'superadmin') {
            res.json({ available: true, enabled, voices: allVoices, disabledVoiceIds: disabled, rvcOverrides: getTtsVoiceRvcOverrides() });
        } else {
            const voices = allVoices.filter(v => !disabled.includes(v.id));
            res.json({ available: true, enabled, voices });
        }
    } catch {
        res.json({ available: false, enabled, voices: [] });
    }
});

app.get('/api/tts/voices', requireAuth, async (req, res) => {
    if (!TTS_API_URL) return res.json([]);
    try {
        const r = await ttsFetch('/voices', { timeout: 5000 });
        if (!r || !r.ok) return res.json([]);
        const allVoices = await r.json();
        const disabled = getTtsDisabledVoices();
        const role = req.session.user.role;
        res.json(role === 'superadmin' ? allVoices : allVoices.filter(v => !disabled.includes(v.id)));
    } catch {
        res.json([]);
    }
});

app.post('/api/tts/speak', requireAuth, async (req, res) => {
    const { text, voiceId, volume: reqVolume, exaggeration: reqExag, forcedEmotion, useExpression } = req.body;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Text required' });
    if (!voiceId || typeof voiceId !== 'string') return res.status(400).json({ error: 'Voice ID required' });
    const ttsVolume = typeof reqVolume === 'number' ? Math.max(0, Math.min(2, reqVolume)) : 1;
    const exaggeration = typeof reqExag === 'number' ? Math.max(0.25, Math.min(2.0, reqExag)) : 0.5;
    // Expression preprocessor: on by default for Chatterbox voices unless the
    // caller explicitly disables via useExpression=false. Bracketed tags, caps
    // runs, trailing ellipses etc. become separate segments with their own
    // emotion preset on the TTS-server side.
    const expressionEnabled = useExpression !== false && voiceId.startsWith('cb_');

    const role = req.session.user.role;
    const isGuest = role === 'guest';
    const un = req.session.user.username;

    // Check TTS availability (honors per-user kill switch via username).
    if (!TTS_API_URL) return res.status(503).json({ error: 'TTS service not configured' });
    if (!getTtsEnabled(un)) return res.status(403).json({ error: 'TTS is disabled' });

    // Check if voice is disabled
    if (getTtsDisabledVoices().includes(voiceId)) return res.status(403).json({ error: 'This voice is currently disabled.' });

    // Check guest access
    if (isGuest) {
        if (!getGuestEnabled()) return res.status(403).json({ error: 'Guest access is disabled.' });
        const ip = getClientIP(req);
        if (isIPBlocked(ip)) return res.status(403).json({ error: 'Your IP has been blocked.' });
    }

    // Text length limit (per-user override wins over role default).
    const maxLen = getTtsMaxTextLength(role, un);
    if (maxLen <= 0) return res.status(403).json({ error: 'TTS is not available for your role.' });
    const trimmed = text.trim();
    if (trimmed.length > maxLen) return res.status(400).json({ error: `Text too long. Maximum ${maxLen} characters.` });
    if (!trimmed) return res.status(400).json({ error: 'Text is empty' });

    // TTS cooldown (separate from sound cooldown).
    const cooldownSec = getTtsCooldownSec(role, un);
    if (isGuest) {
        const ip = getClientIP(req);
        const last = ttsLastPlayByIP.get(ip);
        if (last != null && cooldownSec > 0) {
            const elapsed = (Date.now() - last) / 1000;
            if (elapsed < cooldownSec) return res.status(429).json({ error: `Wait ${Math.ceil(cooldownSec - elapsed)} seconds before using TTS again.`, cooldownRemaining: Math.ceil(cooldownSec - elapsed) });
        }
    } else if (role === 'user') {
        const un = req.session.user.username;
        const last = ttsLastPlayByUsername.get(un);
        if (last != null && cooldownSec > 0) {
            const elapsed = (Date.now() - last) / 1000;
            if (elapsed < cooldownSec) return res.status(429).json({ error: `Wait ${Math.ceil(cooldownSec - elapsed)} seconds before using TTS again.`, cooldownRemaining: Math.ceil(cooldownSec - elapsed) });
        }
    }

    // Require voice connection
    if (!activeGuildId || !getVoiceConnection(activeGuildId)) {
        return res.status(400).json({ error: 'Join a voice channel first' });
    }

    // Playback lock checks (same as /api/play)
    const meta = loadSoundsMeta();
    if (getPlaybackSuperadminOnly(meta) && role !== 'superadmin') {
        return res.status(403).json({ error: 'Only superadmin can play.' });
    }
    if (getPlaybackLocked(meta)) {
        const lockedBy = getPlaybackLockedBy(meta);
        if (lockedBy === 'superadmin') return res.status(403).json({ error: 'Playback is locked by superadmin.' });
        if (role === 'user' || isGuest) return res.status(403).json({ error: 'Playback is locked by an admin.' });
    }

    // Ensure voice connection is ready
    const conn = getVoiceConnection(activeGuildId);
    const connStatus = conn?.state?.status ?? 'no-connection';
    if (conn && connStatus !== 'ready') {
        try {
            await entersState(conn, VoiceConnectionStatus.Ready, 15000);
        } catch {
            return res.status(503).json({ error: 'Voice connection failed to establish.' });
        }
    }

    // Build the synth payload. When expression preprocessing is on, segments[]
    // overrides top-level exaggeration on the server side. Segments come from
    // lib/tts-expression.js which parses ALL CAPS / bracketed tags / ellipses /
    // !!! into emotion-tagged chunks; the TTS server maps each to a preset.
    // Pronunciation overrides run before synth + expression segmentation so
    // the rewritten phonetic spellings still get tagged with the right
    // emotion (the rewrite is just a string-substitution, no semantic
    // change). Display / recents / cache keep the original `trimmed`.
    const synthText = applyTtsPronunciationOverrides(trimmed);
    const synthPayload = { text: synthText, voice_id: voiceId, use_rvc: getTtsVoiceRvcOverrides()[voiceId] ?? true, exaggeration };
    if (expressionEnabled) {
        try {
            const { segmentText } = require('./lib/tts-expression');
            let segments = segmentText(synthText, forcedEmotion ? { forcedEmotion } : {});
            // LLM fallback: when the regex sees ONLY neutral and the text has
            // any real content (>=8 chars, ~3 words), give the configured LLM
            // a shot at detecting tone the regex missed (sarcasm, sadness,
            // excitement without !!!, etc.). Regex still wins for explicit cues.
            const needsLlm = !forcedEmotion
                && segments && segments.length === 1
                && segments[0].emotion === 'neutral'
                && trimmed.length >= 8;
            if (needsLlm) {
                try {
                    const llm = require('./lib/tts-emotion-llm');
                    if (!llm.isAvailable()) {
                        console.log('[TTS] LLM classifier disabled (EMOTION_LLM_ENABLED/URL/MODEL not set), keeping regex neutral');
                    } else {
                        const t0 = Date.now();
                        const llmSegs = await llm.classifyEmotion(trimmed);
                        const dt = Date.now() - t0;
                        if (!llmSegs) {
                            console.log('[TTS] LLM classifier returned null in %dms (see prior warn for cause), keeping neutral', dt);
                        } else if (llmSegs.length === 1 && llmSegs[0].emotion === 'neutral') {
                            console.log('[TTS] LLM agreed: neutral (%dms)', dt);
                        } else {
                            segments = llmSegs;
                            console.log('[TTS] LLM emotion override (%dms) segments=%d emotions=%s', dt, llmSegs.length, llmSegs.map(s => s.emotion).join(','));
                        }
                    }
                } catch (e) {
                    console.warn('[TTS] LLM classifier error (using regex result):', e.message);
                }
            }
            if (segments && segments.length > 1) {
                synthPayload.segments = segments;
                console.log('[TTS] expression segments=%d preview=%s', segments.length, segments.map(s => s.emotion).join(','));
            } else if (segments && segments.length === 1 && segments[0].emotion !== 'neutral') {
                // Even a single non-neutral segment benefits from the preset.
                synthPayload.segments = segments;
                console.log('[TTS] expression single-segment emotion=%s', segments[0].emotion);
            }
        } catch (e) {
            console.warn('[TTS] expression preprocess failed, falling back to flat synth:', e.message);
        }
    }

    // Disk-cache check: same payload → same WAV, skip the GPU round-trip.
    // Cache key canonicalizes the synth payload (text + voice_id + segments
    // + use_rvc + exaggeration etc.); volume stays out since it's applied
    // post-synth during Discord playback.
    const ttsCache = require('./lib/tts-cache');
    const cacheKey = ttsCache.keyFor(synthPayload);
    let wavBuffer = ttsCache.get(cacheKey);
    let cacheHit = !!wavBuffer;

    if (!wavBuffer) {
        // Call TTS service (serialized — parallel generations on the same GPU garble).
        console.log('[TTS] synth miss voice=%s text_len=%d pending=%d expr=%s', voiceId, trimmed.length, ttsSynthPending, !!synthPayload.segments);
        let ttsRes;
        try {
            ttsRes = await runTtsSynthSerially(() => {
                return ttsFetch('/synthesize', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(synthPayload),
                    timeout: 200000, // > fish-speech ~180s cold start (was 120000, guaranteed 504 on cold engine load)
                });
            });
        } catch (e) {
            console.error('[TTS] fetch error:', e);
            return res.status(503).json({ error: 'TTS service unreachable' });
        }
        if (!ttsRes || !ttsRes.ok) {
            const detail = ttsRes ? (await ttsRes.text().catch(() => ttsRes.statusText)) : 'unreachable';
            console.error('[TTS] synthesis failed:', detail);
            return res.status(502).json({ error: `TTS synthesis failed: ${detail}` });
        }
        try {
            const ab = await ttsRes.arrayBuffer();
            wavBuffer = Buffer.from(ab);
        } catch (e) {
            console.error('[TTS] buffer error:', e);
            return res.status(502).json({ error: 'Failed to read TTS audio' });
        }
        try { ttsCache.put(cacheKey, wavBuffer); } catch {}
    } else {
        console.log('[TTS] synth cache hit voice=%s text_len=%d sha=%s…', voiceId, trimmed.length, cacheKey.slice(0, 12));
    }

    // Cache for legacy "save last TTS" feature
    ttsLastBuffer.set(req.session.user.username, { wavBuffer, text: trimmed, voiceId, timestamp: Date.now() });
    // Short-lived handle for the frontend to fetch the WAV and render a live
    // waveform during playback (audio element plays muted locally; only the
    // AnalyserNode taps the samples).
    const localWavId = ttsWavCacheStash(wavBuffer, req.session.user.username);

    const startedBy = { username: req.session.user.username, role };
    const ttsDisplayName = `TTS: "${trimmed.length > 40 ? trimmed.slice(0, 40) + '...' : trimmed}"`;

    // Check queue size
    if (ttsQueue.length >= getTtsMaxQueueSize()) {
        return res.status(429).json({ error: `TTS queue is full (max ${getTtsMaxQueueSize()}). Wait for current clips to finish.` });
    }

    // Persist this TTS to the user's recents (skip guests — no persistent identity).
    let recentId = null;
    if (!isGuest) {
        try {
            const username = req.session.user.username;
            const ts = Date.now();
            const fname = `${username.replace(/[^a-zA-Z0-9_-]/g, '_')}_${ts}.wav`;
            const wavPath = path.join(TTS_RECENTS_DIR, fname);
            fs.writeFileSync(wavPath, wavBuffer);
            recentId = statsDb.insertTtsRecent({
                owner: username,
                text: trimmed,
                voiceId,
                voiceLabel: null,
                displayName: ttsDisplayName,
                wavPath: fname,
            });
            // Evict beyond TTS_RECENTS_PER_USER, deleting their WAV files.
            const toEvict = statsDb.listTtsRecentsBeyond(username, TTS_RECENTS_PER_USER);
            for (const old of toEvict) {
                try {
                    const p = path.join(TTS_RECENTS_DIR, path.basename(old.wav_path));
                    if (p.startsWith(TTS_RECENTS_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
                } catch (e) { console.warn('[TTS Recents] evict unlink failed:', e.message); }
                statsDb.deleteTtsRecent(old.id);
            }
        } catch (e) {
            console.warn('[TTS Recents] persist failed:', e.message);
        }
    }

    // Enqueue and process
    const queueItem = { id: ++ttsQueueIdCounter, wavBuffer, text: trimmed, voiceId, ttsVolume, displayName: ttsDisplayName, startedBy, username: req.session.user.username, recentId };
    ttsQueue.push(queueItem);
    const queuePosition = ttsQueue.length;
    console.log('[TTS Queue] enqueued #%d, position %d, voice=%s, recent=%s', queueItem.id, queuePosition, voiceId, recentId ?? '-');

    // Update cooldown
    if (isGuest) {
        ttsLastPlayByIP.set(getClientIP(req), Date.now());
    } else if (role === 'user') {
        ttsLastPlayByUsername.set(req.session.user.username, Date.now());
    }

    processTtsQueue();
    if (!isGuest) {
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: role,
            action: 'tts.speak',
            target: null,
            details: { voiceId, textLength: trimmed.length, preview: trimmed.slice(0, 80), recentId },
        });
    }
    res.json({ ok: true, queued: true, queuePosition, displayName: ttsDisplayName, startedBy, multiPlay: multiPlayEnabled, localWavId });
});

// Serve a freshly-synthesized TTS WAV by its short-lived token so the
// requesting browser can feed it through an AnalyserNode for the live
// waveform. Not a persistent asset — fetch once and play.
app.get('/api/tts/wav/:id', requireAuth, (req, res) => {
    const entry = ttsWavCache.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'WAV expired or not found' });
    const requester = String(req.session?.user?.username || '').toLowerCase();
    if (entry.owner && entry.owner !== requester) {
        // Cross-user replay attempts are masked as 404 instead of 403 so they
        // can't distinguish "wrong id" from "not your clip" — same response.
        return res.status(404).json({ error: 'WAV expired or not found' });
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.send(entry.buffer);
});

// --- TTS recents (per-user, max 5) ---

// List the most recent TTS clips across ALL users (global feed, most recent first).
// Guests see none. Non-guests see every user's clips so shared TTS history is visible.
app.get('/api/tts/recents', requireAuth, (req, res) => {
    if (req.session.user.role === 'guest') return res.json([]);
    // UI only surfaces 5 most recent globally — keep the per-request cap in
    // sync so we don't haul 30 rows over the wire every poll.
    const rows = statsDb.listTtsRecentsGlobal(5);
    const me = req.session.user.username;
    res.json(rows.map(r => ({
        id: r.id,
        owner: r.owner,
        mine: r.owner === me,
        text: r.text,
        voiceId: r.voice_id,
        voiceLabel: r.voice_label,
        displayName: r.display_name,
        createdAt: r.created_at,
    })));
});

// Re-queue a stored TTS clip to play in Discord (uses the original WAV).
app.post('/api/tts/recents/:id/replay', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    if (role === 'guest') return res.status(403).json({ error: 'Guests cannot replay TTS recents.' });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = statsDb.getTtsRecent(id);
    if (!row) return res.status(404).json({ error: 'Recent not found' });
    const wavPath = path.join(TTS_RECENTS_DIR, path.basename(row.wav_path));
    if (!wavPath.startsWith(TTS_RECENTS_DIR) || !fs.existsSync(wavPath)) {
        return res.status(404).json({ error: 'Audio file missing' });
    }
    // Voice-connection + playback-lock checks (same spirit as /api/tts/speak).
    if (!TTS_API_URL) return res.status(503).json({ error: 'TTS service not configured' });
    if (!activeGuildId || !getVoiceConnection(activeGuildId)) return res.status(400).json({ error: 'Join a voice channel first' });
    const meta = loadSoundsMeta();
    if (getPlaybackSuperadminOnly(meta) && role !== 'superadmin') return res.status(403).json({ error: 'Only superadmin can play.' });
    if (getPlaybackLocked(meta)) {
        const lockedBy = getPlaybackLockedBy(meta);
        if (lockedBy === 'superadmin' && role !== 'superadmin') return res.status(403).json({ error: 'Playback is locked by superadmin.' });
        if (role === 'user') return res.status(403).json({ error: 'Playback is locked by an admin.' });
    }
    if (ttsQueue.length >= getTtsMaxQueueSize()) {
        return res.status(429).json({ error: `TTS queue is full (max ${getTtsMaxQueueSize()}).` });
    }
    let wavBuffer;
    try { wavBuffer = fs.readFileSync(wavPath); }
    catch (e) { return res.status(500).json({ error: 'Failed to read stored audio' }); }
    const startedBy = { username: req.session.user.username, role };
    const queueItem = { id: ++ttsQueueIdCounter, wavBuffer, text: row.text, voiceId: row.voice_id, ttsVolume: 1, displayName: row.display_name || `TTS: "${row.text.slice(0, 40)}"`, startedBy, username: req.session.user.username, recentId: row.id };
    ttsQueue.push(queueItem);
    processTtsQueue();
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: role,
        action: 'tts.replay',
        target: String(row.id),
        details: { owner: row.owner, voiceId: row.voice_id, preview: String(row.text || '').slice(0, 80) },
    });
    const localWavId = ttsWavCacheStash(wavBuffer, req.session.user.username);
    res.json({ ok: true, queued: true, queuePosition: ttsQueue.length, displayName: queueItem.displayName, localWavId });
});

// Save a stored TTS recent as a permanent sound (WAV → MP3, adds tts metadata).
app.post('/api/tts/recents/:id/save-as-sound', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    if (role === 'guest') return res.status(403).json({ error: 'Guests cannot save TTS clips.' });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = statsDb.getTtsRecent(id);
    if (!row) return res.status(404).json({ error: 'Recent not found' });
    const wavPath = path.join(TTS_RECENTS_DIR, path.basename(row.wav_path));
    if (!wavPath.startsWith(TTS_RECENTS_DIR) || !fs.existsSync(wavPath)) {
        return res.status(404).json({ error: 'Audio file missing' });
    }

    const { displayName, tags } = req.body || {};
    const baseName = (displayName || row.text || 'tts').trim();
    let safeName = baseName.replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_').substring(0, 80);
    if (!safeName) safeName = 'tts_clip';
    safeName += '.mp3';
    let finalName = safeName;
    let counter = 1;
    while (fs.existsSync(path.join(SOUNDS_DIR, finalName))) {
        finalName = safeName.replace('.mp3', `_${counter}.mp3`);
        counter++;
    }
    const targetPath = path.join(SOUNDS_DIR, finalName);
    try {
        await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', ['-nostdin', '-i', wavPath, '-b:a', '192k', '-y', targetPath], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            ff.stderr.on('data', chunk => { stderr += chunk.toString(); });
            ff.on('error', reject);
            ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-200)}`)));
        });
    } catch (e) {
        console.error('[TTS Save] ffmpeg error:', e);
        return res.status(500).json({ error: 'Failed to convert audio' });
    }
    const duration = probeDuration(targetPath);
    const meta = { displayName: displayName || row.text.substring(0, 80) };
    if (duration != null) meta.duration = duration;
    meta.tags = Array.isArray(tags) && tags.length ? tags : ['TTS'];
    meta.tts = { text: row.text, voiceId: row.voice_id, voiceLabel: row.voice_label || null };
    setSoundMeta(finalName, meta);
    console.log('[TTS Save] saved recent %d as %s by %s', row.id, finalName, req.session.user.username);
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: role,
        action: 'tts.save-as-sound',
        target: finalName,
        details: { recentId: row.id, owner: row.owner, voiceId: row.voice_id, displayName: meta.displayName },
    });
    res.json({ ok: true, filename: finalName, displayName: meta.displayName, duration });
});

// Remove a stored recent and its WAV file.
// Only the clip's owner or a superadmin can delete (protects other users' history).
app.delete('/api/tts/recents/:id', requireAuth, (req, res) => {
    if (req.session.user.role === 'guest') return res.status(403).json({ error: 'Guests have no recents.' });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = statsDb.getTtsRecent(id);
    if (!row) return res.status(404).json({ error: 'Recent not found' });
    const me = req.session.user.username;
    const isOwner = row.owner === me;
    const isSuperadmin = req.session.user.role === 'superadmin';
    if (!isOwner && !isSuperadmin) return res.status(403).json({ error: 'Only the clip owner or a superadmin can remove this.' });
    try {
        const p = path.join(TTS_RECENTS_DIR, path.basename(row.wav_path));
        if (p.startsWith(TTS_RECENTS_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { console.warn('[TTS Recents] unlink failed:', e.message); }
    statsDb.deleteTtsRecent(row.id);
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'tts.recents-delete',
        target: String(row.id),
        details: { owner: row.owner, selfDelete: isOwner, preview: String(row.text || '').slice(0, 80) },
    });
    res.json({ ok: true });
});

app.post('/api/tts/queue/clear', requireSuperadmin, (req, res) => {
    const cleared = ttsQueue.length;
    ttsQueue.length = 0;
    // Force-release the "playing" flag too. Admins only use this button when
    // the queue is wedged, so assuming ttsIsPlaying is stale is the right
    // default — otherwise clearing the queue still wouldn't unblock items
    // that were about to enqueue after the stuck ffmpeg.
    const wasStuck = ttsIsPlaying && player.state.status === AudioPlayerStatus.Idle;
    if (wasStuck) ttsIsPlaying = false;
    console.log('[TTS Queue] cleared by %s (items=%d, wasStuck=%s)', req.session.user.username, cleared, wasStuck);
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'tts.queue-clear',
        target: null,
        details: { cleared, wasStuck },
    });
    res.json({ ok: true, cleared, wasStuck });
});

// --- Superadmin: Chatterbox voice management ---

const ttsVoiceUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: ttsVoiceAdmin.MAX_UPLOAD_BYTES },
});
const TTS_ADMIN_TOKEN = (process.env.TTS_ADMIN_TOKEN || '').trim();

function ttsAdminError(res, err) {
    const status = (err && err.status) || 500;
    const msg = (err && err.message) || 'Voice admin error';
    return res.status(status).json({ error: msg });
}

// ---------------------------------------------------------------------------
// Admin voice-preview job queue. Long-running ops (demucs isolate, diarize
// extract) blow past Cloudflare's 100 s edge timeout, and if the operator
// triggers two at once they'd compete for tts-server threads. So the UI
// kicks them off as async jobs: synchronous endpoint returns { jobId }
// immediately, the worker drains one at a time, the client polls for
// status + progress. Same pattern can host future long ops (Fish LoRA,
// batch preprocess, etc.) without rewiring the UI flow.
// ---------------------------------------------------------------------------
const PREVIEW_JOBS = new Map();   // jobId -> job state
const PREVIEW_JOB_QUEUE = [];     // pending jobIds
const PREVIEW_JOB_TTL_MS = 30 * 60 * 1000;   // drop completed jobs after 30 min
let PREVIEW_JOB_WORKER_RUNNING = false;

function _sweepPreviewJobs() {
    const now = Date.now();
    for (const [id, j] of PREVIEW_JOBS) {
        if ((j.status === 'done' || j.status === 'error') && (now - (j.finishedAt || j.startedAt || now)) > PREVIEW_JOB_TTL_MS) {
            PREVIEW_JOBS.delete(id);
        }
    }
}
setInterval(_sweepPreviewJobs, 5 * 60 * 1000);

function _expectedStepMs(step, durationSec) {
    // Rough upper bounds for the progress-bar UI. demucs ~0.4x realtime,
    // resemblyzer+KMeans ~0.06x. Never 0 so the UI always shows motion.
    const d = Math.max(1, durationSec || 10);
    if (step === 'isolate') return Math.round(d * 400 + 4000);
    if (step === 'extract') return Math.round(d * 80 + 2000);
    return 5000;
}

async function _runIsolateStep(job) {
    job.step = 'isolate';
    job.stepStartedAt = Date.now();
    job.stepExpectedMs = _expectedStepMs('isolate', job.durationSec);
    const info = await maybeIsolatePreview(job.token);
    job.isolateInfo = info;
}

async function _runExtractStep(job) {
    job.step = 'extract';
    job.stepStartedAt = Date.now();
    job.stepExpectedMs = _expectedStepMs('extract', job.durationSec);
    const info = await maybeExtractSpeakerPreview(job.token);
    job.extractInfo = info;
}

async function _runPreviewJob(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    try {
        if (job.steps.includes('isolate')) await _runIsolateStep(job);
        if (job.steps.includes('extract')) await _runExtractStep(job);
        job.status = 'done';
        job.step = null;
    } catch (err) {
        job.status = 'error';
        job.error = (err && err.message) || String(err);
    } finally {
        job.finishedAt = Date.now();
    }
}

async function _drainPreviewJobQueue() {
    if (PREVIEW_JOB_WORKER_RUNNING) return;
    PREVIEW_JOB_WORKER_RUNNING = true;
    try {
        while (PREVIEW_JOB_QUEUE.length) {
            const jobId = PREVIEW_JOB_QUEUE.shift();
            const job = PREVIEW_JOBS.get(jobId);
            if (!job || job.status === 'cancelled') continue;
            await _runPreviewJob(job);
        }
    } finally {
        PREVIEW_JOB_WORKER_RUNNING = false;
    }
}

function _enqueuePreviewJob({ token, durationSec, steps }) {
    const jobId = require('crypto').randomBytes(8).toString('hex');
    const job = {
        id: jobId, token,
        steps,                  // ['isolate'] or ['extract'] or ['isolate','extract']
        durationSec,
        status: 'queued',       // queued | running | done | error | cancelled
        step: null,             // current step while running
        createdAt: Date.now(),
        startedAt: null,
        stepStartedAt: null,
        stepExpectedMs: null,
        finishedAt: null,
        isolateInfo: null,
        extractInfo: null,
        error: null,
    };
    PREVIEW_JOBS.set(jobId, job);
    PREVIEW_JOB_QUEUE.push(jobId);
    _drainPreviewJobQueue();
    return job;
}

app.post('/api/superadmin/tts/preview/:token/process', requireSuperadmin, async (req, res) => {
    const { token } = req.params;
    const isolate = !!(req.body && req.body.isolate);
    const extractSpeaker = !!(req.body && req.body.extractSpeaker);
    if (!isolate && !extractSpeaker) return res.status(400).json({ error: 'Nothing to do (neither isolate nor extractSpeaker set)' });
    const previewPath = ttsVoiceAdmin.getPreviewPath(token);
    if (!previewPath) return res.status(404).json({ error: 'Preview not found' });
    const durationSec = await ttsVoiceAdmin.probeDuration(previewPath);
    const steps = [];
    if (isolate) steps.push('isolate');
    if (extractSpeaker) steps.push('extract');
    const job = _enqueuePreviewJob({ token, durationSec, steps });
    res.json({
        jobId: job.id,
        status: job.status,
        steps: job.steps,
        durationSec,
        queuedBehind: Math.max(0, PREVIEW_JOB_QUEUE.length - 1),
    });
});

app.get('/api/superadmin/tts/preview-jobs/:jobId', requireSuperadmin, (req, res) => {
    const job = PREVIEW_JOBS.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });
    // Derive a coarse progress number so the UI can show a bar. For queued
    // jobs it's 0; for running jobs it's elapsed-step/expected-step within
    // the step's slice of the total pipeline.
    let progress = 0;
    if (job.status === 'done') progress = 1;
    else if (job.status === 'running' && job.step && job.stepExpectedMs) {
        const elapsed = Date.now() - job.stepStartedAt;
        const stepProgress = Math.min(0.99, elapsed / job.stepExpectedMs);
        const stepIdx = job.steps.indexOf(job.step);
        const perStep = 1 / job.steps.length;
        progress = stepIdx * perStep + stepProgress * perStep;
    }
    res.json({
        id: job.id,
        status: job.status,
        step: job.step,
        steps: job.steps,
        progress: Math.round(progress * 100) / 100,
        error: job.error,
        isolateInfo: job.isolateInfo,
        extractInfo: job.extractInfo,
        queuedBehind: job.status === 'queued' ? PREVIEW_JOB_QUEUE.indexOf(job.id) : 0,
        elapsedMs: job.startedAt ? (job.finishedAt || Date.now()) - job.startedAt : 0,
    });
});

// When the operator checks "Extract dominant speaker", POST the preview to
// tts-server's /admin/util/extract-speaker (resemblyzer + KMeans n=2 in the
// GPT-SoVITS venv) and overwrite the staged preview with the dominant-
// speaker-only cut. Useful when the source window is a conversation.
async function maybeExtractSpeakerPreview(token) {
    const previewPath = ttsVoiceAdmin.getPreviewPath(token);
    if (!previewPath) throw Object.assign(new Error('Preview vanished before speaker extraction'), { status: 500 });
    const audio = fs.readFileSync(previewPath);
    const form = new FormData();
    form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'preview.wav');
    const r = await fetch(`${TTS_API_URL}/admin/util/extract-speaker`, {
        method: 'POST', body: form,
        headers: { 'X-Admin-Token': TTS_ADMIN_TOKEN || '' },
        signal: AbortSignal.timeout(180_000),
    });
    if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw Object.assign(new Error(body.detail || body.error || `extract-speaker ${r.status}`), { status: r.status === 401 ? 502 : r.status });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(previewPath, buf);
    let clusters = null;
    try { clusters = JSON.parse(r.headers.get('x-extract-cluster-sizes') || '{}'); } catch {}
    return {
        elapsed: Number(r.headers.get('x-extract-elapsed-sec')) || null,
        durationSec: Number(r.headers.get('x-extract-duration-sec')) || null,
        dominantCluster: r.headers.get('x-extract-dominant-cluster') || null,
        clusters,
    };
}

// When the operator checks "Isolate vocals", POST the just-trimmed preview
// to tts-server's /admin/util/isolate-vocals (htdemucs on CPU, ~25 s for
// 60 s of audio) and overwrite the staged preview file with the vocals-only
// version. Returns a small metrics dict so the UI can show elapsed time.
async function maybeIsolatePreview(token) {
    const previewPath = ttsVoiceAdmin.getPreviewPath(token);
    if (!previewPath) throw Object.assign(new Error('Preview vanished before isolation'), { status: 500 });
    const audio = fs.readFileSync(previewPath);
    const form = new FormData();
    form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'preview.wav');
    const r = await fetch(`${TTS_API_URL}/admin/util/isolate-vocals`, {
        method: 'POST', body: form,
        headers: { 'X-Admin-Token': TTS_ADMIN_TOKEN || '' },
        // demucs on CPU: ~25s for 60s, ~2min for 300s clips
        signal: AbortSignal.timeout(360_000),
    });
    if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw Object.assign(new Error(body.detail || body.error || `isolate ${r.status}`), { status: r.status === 401 ? 502 : r.status });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(previewPath, buf);
    return {
        elapsed: Number(r.headers.get('x-isolate-elapsed-sec')) || null,
        peakPreGain: Number(r.headers.get('x-isolate-peak-pre-gain')) || null,
    };
}

// NOTE: isolate/extract are now run as async jobs via
// POST /api/superadmin/tts/preview/:token/process after a preview token is
// returned. These source/* endpoints only do the cheap fetch+trim path so
// they always finish well under Cloudflare's 100 s edge timeout.
app.post('/api/superadmin/tts/source/youtube', requireSuperadmin, async (req, res) => {
    const { url, startSec, endSec } = req.body || {};
    console.log('[voice-source/youtube] user=%s url=%s range=%s..%s',
        req.session.user.username, String(url || '').slice(0, 80), startSec, endSec);
    if (!ttsVoiceAdmin.validateYouTubeUrl(url)) {
        console.log('[voice-source/youtube] rejected invalid URL: %s', url);
        return res.status(400).json({ error: 'Provide a youtube.com or youtu.be URL.' });
    }
    try {
        const { sourcePath, cached } = await ttsVoiceAdmin.fetchYouTubeSource(url);
        const sourceDuration = await ttsVoiceAdmin.probeDuration(sourcePath);
        const { token, duration } = await ttsVoiceAdmin.extractClip(sourcePath, startSec, endSec);
        console.log('[voice-source/youtube] ok token=%s duration=%.2fs sourceDur=%.2fs cached=%s', token, duration, sourceDuration, cached);
        res.json({ token, duration, sourceDuration, sourceCached: cached, previewUrl: `/api/superadmin/tts/preview/${token}` });
    } catch (err) {
        console.error('[voice-source/youtube] failed:', (err && err.stack) || err);
        ttsAdminError(res, err);
    }
});

app.post('/api/superadmin/tts/source/upload', requireSuperadmin, ttsVoiceUpload.single('audio'), async (req, res) => {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No audio file uploaded' });
    const { startSec, endSec } = req.body || {};
    ttsVoiceAdmin.ensureStaging();
    const sourceId = require('crypto').randomBytes(8).toString('hex');
    const sourcePath = require('path').join(ttsVoiceAdmin.STAGING_DIR, `source-upload-${sourceId}.bin`);
    try {
        require('fs').writeFileSync(sourcePath, req.file.buffer);
        const sourceDuration = await ttsVoiceAdmin.probeDuration(sourcePath);
        if (sourceDuration <= 0) {
            try { require('fs').unlinkSync(sourcePath); } catch {}
            return res.status(400).json({ error: 'Could not read audio file (unsupported format?)' });
        }
        const { token, duration } = await ttsVoiceAdmin.extractClip(sourcePath, startSec, endSec);
        res.json({ token, duration, sourceDuration, sourceRef: sourceId, previewUrl: `/api/superadmin/tts/preview/${token}` });
    } catch (err) {
        ttsAdminError(res, err);
    }
});

app.post('/api/superadmin/tts/source/retrim', requireSuperadmin, async (req, res) => {
    const { url, sourceRef, startSec, endSec } = req.body || {};
    try {
        let sourcePath;
        if (sourceRef) {
            const candidate = require('path').join(ttsVoiceAdmin.STAGING_DIR, `source-upload-${String(sourceRef).replace(/[^a-f0-9]/gi, '')}.bin`);
            if (!require('fs').existsSync(candidate)) return res.status(404).json({ error: 'Uploaded source expired — please re-upload.' });
            sourcePath = candidate;
        } else if (url) {
            const result = await ttsVoiceAdmin.fetchYouTubeSource(url);
            sourcePath = result.sourcePath;
        } else {
            return res.status(400).json({ error: 'Need url or sourceRef' });
        }
        const { token, duration } = await ttsVoiceAdmin.extractClip(sourcePath, startSec, endSec);
        res.json({ token, duration, previewUrl: `/api/superadmin/tts/preview/${token}` });
    } catch (err) {
        ttsAdminError(res, err);
    }
});

app.get('/api/superadmin/tts/preview/:token', requireSuperadmin, (req, res) => {
    const previewPath = ttsVoiceAdmin.getPreviewPath(req.params.token);
    if (!previewPath) return res.status(404).json({ error: 'Preview not found' });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(previewPath).pipe(res);
});

app.post('/api/superadmin/tts/voice', requireSuperadmin, async (req, res) => {
    const { voiceId, name, group, gender, skipRvc, defaultExaggeration, token, source } = req.body || {};
    const dirId = ttsVoiceAdmin.normalizeVoiceId(voiceId);
    if (!dirId) return res.status(400).json({ error: 'Voice id must be lowercase letters, digits, or underscores (e.g. rfk_jr).' });
    const previewPath = ttsVoiceAdmin.getPreviewPath(token);
    if (!previewPath) return res.status(400).json({ error: 'Preview not found — re-cut the clip and try again.' });
    try {
        const result = await ttsVoiceAdmin.commitToTtsServer({
            ttsApiUrl: TTS_API_URL,
            adminToken: TTS_ADMIN_TOKEN,
            voiceId: dirId,
            name, group, gender, skipRvc,
            defaultExaggeration: typeof defaultExaggeration === 'number' ? defaultExaggeration : undefined,
            source: source && typeof source === 'object' ? source : null,
            previewPath,
        });
        ttsVoiceAdmin.deletePreview(token);
        res.json({ ok: true, voice: result });
    } catch (err) {
        ttsAdminError(res, err);
    }
});

// Upload a per-emotion reference clip for a Chatterbox voice. Proxies to
// PUT /voices/chatterbox/:id/refs/:emotion on the TTS server with the
// admin token. Accepts multipart/form-data from the browser.
app.put('/api/superadmin/tts/voice/:id/refs/:emotion', requireSuperadmin, ttsVoiceUpload.single('audio'), async (req, res) => {
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    const emotion = String(req.params.emotion || '').toLowerCase();
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Audio file required (multipart field "audio")' });
    const engine = (req.query.engine === 'fish') ? 'fish' : 'chatterbox';
    try {
        // Use Node 18+'s native FormData / Blob via undici — no extra npm dep.
        const form = new FormData();
        form.append('audio', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' }), 'ref.wav');
        const url = `${TTS_API_URL}/voices/${engine}/${encodeURIComponent(dirId)}/refs/${encodeURIComponent(emotion)}`;
        const fetchRes = await fetch(url, {
            method: 'PUT', body: form,
            headers: { 'X-Admin-Token': TTS_ADMIN_TOKEN || '' },
        });
        const body = await fetchRes.json().catch(() => ({}));
        if (!fetchRes.ok) return res.status(fetchRes.status).json(body);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: `voice.upload-emotion-ref-${engine}`,
            target: dirId,
            details: { emotion, bytes: req.file.size, engine },
        });
        res.json(body);
    } catch (err) {
        ttsAdminError(res, err);
    }
});

app.delete('/api/superadmin/tts/voice/:id/refs/:emotion', requireSuperadmin, async (req, res) => {
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    const emotion = String(req.params.emotion || '').toLowerCase();
    const engine = (req.query.engine === 'fish') ? 'fish' : 'chatterbox';
    try {
        const url = `${TTS_API_URL}/voices/${engine}/${encodeURIComponent(dirId)}/refs/${encodeURIComponent(emotion)}`;
        const fetchRes = await fetch(url, {
            method: 'DELETE',
            headers: { 'X-Admin-Token': TTS_ADMIN_TOKEN || '' },
        });
        const body = await fetchRes.json().catch(() => ({}));
        if (!fetchRes.ok) return res.status(fetchRes.status).json(body);
        res.json(body);
    } catch (err) {
        ttsAdminError(res, err);
    }
});

// One-click: analyze the voice's dataset chunks and auto-pick a reference
// clip per emotion (soft / neutral / excited / yell / angry / sad / happy).
// Only works for voices that were trained via the RVC pipeline (dataset
// archive lives at tts-server/models/datasets/<voice>/chunks/).
app.post('/api/superadmin/tts/voice/:id/auto-emotion-refs', requireSuperadmin, async (req, res) => {
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    const overwrite = req.body?.overwrite !== false;
    const engine = (req.query.engine === 'fish') ? 'fish' : 'chatterbox';
    try {
        const url = `${TTS_API_URL}/admin/voices/${engine}/${encodeURIComponent(dirId)}/auto-emotion-refs?overwrite=${overwrite}`;
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'X-Admin-Token': TTS_ADMIN_TOKEN || '' },
            // server analyzes ~50-500 chunks × librosa features; can take a minute
            signal: AbortSignal.timeout(600_000),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status).json(body);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'voice.auto-emotion-refs',
            target: dirId,
            details: { chunks_analyzed: body.chunks_analyzed, emotions_picked: body.refs ? Object.keys(body.refs).length : 0 },
        });
        res.json(body);
    } catch (err) {
        ttsAdminError(res, err);
    }
});

// Create OR replace a Fish/GSV voice. multipart/form-data:
//   - audio (optional) — new reference clip
//   - metadata (optional, JSON string) — { name, gender, group, ref_text }
// At least one must be present. Server re-transcribes when audio changes
// unless the metadata explicitly supplies ref_text.
app.put('/api/superadmin/tts/voice-engine/:engine/:id', requireSuperadmin, ttsVoiceUpload.single('audio'), async (req, res) => {
    const engine = req.params.engine;
    if (!['gptsovits', 'fish'].includes(engine)) return res.status(400).json({ error: 'Unsupported engine' });
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    try {
        const form = new FormData();
        let usedToken = false;
        if (req.file && req.file.buffer) {
            form.append('audio', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' }), req.file.originalname || 'ref.wav');
        } else if (req.body && req.body.token) {
            // Token from the YouTube/Upload preview pipeline. Resolve to staged
            // wav and forward as the audio payload so tts-server treats it the
            // same as a direct upload.
            const previewPath = ttsVoiceAdmin.getPreviewPath(req.body.token);
            if (!previewPath) return res.status(400).json({ error: 'Preview not found — re-cut the clip and try again.' });
            const audio = fs.readFileSync(previewPath);
            form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'reference.wav');
            usedToken = true;
        }
        if (req.body && req.body.metadata) {
            form.append('metadata', String(req.body.metadata));
        }
        const url = `${TTS_API_URL}/admin/voices/${engine}/${encodeURIComponent(dirId)}`;
        const r = await fetch(url, {
            method: 'PUT', body: form,
            headers: { 'X-Admin-Token': TTS_ADMIN_TOKEN || '' },
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
            const upstream = r.status === 401 ? 502 : r.status;
            return res.status(upstream).json({ error: body.detail || body.error || `TTS ${r.status}` });
        }
        if (usedToken) ttsVoiceAdmin.deletePreview(req.body.token);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: (req.file || usedToken) ? `voice.upsert-${engine}-audio` : `voice.edit-${engine}-meta`,
            target: dirId,
            details: { ref_text: String(body.ref_text || '').slice(0, 80), name: body.name, source: usedToken ? 'preview-token' : (req.file ? 'multipart' : 'meta-only') },
        });
        res.json(body);
    } catch (err) { ttsAdminError(res, err); }
});

// Synth a short test clip and return raw WAV bytes for in-browser preview.
// Doesn't queue to Discord — purely for auditioning a voice before using it.
// Humanize the TTS message via the Ollama LLM — adds uhhs / commas / pauses
// so the synth sounds less robotic. Client calls this first when the user
// ticks "humanize" on the TTS card, then sends the returned text to /speak.
// Safe to call even if the LLM is unavailable: returns the original on any
// failure, with `changed: false` so the client can decide whether to show a
// "couldn't humanize" hint.
app.post('/api/tts/humanize', requireAuth, async (req, res) => {
    if (req.session.user.role === 'guest') return res.status(403).json({ error: 'Guests cannot humanize.' });
    const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
    const voiceName = (req.body && typeof req.body.voiceName === 'string') ? req.body.voiceName.slice(0, 80) : '';
    // Engine tells the humanize LLM which inline [tag] vocabulary is safe
    // to insert — Fish handles 15k+ free-form descriptors, Chatterbox only
    // the expression preprocessor's small set.
    const engine = (req.body && typeof req.body.engine === 'string') ? req.body.engine.slice(0, 20).toLowerCase() : '';
    if (!text.trim()) return res.status(400).json({ error: 'Text required' });
    if (text.length > 2000) return res.status(400).json({ error: 'Text too long for humanize (>2000 chars)' });
    try {
        const humanize = require('./lib/tts-humanize-llm');
        if (!humanize.isAvailable()) {
            return res.json({ available: false, text, humanized: text, changed: false });
        }
        const out = await humanize.humanize(text, voiceName, engine);
        res.json({ available: true, text, humanized: out, changed: out !== text, voiceName, engine });
    } catch (e) {
        console.warn('[tts-humanize] error:', e && e.message);
        res.json({ available: true, text, humanized: text, changed: false, error: (e && e.message) || 'unknown' });
    }
});

// Rewrite the TTS message in the selected voice's style — unlike humanize,
// this can reshape phrasing, length, and vocabulary to match how the
// speaker would actually say it (Trump → rally riff, Herzog → philosophical
// narration). Client invokes this from the sparkle button on the TTS card;
// the returned text replaces the textarea value, and the user can still
// toggle humanize + send as normal.
app.post('/api/tts/rewrite', requireAuth, async (req, res) => {
    if (req.session.user.role === 'guest') return res.status(403).json({ error: 'Guests cannot rewrite.' });
    const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
    const voiceName = (req.body && typeof req.body.voiceName === 'string') ? req.body.voiceName.slice(0, 80) : '';
    const engine = (req.body && typeof req.body.engine === 'string') ? req.body.engine.slice(0, 20).toLowerCase() : '';
    if (!text.trim()) return res.status(400).json({ error: 'Text required' });
    if (text.length > 2000) return res.status(400).json({ error: 'Text too long for rewrite (>2000 chars)' });
    try {
        const rewriter = require('./lib/tts-rewrite-llm');
        if (!rewriter.isAvailable()) {
            return res.json({ available: false, text, rewritten: text, changed: false });
        }
        const out = await rewriter.rewrite(text, voiceName, engine);
        res.json({ available: true, text, rewritten: out, changed: out !== text, voiceName, engine });
    } catch (e) {
        console.warn('[tts-rewrite] error:', e && e.message);
        res.json({ available: true, text, rewritten: text, changed: false, error: (e && e.message) || 'unknown' });
    }
});

// Stitch a list of TTS WAV buffers into one WAV with per-line silence gaps.
// Uses ffmpeg's adelay+concat filter graph so we don't depend on all lines
// sharing the same PCM codec/sample-rate (ffmpeg transcodes as it concatenates).
// Returns a single WAV buffer. Temp dir is cleaned up best-effort.
async function stitchConversationWavs(wavs) {
    if (!Array.isArray(wavs) || wavs.length === 0) throw new Error('no lines to stitch');
    if (wavs.length === 1 && !(wavs[0].pauseMs > 0)) return wavs[0].buffer;

    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-conv-'));
    const tmpFiles = [];
    try {
        for (let i = 0; i < wavs.length; i++) {
            const p = path.join(tmpDir, `line_${i}.wav`);
            fs.writeFileSync(p, wavs[i].buffer);
            tmpFiles.push(p);
        }
        const args = ['-nostdin'];
        for (const f of tmpFiles) { args.push('-i', f); }
        const filterParts = [];
        const concatLabels = [];
        for (let i = 0; i < wavs.length; i++) {
            const delay = Math.max(0, Math.min(5000, wavs[i].pauseMs | 0));
            if (delay > 0) {
                filterParts.push(`[${i}:a]adelay=${delay}:all=1[d${i}]`);
                concatLabels.push(`[d${i}]`);
            } else {
                concatLabels.push(`[${i}:a]`);
            }
        }
        filterParts.push(`${concatLabels.join('')}concat=n=${wavs.length}:v=0:a=1[out]`);
        args.push('-filter_complex', filterParts.join(';'), '-map', '[out]', '-ar', '24000', '-ac', '1', '-f', 'wav', '-');

        return await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const chunks = [];
            const stderr = [];
            ff.stdout.on('data', c => chunks.push(c));
            ff.stderr.on('data', c => stderr.push(c));
            ff.on('error', reject);
            ff.on('close', (code) => {
                if (code !== 0) return reject(new Error('ffmpeg exited ' + code + ': ' + Buffer.concat(stderr).toString('utf8').slice(-400)));
                resolve(Buffer.concat(chunks));
            });
        });
    } finally {
        try {
            for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
            fs.rmdirSync(tmpDir);
        } catch {}
    }
}

// NOTE: /api/tts/takes + /api/tts/takes/commit were removed 2026-04-22.
// Fish (the only engine in active use) is deterministic, so N takes returned
// N identical WAVs. Revisit if a stochastic engine becomes the default again
// — the old client-side picker is also gone.

// Multi-voice TTS conversation — synthesizes an ordered list of {voice, text}
// lines, optionally humanizes each through its speaker profile, and stitches
// them into a single WAV (per-line silence pads for pacing). Runs through the
// normal Discord queue as a single playback entry. Same role / playback-lock
// gates as /api/tts/speak; cooldown counts the whole conversation as one play.
app.post('/api/tts/conversation', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    const un = req.session.user.username;
    if (role === 'guest') return res.status(403).json({ error: 'Guests cannot use conversation mode.' });
    const body = req.body || {};
    const lines = Array.isArray(body.lines) ? body.lines : null;
    if (!lines || !lines.length) return res.status(400).json({ error: 'Lines required' });
    if (lines.length > 12) return res.status(400).json({ error: 'Max 12 lines per conversation' });

    const volume = typeof body.volume === 'number' ? Math.max(0, Math.min(2, body.volume)) : 1;

    if (!TTS_API_URL) return res.status(503).json({ error: 'TTS service not configured' });
    if (!getTtsEnabled(un)) return res.status(403).json({ error: 'TTS is disabled' });

    const maxLen = getTtsMaxTextLength(role, un);
    if (maxLen <= 0) return res.status(403).json({ error: 'TTS is not available for your role.' });

    // Validate + normalize each line before touching the TTS server.
    const disabled = getTtsDisabledVoices();
    const ALLOWED_EMOTIONS = new Set(['', 'neutral', 'soft', 'excited', 'yell', 'angry', 'sad', 'happy']);
    const parsedLines = [];
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i] || {};
        const voiceId = typeof l.voiceId === 'string' ? l.voiceId : '';
        const text = typeof l.text === 'string' ? l.text.trim() : '';
        if (!voiceId) return res.status(400).json({ error: `Line ${i+1}: voiceId required` });
        if (!text) return res.status(400).json({ error: `Line ${i+1}: text empty` });
        if (text.length > maxLen) return res.status(400).json({ error: `Line ${i+1}: too long (${text.length}>${maxLen} chars)` });
        if (disabled.includes(voiceId)) return res.status(403).json({ error: `Line ${i+1}: voice ${voiceId} is disabled` });
        // First line has no pause by default; subsequent default to 400ms.
        const rawPause = Number(l.pauseMs);
        const pauseMs = Number.isFinite(rawPause)
            ? Math.max(0, Math.min(5000, Math.round(rawPause)))
            : (i === 0 ? 0 : 400);
        const wantsHumanize = !!l.humanize;
        const voiceName = typeof l.voiceName === 'string' ? l.voiceName.slice(0, 80) : '';
        const emotion = (typeof l.emotion === 'string' && ALLOWED_EMOTIONS.has(l.emotion)) ? l.emotion : '';
        parsedLines.push({ voiceId, text, pauseMs, wantsHumanize, voiceName, emotion });
    }

    // Cooldown — one conversation = one TTS play.
    const cooldownSec = getTtsCooldownSec(role, un);
    if (role === 'user') {
        const last = ttsLastPlayByUsername.get(un);
        if (last != null && cooldownSec > 0) {
            const elapsed = (Date.now() - last) / 1000;
            if (elapsed < cooldownSec) return res.status(429).json({ error: `Wait ${Math.ceil(cooldownSec - elapsed)} seconds before using TTS again.`, cooldownRemaining: Math.ceil(cooldownSec - elapsed) });
        }
    }

    // Voice channel + playback lock (mirrors /api/tts/speak).
    if (!activeGuildId || !getVoiceConnection(activeGuildId)) return res.status(400).json({ error: 'Join a voice channel first' });
    const meta = loadSoundsMeta();
    if (getPlaybackSuperadminOnly(meta) && role !== 'superadmin') return res.status(403).json({ error: 'Only superadmin can play.' });
    if (getPlaybackLocked(meta)) {
        const lockedBy = getPlaybackLockedBy(meta);
        if (lockedBy === 'superadmin') return res.status(403).json({ error: 'Playback is locked by superadmin.' });
        if (role === 'user') return res.status(403).json({ error: 'Playback is locked by an admin.' });
    }
    const conn = getVoiceConnection(activeGuildId);
    if (conn && conn.state && conn.state.status !== 'ready') {
        try { await entersState(conn, VoiceConnectionStatus.Ready, 15000); }
        catch { return res.status(503).json({ error: 'Voice connection failed to establish.' }); }
    }

    if (ttsQueue.length >= getTtsMaxQueueSize()) {
        return res.status(429).json({ error: `TTS queue is full (max ${getTtsMaxQueueSize()}). Wait for current clips to finish.` });
    }

    const rvcOverrides = getTtsVoiceRvcOverrides();
    const ttsCacheConv = require('./lib/tts-cache');
    const wavs = [];
    try {
        for (let i = 0; i < parsedLines.length; i++) {
            const line = parsedLines[i];
            let lineText = line.text;

            if (line.wantsHumanize) {
                try {
                    const humanize = require('./lib/tts-humanize-llm');
                    if (humanize.isAvailable()) {
                        // Derive engine hint from the voice id prefix so the
                        // humanize LLM knows which inline-tag vocabulary to use.
                        const engine = line.voiceId.startsWith('fish_') ? 'fish'
                                     : line.voiceId.startsWith('cb_') ? 'chatterbox'
                                     : line.voiceId.startsWith('gsv_') ? 'gptsovits'
                                     : line.voiceId.startsWith('rvc_') ? 'rvc'
                                     : '';
                        // Use client-supplied voice name (matches the main flow)
                        // or fall back to the id stem if the client didn't send one.
                        const nameHint = line.voiceName || line.voiceId.replace(/^(cb|fish|gsv|rvc)_/, '').replace(/_/g, ' ');
                        lineText = await humanize.humanize(line.text, nameHint, engine);
                    }
                } catch (e) {
                    console.warn('[TTS Conv] humanize line %d failed, using raw text: %s', i+1, e && e.message);
                }
            }

            const synthPayload = {
                text: lineText,
                voice_id: line.voiceId,
                use_rvc: rvcOverrides[line.voiceId] ?? true,
            };
            // Chatterbox expression preprocessor — Fish/GSV ignore this field.
            // Per-line forced emotion overrides the regex / LLM classifier.
            if (line.voiceId.startsWith('cb_')) {
                try {
                    const { segmentText } = require('./lib/tts-expression');
                    const segOpts = line.emotion ? { forcedEmotion: line.emotion } : {};
                    const segments = segmentText(lineText, segOpts);
                    if (segments && (segments.length > 1 || (segments.length === 1 && segments[0].emotion !== 'neutral'))) {
                        synthPayload.segments = segments;
                    }
                } catch {}
            }

            // Per-line cache check — edits to one line don't invalidate the
            // others, so a small tweak to line 3 of a 5-line exchange reuses
            // 4 cached WAVs.
            const lineKey = ttsCacheConv.keyFor(synthPayload);
            let lineWav = ttsCacheConv.get(lineKey);
            if (lineWav) {
                console.log('[TTS Conv] line %d/%d cache hit voice=%s', i+1, parsedLines.length, line.voiceId);
            } else {
                const ttsRes = await runTtsSynthSerially(() => ttsFetch('/synthesize', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(synthPayload), timeout: 200000, // > fish-speech ~180s cold start (was 120000, guaranteed 504 on cold engine load)
                }));
                if (!ttsRes || !ttsRes.ok) {
                    const detail = ttsRes ? (await ttsRes.text().catch(() => ttsRes.statusText)) : 'unreachable';
                    return res.status(502).json({ error: `Line ${i+1} synthesis failed: ${String(detail).slice(0, 200)}` });
                }
                const ab = await ttsRes.arrayBuffer();
                lineWav = Buffer.from(ab);
                try { ttsCacheConv.put(lineKey, lineWav); } catch {}
                console.log('[TTS Conv] line %d/%d synth ok voice=%s chars=%d pauseBefore=%dms', i+1, parsedLines.length, line.voiceId, lineText.length, line.pauseMs);
            }
            wavs.push({ buffer: lineWav, pauseMs: line.pauseMs });
        }
    } catch (e) {
        console.error('[TTS Conv] synth loop error:', e);
        return res.status(502).json({ error: 'TTS conversation failed: ' + (e && e.message || 'unknown') });
    }

    let stitched;
    try {
        stitched = await stitchConversationWavs(wavs);
    } catch (e) {
        console.error('[TTS Conv] stitch error:', e);
        return res.status(502).json({ error: 'Stitching failed: ' + (e && e.message || 'unknown') });
    }

    const uniqueVoices = [...new Set(parsedLines.map(l => l.voiceId))];
    const previewText = parsedLines.map(l => l.text).join(' | ');
    const ttsDisplayName = `TTS Conv: ${parsedLines.length} lines, ${uniqueVoices.length} voice${uniqueVoices.length === 1 ? '' : 's'}`;
    const localWavId = ttsWavCacheStash(stitched, req.session.user.username);

    // Persist as a single recent with a multi-line transcript body.
    let recentId = null;
    try {
        const username = req.session.user.username;
        const ts = Date.now();
        const fname = `${username.replace(/[^a-zA-Z0-9_-]/g, '_')}_${ts}_conv.wav`;
        const wavPath = path.join(TTS_RECENTS_DIR, fname);
        fs.writeFileSync(wavPath, stitched);
        const transcript = parsedLines.map(l => `[${l.voiceName || l.voiceId}]: ${l.text}`).join('\n');
        recentId = statsDb.insertTtsRecent({
            owner: username,
            text: transcript,
            voiceId: 'conversation',
            voiceLabel: null,
            displayName: ttsDisplayName,
            wavPath: fname,
        });
        const toEvict = statsDb.listTtsRecentsBeyond(username, TTS_RECENTS_PER_USER);
        for (const old of toEvict) {
            try {
                const p = path.join(TTS_RECENTS_DIR, path.basename(old.wav_path));
                if (p.startsWith(TTS_RECENTS_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
            } catch (e) { console.warn('[TTS Conv recents] evict unlink failed:', e.message); }
            statsDb.deleteTtsRecent(old.id);
        }
    } catch (e) {
        console.warn('[TTS Conv recents] persist failed:', e.message);
    }

    const startedBy = { username: req.session.user.username, role };
    const queueItem = {
        id: ++ttsQueueIdCounter,
        wavBuffer: stitched,
        text: previewText,
        voiceId: 'conversation',
        ttsVolume: volume,
        displayName: ttsDisplayName,
        startedBy,
        username: req.session.user.username,
        recentId,
    };
    ttsQueue.push(queueItem);
    const queuePosition = ttsQueue.length;
    console.log('[TTS Conv] enqueued #%d, pos=%d, lines=%d, voices=%d', queueItem.id, queuePosition, parsedLines.length, uniqueVoices.length);

    if (role === 'user') ttsLastPlayByUsername.set(req.session.user.username, Date.now());

    processTtsQueue();
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: role,
        action: 'tts.conversation',
        target: null,
        details: {
            lines: parsedLines.length,
            voices: uniqueVoices,
            totalChars: parsedLines.reduce((a, l) => a + l.text.length, 0),
            humanizedLines: parsedLines.filter(l => l.wantsHumanize).length,
        },
    });
    res.json({ ok: true, queued: true, queuePosition, displayName: ttsDisplayName, startedBy, multiPlay: multiPlayEnabled, localWavId });
});

app.post('/api/tts/test-synth', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    if (role === 'guest') return res.status(403).json({ error: 'Guests cannot synthesize tests.' });
    const { text, voiceId } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Text required' });
    if (!voiceId || typeof voiceId !== 'string') return res.status(400).json({ error: 'voiceId required' });
    if (text.length > 300) return res.status(400).json({ error: 'Test text capped at 300 chars' });
    if (!TTS_API_URL) return res.status(503).json({ error: 'TTS service not configured' });
    try {
        const r = await ttsFetch('/synthesize', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text.trim(), voice_id: voiceId, use_rvc: false }),
            timeout: 90000,
        });
        if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            return res.status(r.status).json(d);
        }
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Cache-Control', 'no-store');
        res.send(buf);
    } catch (e) {
        res.status(503).json({ error: 'TTS service unreachable: ' + e.message });
    }
});

// Delete a per-engine voice (gptsovits / fish). Just rm -rf the voice dir
// on the TTS server. Chatterbox + RVC have their own deletion flows.
app.delete('/api/superadmin/tts/voice-engine/:engine/:id', requireSuperadmin, async (req, res) => {
    const engine = req.params.engine;
    if (!['gptsovits', 'fish'].includes(engine)) return res.status(400).json({ error: 'Unsupported engine for this delete route' });
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    try {
        const r = await ttsFetch(`/admin/voices/${engine}/${encodeURIComponent(dirId)}`, {
            method: 'DELETE',
            headers: { 'X-Admin-Token': TTS_ADMIN_TOKEN || '' },
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
            // Repackage upstream errors so a 401 from the TTS server doesn't
            // get re-emitted as a 401 to the browser (the soundboard UI
            // interprets any 401 as "session expired" → kicks to login).
            const upstreamStatus = r.status === 401 ? 502 : r.status;
            return res.status(upstreamStatus).json({ error: body.detail || body.error || `TTS server returned ${r.status}` });
        }
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'voice.delete-' + engine,
            target: dirId,
            details: body,
        });
        res.json(body);
    } catch (err) { ttsAdminError(res, err); }
});

// One-click: create a Fish v2 voice by cloning an existing Chatterbox
// reference. Whisper-transcribes for ref_text. Fish accepts the full
// 5-30s clip as-is so no trim needed.
// Stream the current reference.wav for an engine voice. Admin-only.
// Older voices have no source_* metadata — this is the escape hatch that lets
// the operator hear what's deployed and optionally re-upload via the UI.
app.get('/api/superadmin/tts/voice-engine/:engine/:id/reference', requireSuperadmin, async (req, res) => {
    const engine = req.params.engine;
    if (!['chatterbox', 'gptsovits', 'fish'].includes(engine)) return res.status(400).json({ error: 'Unsupported engine' });
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    try {
        const url = `${TTS_API_URL}/admin/voices/${engine}/${encodeURIComponent(dirId)}/reference`;
        const r = await fetch(url, { headers: { 'X-Admin-Token': TTS_ADMIN_TOKEN || '' } });
        if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            return res.status(r.status === 401 ? 502 : r.status).json({ error: body.detail || body.error || `TTS ${r.status}` });
        }
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Disposition', `attachment; filename="${engine}_${dirId}_reference.wav"`);
        res.setHeader('Cache-Control', 'no-store');
        const buf = Buffer.from(await r.arrayBuffer());
        res.send(buf);
    } catch (err) { ttsAdminError(res, err); }
});

// Full list of every rvc_<id> on disk — /voices hides RVC models that
// have a Chatterbox pair, but the UI still needs the unfiltered list to
// offer them as Fish refinement targets.
app.get('/api/superadmin/tts/rvc-models', requireSuperadmin, async (req, res) => {
    try {
        const r = await ttsFetch('/admin/rvc-models', { timeout: 5000 });
        const body = await r.json().catch(() => ({}));
        res.status(r.status).json(body);
    } catch (err) { ttsAdminError(res, err); }
});

app.get('/api/superadmin/tts/engines/health', requireSuperadmin, async (req, res) => {
    try {
        const r = await ttsFetch('/health/engines', { timeout: 5000 });
        const body = await r.json().catch(() => ({}));
        res.status(r.status).json(body);
    } catch (err) { ttsAdminError(res, err); }
});

app.post('/api/superadmin/tts/voice/:id/clone-to-fish', requireSuperadmin, async (req, res) => {
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    try {
        const r = await ttsFetch(`/admin/voices/fish/clone-from-chatterbox/${encodeURIComponent(dirId)}`, {
            method: 'POST', timeout: 180000,
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status).json(body);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'voice.clone-to-fish',
            target: dirId,
            details: { ref_text_preview: String(body.ref_text || '').slice(0, 80) },
        });
        res.json(body);
    } catch (err) { ttsAdminError(res, err); }
});

// One-click: create a GPT-SoVITS voice by cloning an existing Chatterbox
// voice's reference clip. TTS server trims + whisper-transcribes.
app.post('/api/superadmin/tts/voice/:id/clone-to-gsv', requireSuperadmin, async (req, res) => {
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    const trimStart = Number(req.body?.trim_start_sec) || 0;
    const trimLength = Number(req.body?.trim_length_sec) || 8;
    try {
        const r = await ttsFetch(`/admin/voices/gsv/clone-from-chatterbox/${encodeURIComponent(dirId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trim_start_sec: trimStart, trim_length_sec: trimLength }),
            timeout: 180000,
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status).json(body);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'voice.clone-to-gsv',
            target: dirId,
            details: { ref_text_preview: String(body.ref_text || '').slice(0, 80), ref_len_sec: body.ref_len_sec },
        });
        res.json(body);
    } catch (err) {
        ttsAdminError(res, err);
    }
});

app.delete('/api/superadmin/tts/voice/:id', requireSuperadmin, async (req, res) => {
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    try {
        await ttsVoiceAdmin.deleteFromTtsServer({ ttsApiUrl: TTS_API_URL, adminToken: TTS_ADMIN_TOKEN, voiceId: dirId });
        res.json({ ok: true });
    } catch (err) {
        ttsAdminError(res, err);
    }
});

app.patch('/api/superadmin/tts/voice/:id/metadata', requireSuperadmin, async (req, res) => {
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    if (!TTS_API_URL) return res.status(503).json({ error: 'TTS_API_URL not configured' });
    if (!TTS_ADMIN_TOKEN) return res.status(503).json({ error: 'TTS_ADMIN_TOKEN not configured' });
    const body = req.body || {};
    const patch = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (['male', 'female', 'unknown'].includes(body.gender)) patch.gender = body.gender;
    if (typeof body.group === 'string') patch.group = body.group;
    if (typeof body.skip_rvc === 'boolean') patch.skip_rvc = body.skip_rvc;
    if (typeof body.default_exaggeration === 'number') {
        const v = Math.max(0.25, Math.min(2.0, body.default_exaggeration));
        patch.default_exaggeration = Math.round(v * 100) / 100;
    }
    try {
        const url = TTS_API_URL.replace(/\/+$/, '') + '/voices/chatterbox/' + encodeURIComponent(dirId) + '/metadata';
        const r = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TTS_ADMIN_TOKEN },
            body: JSON.stringify(patch),
        });
        const text = await r.text();
        if (!r.ok) {
            let detail = text;
            try { detail = JSON.parse(text).detail || text; } catch {}
            return res.status(r.status).json({ error: 'TTS server rejected patch: ' + detail });
        }
        res.json(JSON.parse(text));
    } catch (e) {
        res.status(502).json({ error: 'TTS server unreachable: ' + e.message });
    }
});

// --- Superadmin: RVC-only voice metadata (manifest entries) ---

app.patch('/api/superadmin/tts/rvc-voice/:id', requireSuperadmin, async (req, res) => {
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    if (!TTS_API_URL) return res.status(503).json({ error: 'TTS_API_URL not configured' });
    if (!TTS_ADMIN_TOKEN) return res.status(503).json({ error: 'TTS_ADMIN_TOKEN not configured' });
    const body = req.body || {};
    const patch = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (['male', 'female', 'unknown'].includes(body.gender)) patch.gender = body.gender;
    if (typeof body.group === 'string') patch.group = body.group;
    if (Number.isFinite(body.transpose)) patch.transpose = Math.max(-24, Math.min(24, Math.round(body.transpose)));
    if (Number.isFinite(body.index_rate)) patch.index_rate = Math.max(0, Math.min(1, Number(body.index_rate)));
    if (Number.isFinite(body.protect)) patch.protect = Math.max(0, Math.min(0.5, Number(body.protect)));
    if (typeof body.base_voice === 'string') patch.base_voice = body.base_voice;
    try {
        const url = TTS_API_URL.replace(/\/+$/, '') + '/voices/rvc/' + encodeURIComponent(dirId);
        const r = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TTS_ADMIN_TOKEN },
            body: JSON.stringify(patch),
        });
        const text = await r.text();
        if (!r.ok) {
            let detail = text;
            try { detail = JSON.parse(text).detail || text; } catch {}
            return res.status(r.status).json({ error: 'TTS server rejected patch: ' + detail });
        }
        res.json(JSON.parse(text));
    } catch (e) {
        res.status(502).json({ error: 'TTS server unreachable: ' + e.message });
    }
});

app.delete('/api/superadmin/tts/rvc-voice/:id', requireSuperadmin, async (req, res) => {
    const dirId = ttsVoiceAdmin.normalizeVoiceId(req.params.id);
    if (!dirId) return res.status(400).json({ error: 'Invalid voice id' });
    if (!TTS_API_URL) return res.status(503).json({ error: 'TTS_API_URL not configured' });
    if (!TTS_ADMIN_TOKEN) return res.status(503).json({ error: 'TTS_ADMIN_TOKEN not configured' });
    try {
        const url = TTS_API_URL.replace(/\/+$/, '') + '/voices/rvc/' + encodeURIComponent(dirId);
        const r = await fetch(url, { method: 'DELETE', headers: { 'X-Admin-Token': TTS_ADMIN_TOKEN } });
        const text = await r.text();
        if (!r.ok) {
            let detail = text;
            try { detail = JSON.parse(text).detail || text; } catch {}
            return res.status(r.status).json({ error: 'TTS server rejected delete: ' + detail });
        }
        res.json(JSON.parse(text));
    } catch (e) {
        res.status(502).json({ error: 'TTS server unreachable: ' + e.message });
    }
});

// --- Suno song generation ---

function requireSunoAllowed(req, res, next) {
    if (!getSunoEnabled()) return res.status(403).json({ error: 'Song generation is disabled.' });
    const role = req.session.user.role;
    const username = req.session.user.username;
    const limit = getSunoDailyLimit(role, username);
    if (limit <= 0) return res.status(403).json({ error: 'Your role cannot generate songs.' });
    const used = getSunoUsageToday(username);
    if (used >= limit) return res.status(429).json({ error: `Daily Suno limit reached (${used}/${limit}). Try again tomorrow.`, used, limit });
    req._sunoLimit = { used, limit };
    next();
}

app.get('/api/suno/config', requireAuth, (req, res) => {
    const role = req.session.user.role;
    const username = req.session.user.username;
    res.json({
        enabled: getSunoEnabled() && !!(process.env.SUNO_API_KEY || '').trim(),
        limit: getSunoDailyLimit(role, username),
        used_today: getSunoUsageToday(username),
    });
});

// Suno task IDs are opaque tokens we mint via the Suno API; validate them
// strictly before they reach any path.join() in lib/suno-gen.js, so a crafted
// `..` segment can't escape STAGING_DIR.
const SUNO_TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function requireValidSunoTaskId(req, res, next) {
    if (!SUNO_TASK_ID_RE.test(String(req.params.taskId || ''))) {
        return res.status(400).json({ error: 'Invalid taskId' });
    }
    next();
}

app.get('/api/suno/credits', requireAuth, async (req, res) => {
    try {
        const credits = await sunoGen.getCredits();
        res.json({ credits });
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.post('/api/suno/generate', requireAuth, requireSunoAllowed, async (req, res) => {
    const { title, lyrics, style, model, instrumental, customMode } = req.body || {};
    try {
        const taskId = await sunoGen.generateSong({
            title: typeof title === 'string' ? title : null,
            lyrics: typeof lyrics === 'string' ? lyrics : null,
            style: typeof style === 'string' ? style : null,
            model: typeof model === 'string' ? model : 'V5_5',
            instrumental: !!instrumental,
            customMode: customMode !== false,
        });
        const used = incrementSunoUsage(req.session.user.username);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'suno.generate',
            target: taskId,
            details: { style, model, instrumental: !!instrumental, used_today: used, limit: req._sunoLimit.limit },
        });
        res.json({ ok: true, taskId, used_today: used, limit: req._sunoLimit.limit });
    } catch (e) {
        res.status(e.status || 502).json({ error: e.message });
    }
});

app.get('/api/suno/status/:taskId', requireAuth, requireValidSunoTaskId, async (req, res) => {
    const taskId = req.params.taskId;
    try {
        // Short-circuit: if we've already downloaded the final audio, return cached meta.
        const cached = sunoGen.getStagingMeta(taskId);
        if (cached && cached.tracks && cached.tracks.some(t => t.audio_bytes)) {
            return res.json({ status: cached.status || 'SUCCESS', tracks: cached.tracks });
        }
        const payload = await sunoGen.getSongStatus(taskId);
        const status = String((payload && (payload.status || (payload.response && payload.response.status))) || 'PENDING').toUpperCase();
        // Ingest opportunistically — downloads final MP3 + cover only when audio_url appears (status=SUCCESS).
        // Runs on every poll so as soon as the final URL drops in, we have a local copy.
        let tracks;
        if (['SUCCESS', 'COMPLETE', 'FIRST_SUCCESS', 'TEXT_SUCCESS'].includes(status)) {
            tracks = await sunoGen.ingestCompletedTask(taskId, payload);
        } else {
            tracks = sunoGen.extractTracks(payload).map((t, i) => ({ slot: i, ...t }));
        }
        res.json({ status, tracks });
    } catch (e) {
        res.status(e.status || 502).json({ error: e.message });
    }
});

app.get('/api/suno/preview/:taskId/:slot', requireAuth, requireValidSunoTaskId, (req, res) => {
    const p = sunoGen.getSlotAudioPath(req.params.taskId, parseInt(req.params.slot, 10));
    if (!p) return res.status(404).json({ error: 'Audio not ready' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(p).pipe(res);
});

app.get('/api/suno/cover/:taskId/:slot', requireAuth, requireValidSunoTaskId, (req, res) => {
    const p = sunoGen.getSlotCoverPath(req.params.taskId, parseInt(req.params.slot, 10));
    if (!p) return res.status(404).json({ error: 'Cover not ready' });
    res.setHeader('Content-Type', 'image/jpeg');
    fs.createReadStream(p).pipe(res);
});

app.post('/api/suno/save/:taskId', requireAuth, requireValidSunoTaskId, (req, res) => {
    const taskId = req.params.taskId;
    const slot = parseInt((req.body && req.body.slot) || 0, 10);
    const meta = sunoGen.getStagingMeta(taskId);
    if (!meta) return res.status(404).json({ error: 'Staging not found — try again after generation completes.' });
    const track = meta.tracks && meta.tracks[slot];
    const audioPath = sunoGen.getSlotAudioPath(taskId, slot);
    if (!track || !audioPath) return res.status(404).json({ error: 'Slot audio missing' });

    const userDisplay = (req.body && typeof req.body.displayName === 'string') ? req.body.displayName.trim() : '';
    const displayName = userDisplay.slice(0, 100) || track.title || 'Generated song';
    const tagsInput = req.body && Array.isArray(req.body.tags) ? req.body.tags.filter(t => typeof t === 'string') : [];
    const tags = Array.from(new Set(['AI-song', ...tagsInput])).slice(0, 10);
    const stylePrompt = (req.body && typeof req.body.style === 'string') ? req.body.style : (track.tags || null);
    const lyricsText = (req.body && typeof req.body.lyrics === 'string') ? req.body.lyrics : (track.lyrics || null);
    const modelUsed = (req.body && typeof req.body.model === 'string') ? req.body.model : 'V5_5';

    const sanitized = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'song';
    const stamp = Date.now();
    const filename = `${sanitized}-${stamp}.mp3`;
    const dstAudio = path.join(SOUNDS_DIR, filename);
    fs.copyFileSync(audioPath, dstAudio);

    let coverRel = null;
    const coverPath = sunoGen.getSlotCoverPath(taskId, slot);
    if (coverPath) {
        const coversDir = path.join(SOUNDS_DIR, 'covers');
        if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });
        const coverFile = `${sanitized}-${stamp}.jpg`;
        fs.copyFileSync(coverPath, path.join(coversDir, coverFile));
        coverRel = 'covers/' + coverFile;
    }

    const sounds = loadSoundsMeta();
    sounds[filename] = {
        displayName,
        tags,
        duration: track.duration || null,
        suno: {
            taskId,
            slot,
            model: modelUsed,
            title: track.title || null,
            style: stylePrompt,
            lyrics: lyricsText,
            cover: coverRel,
            video_url: track.video_url || null,
            suno_audio_id: track.id || null,
            generated_at: stamp,
            saved_by: req.session.user.username,
        },
    };
    saveSoundsMeta(sounds);

    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'suno.save',
        target: filename,
        details: { taskId, slot, displayName, model: modelUsed },
    });
    res.json({ ok: true, filename, cover: coverRel, entry: sounds[filename] });
});

app.delete('/api/suno/discard/:taskId', requireAuth, requireValidSunoTaskId, (req, res) => {
    const taskId = req.params.taskId;
    const wantRefund = req.query.refund === '1';
    // Only refund a GENUINE early-cancel: the staging must still exist and have
    // produced no audio yet. This stops generate→save→discard?refund=1 from
    // zeroing out usage (and burning credits) after the user already got the
    // song. A repeat discard finds no staging (deleted below) → no double refund.
    let refunded = false;
    if (wantRefund) {
        const meta = sunoGen.getStagingMeta(taskId);
        if (meta) {
            const hasAudio = [0, 1].some(s => { try { return !!sunoGen.getSlotAudioPath(taskId, s); } catch { return false; } });
            if (!hasAudio) { decrementSunoUsage(req.session.user.username); refunded = true; }
        }
    }
    try { sunoGen.deleteStaging(taskId); } catch {}
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'suno.discard',
        target: taskId,
        details: { refunded },
    });
    res.json({ ok: true, refunded });
});

// Play a Suno staging track straight to Discord without requiring Save first.
// Prefers the fully-downloaded local MP3, falls back to the Suno stream URL
// (ffmpeg pulls HTTP directly, so we don't have to wait for the full download).
// Limited to users with Suno access (same gate as /generate).
app.post('/api/suno/play/:taskId/:slot', requireAuth, requireValidSunoTaskId, requireSunoAllowed, async (req, res) => {
    const slot = parseInt(req.params.slot, 10);
    const taskId = req.params.taskId;
    let ffInput = sunoGen.getSlotAudioPath(taskId, slot);
    let sourceKind = 'local';
    if (!ffInput) {
        // Not downloaded yet — look up the live stream URL from staging meta
        const meta = sunoGen.getStagingMeta(taskId);
        const track = meta && meta.tracks && meta.tracks[slot];
        if (track && track.stream_url) { ffInput = track.stream_url; sourceKind = 'stream'; }
    }
    if (!ffInput) return res.status(404).json({ error: 'Neither local MP3 nor stream URL available yet' });
    if (!activeGuildId || !getVoiceConnection(activeGuildId)) return res.status(400).json({ error: 'Join a voice channel first' });

    const conn = getVoiceConnection(activeGuildId);
    if (conn && conn.state.status !== 'ready') {
        try { await entersState(conn, VoiceConnectionStatus.Ready, 15000); }
        catch { return res.status(503).json({ error: 'Voice connection failed to establish.' }); }
    }

    const meta = sunoGen.getStagingMeta(taskId);
    const track = meta && meta.tracks && meta.tracks[slot];
    const displayName = (track && track.title) ? ('🎵 ' + track.title + (sourceKind === 'stream' ? ' (streaming)' : '')) : 'Suno preview';
    const startedBy = { username: req.session.user.username, role: req.session.user.role };

    try {
        const ffArgs = ['-nostdin'];
        // -reconnect only applies to HTTP inputs; harmless on local files.
        if (sourceKind === 'stream') ffArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        ffArgs.push('-i', ffInput);

        if (sourceKind === 'stream') {
            // Tee the incoming stream to BOTH Discord (stdout) AND a local
            // staging MP3 so the user can Save this variant even if Suno
            // never publishes the final audio_url. ffmpeg's tee muxer needs
            // re-encode (libmp3lame) because -c:a copy with tee requires
            // the source to already be MP3 bitstream-clean, which Suno's
            // partial stream isn't.
            const stagingFile = require('path').join(require('./lib/suno-gen').STAGING_DIR, taskId, `slot${slot}_audio.mp3`);
            const teeTarget = `[f=mp3:onfail=ignore]${stagingFile}|[f=mp3]pipe:1`;
            ffArgs.push('-map', '0:a', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'tee', teeTarget);
        } else {
            ffArgs.push('-f', 'mp3', 'pipe:1');
        }

        const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        ff.stderr.on('data', () => {});
        ff.on('error', (err) => console.error('[Suno play] ffmpeg error', err));
        ff.on('close', (code) => {
            console.log('[Suno play] ffmpeg exit code=%s sourceKind=%s taskId=%s slot=%s', code, sourceKind, taskId, slot);
            // If we were teeing a stream and ffmpeg finished cleanly, update
            // staging meta so the frontend notices the new local file on
            // its next poll and flips save/play-in-discord to localReady.
            if (sourceKind === 'stream') {
                try {
                    const meta = sunoGen.getStagingMeta(taskId);
                    if (meta && meta.tracks && meta.tracks[slot]) {
                        const p = sunoGen.getSlotAudioPath(taskId, slot);
                        if (p) {
                            meta.tracks[slot].audio_bytes = require('fs').statSync(p).size;
                            require('fs').writeFileSync(require('path').join(require('./lib/suno-gen').STAGING_DIR, taskId, 'meta.json'), JSON.stringify(meta, null, 2));
                        }
                    }
                } catch (e) { console.error('[Suno play] post-tee meta update failed:', e.message); }
            }
        });
        const resource = createAudioResource(ff.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true, metadata: { filename: 'suno_preview', displayName } });
        resource.volume.setVolume(Math.max(0, Math.min(2, currentVolume)));
        player.play(resource);
        playbackState = {
            status: 'playing', filename: 'suno_preview', displayName,
            startTime: Date.now(), startTimeOffset: 0,
            duration: (track && track.duration) || null,
            startedBy, tts: false,
        };
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'suno.play',
            target: taskId,
            details: { slot, sourceKind, displayName },
        });
        res.json({ ok: true, displayName, sourceKind });
    } catch (err) {
        console.error('[Suno play] error:', err);
        res.status(500).json({ error: 'Failed to start Discord playback' });
    }
});

// List all unsaved staging generations so the frontend can surface a
// "Recent generations" section. Entries stick around for STAGING_TTL_MS
// (12h) unless explicitly discarded.
app.get('/api/suno/recent', requireAuth, (req, res) => {
    try { res.json({ items: sunoGen.listRecent() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// /clip API — list / preview / save-as-sound / discard the rolling clips
// captured via the /clip slash command.
// ---------------------------------------------------------------------------
const CLIP_ID_RE = /^clip_[a-f0-9]{12}$/i;
function requireValidClipId(req, res, next) {
    if (!CLIP_ID_RE.test(String(req.params.id || ''))) {
        return res.status(400).json({ error: 'Invalid clip id' });
    }
    next();
}

// Enforce the per-role / per-user clip permission. Gates list, capture, and
// save-as-sound — anyone in the guild can still discard their own clips via
// /api/clips/:id (deleting your own bad capture shouldn't need permission).
function requireClipPermission(req, res, next) {
    const role = req.session?.user?.role;
    const username = req.session?.user?.username;
    if (!role || !getClipEnabled(role, username)) {
        return res.status(403).json({ error: 'Clipping is disabled for your account. Ask a superadmin.' });
    }
    next();
}

app.get('/api/clips', requireAuth, requireClipPermission, (req, res) => {
    res.json(loadClipsIndex());
});

// Web-UI equivalent of `/clip` — captures the last N seconds of voice-channel
// audio into the rolling-clip index. Returns the new clip's metadata so the
// frontend can scroll the Clips modal to it.
app.post('/api/clip/capture', requireAuth, requireClipPermission, async (req, res) => {
    const requested = Number((req.body || {}).seconds);
    if (!Number.isFinite(requested)) {
        return res.status(400).json({ error: 'seconds (number) required' });
    }
    const result = await captureClip(requested, {
        userId: req.session.user?.username,
        userTag: req.session.user?.username,
        source: 'web',
    });
    if (!result.ok) {
        const status = result.code === 'no-channel' || result.code === 'no-audio' ? 400 : 500;
        return res.status(status).json({ error: result.error, code: result.code });
    }
    res.json({ ok: true, clip: result.meta });
});

app.get('/api/clips/:id/audio', requireAuth, requireValidClipId, (req, res) => {
    const id = req.params.id;
    const clip = loadClipsIndex().find(c => c.id === id);
    if (!clip) return res.status(404).json({ error: 'Not found' });
    const filePath = path.join(CLIPS_DIR, clip.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=60');
    fs.createReadStream(filePath).pipe(res);
});

app.delete('/api/clips/:id', requireAuth, requireValidClipId, (req, res) => {
    const id = req.params.id;
    const arr = loadClipsIndex();
    const idx = arr.findIndex(c => c.id === id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    const clip = arr[idx];
    arr.splice(idx, 1);
    saveClipsIndex(arr);
    try { fs.unlinkSync(path.join(CLIPS_DIR, clip.filename)); } catch {}
    res.json({ ok: true });
});

// Trims a stored clip and registers it as a regular sound. Body:
//   { displayName, startSec?, endSec?, volume?, trimToEnd? }
// Uses ffmpeg to copy/re-encode the source MP3 into the soundboard sounds
// directory with the requested trim window; falls back to the full clip
// duration if start/end are omitted.
app.post('/api/clips/:id/save-as-sound', requireAuth, requireClipPermission, requireValidClipId, async (req, res) => {
    const id = req.params.id;
    const arr = loadClipsIndex();
    const clip = arr.find(c => c.id === id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    const srcPath = path.join(CLIPS_DIR, clip.filename);
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'Clip file missing on disk' });
    const body = req.body || {};
    const displayName = String(body.displayName || '').trim();
    if (!displayName) return res.status(400).json({ error: 'displayName required' });
    if (displayName.length > 100) return res.status(400).json({ error: 'displayName must be <= 100 characters' });
    let startSec = Number.isFinite(body.startSec) ? Math.max(0, Number(body.startSec)) : 0;
    let endSec = Number.isFinite(body.endSec) ? Number(body.endSec) : clip.durationSec;
    endSec = Math.min(endSec, clip.durationSec);
    if (endSec <= startSec) return res.status(400).json({ error: 'endSec must be greater than startSec' });
    if (endSec - startSec < 0.25) return res.status(400).json({ error: 'Trimmed clip must be at least 0.25s' });

    // Pick a non-conflicting filename in sounds/
    const safe = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'clip';
    let outName = safe + '.mp3';
    let counter = 1;
    while (fs.existsSync(path.join(SOUNDS_DIR, outName))) {
        outName = safe + '_' + counter + '.mp3';
        counter++;
        if (counter > 999) return res.status(500).json({ error: 'Could not pick a unique filename' });
    }
    const outPath = path.join(SOUNDS_DIR, outName);

    try {
        await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', [
                '-nostdin', '-y',
                '-ss', String(startSec), '-to', String(endSec),
                '-i', srcPath,
                '-c:a', 'libmp3lame', '-b:a', '192k',
                outPath,
            ], { stdio: ['ignore', 'ignore', 'pipe'] });
            ff.on('error', reject);
            ff.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)));
        });
    } catch (err) {
        try { fs.unlinkSync(outPath); } catch {}
        return res.status(500).json({ error: 'Failed to trim clip: ' + err.message });
    }

    // Probe the new duration so the soundboard UI shows the right length.
    let duration = endSec - startSec;
    try { duration = probeDurationAsync ? await probeDurationAsync(outPath) : duration; } catch {}

    setSoundMeta(outName, { displayName, duration });

    clip.savedToSoundboard = outName;
    saveClipsIndex(arr);

    console.log(`[clip] saved-as-sound ${id} -> ${outName} (${displayName}) trim=${startSec}-${endSec}`);
    res.json({ ok: true, filename: outName, displayName, duration });
});

// Watch Together page — same static SPA for every room id. The page reads
// the id from window.location and uses /api/watch/rooms/:id + the WS upgrade
// to drive the player.
app.get('/watch/:id', (req, res) => {
    if (!WATCH_ID_RE.test(String(req.params.id || ''))) return res.status(400).type('text/plain').send('Invalid room id');
    res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

// ---------------------------------------------------------------------------
// Watch Together — room CRUD + control
// ---------------------------------------------------------------------------
function requireWatchPartyPermission(req, res, next) {
    const role = req.session?.user?.role;
    const username = req.session?.user?.username;
    if (!role || !getWatchPartyEnabled(role, username)) {
        return res.status(403).json({ error: 'Watch Together is disabled for your account. Ask a superadmin.' });
    }
    next();
}

app.post('/api/watch/rooms', requireAuth, requireWatchPartyPermission, async (req, res) => {
    const url = String((req.body || {}).url || '').trim();
    const strategy = req.body?.strategy && WATCH_STRATEGIES.includes(req.body.strategy) ? req.body.strategy : undefined;
    const resolved = await resolveWatchSource(url, strategy);
    if (resolved.sourceType === 'invalid' || resolved.sourceType === 'drm-blocked') {
        return res.status(400).json({ error: resolved.error });
    }
    const id = makeWatchRoomId();
    const now = Date.now();
    const room = {
        id, url,
        sourceType: resolved.sourceType,
        sourceMeta: resolved.sourceMeta || {},
        hostUsername: req.session.user.username,
        hostRole: req.session.user.role,
        createdAt: now, lastActivity: now,
        state: { playing: false, position: 0, positionAt: now },
        viewers: new Set(),
    };
    watchRooms.set(id, room);
    console.log(`[watch] room ${id} created by ${room.hostUsername} (${room.sourceType}, via=${room.sourceMeta.via || 'detect'}) -> ${url}`);
    res.json(_watchRoomPublic(room));
});

const WATCH_ID_RE = /^w_[a-f0-9]{8}$/i;
function requireValidWatchRoomId(req, res, next) {
    if (!WATCH_ID_RE.test(String(req.params.id || ''))) return res.status(400).json({ error: 'Invalid room id' });
    next();
}

app.get('/api/watch/rooms/:id', requireAuth, requireValidWatchRoomId, (req, res) => {
    const room = watchRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found or expired' });
    res.json(_watchRoomPublic(room));
});

// Lightweight "host is at this timestamp" beacon for iframe sources that
// can't be programmatically driven (weflix → vidsrcme → cloudnestra etc).
// The host's iframe can't be controlled, but if the host MANUALLY plays
// at a known time and beams that time to viewers, viewers can scrub their
// own embedded player to match. Same auth+ownership rules as /control.
app.post('/api/watch/rooms/:id/host-position', requireAuth, requireValidWatchRoomId, (req, res) => {
    const room = watchRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const un = req.session.user.username;
    if (un !== room.hostUsername && req.session.user.role !== 'superadmin') return res.status(403).json({ error: 'Host only' });
    const pos = Number(req.body?.position);
    if (!Number.isFinite(pos) || pos < 0) return res.status(400).json({ error: 'position number required' });
    room.state.position = pos;
    room.state.positionAt = Date.now();
    room.lastActivity = Date.now();
    _watchBroadcast(room, { type: 'host-pos', position: pos, at: room.state.positionAt });
    res.json({ ok: true });
});

app.post('/api/watch/rooms/:id/control', requireAuth, requireValidWatchRoomId, (req, res) => {
    const room = watchRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found or expired' });
    // Only the host can drive playback. Superadmin can also override.
    const un = req.session.user.username;
    const role = req.session.user.role;
    if (un !== room.hostUsername && role !== 'superadmin') return res.status(403).json({ error: 'Only the host can control playback.' });
    const body = req.body || {};
    const action = String(body.action || '');
    const position = Number.isFinite(body.position) ? Math.max(0, Number(body.position)) : null;
    const now = Date.now();
    if (action === 'play') {
        room.state.playing = true;
        if (position != null) room.state.position = position;
        room.state.positionAt = now;
    } else if (action === 'pause') {
        room.state.position = _watchCurrentPosition(room);
        room.state.positionAt = now;
        room.state.playing = false;
    } else if (action === 'seek' && position != null) {
        room.state.position = position;
        room.state.positionAt = now;
    } else {
        return res.status(400).json({ error: 'action must be play / pause / seek (with position)' });
    }
    room.lastActivity = now;
    _watchBroadcast(room, { type: 'state', state: { playing: room.state.playing, position: room.state.position, positionAt: room.state.positionAt } });
    res.json(_watchRoomPublic(room));
});

// ---------------------------------------------------------------------------
// Movie Night routes
// ---------------------------------------------------------------------------
const MN_ID_RE = /^mn_[a-f0-9]{8}$/i;
function requireValidMnRoomId(req, res, next) {
    if (!MN_ID_RE.test(String(req.params.id || ''))) return res.status(400).json({ error: 'Invalid room id' });
    next();
}
function requireMovieNightPermission(req, res, next) {
    const role = req.session?.user?.role;
    const username = req.session?.user?.username;
    if (!role || !getMovieNightEnabled(role, username)) return res.status(403).json({ error: 'Movie Night is disabled for your account.' });
    next();
}

app.post('/api/movienight/rooms', requireAuth, requireMovieNightPermission, (req, res) => {
    const id = makeMovieNightRoomId();
    const now = Date.now();
    movieNightRooms.set(id, {
        id, hostUsername: req.session.user.username, hostRole: req.session.user.role,
        createdAt: now, lastActivity: now,
        candidates: [],
        phase: 'gathering', // gathering -> voting -> decided
        vote: null,
        winnerIdx: null,
        winnerWatchRoomId: null,
        viewers: new Set(),
    });
    console.log(`[movienight] room ${id} created by ${req.session.user.username}`);
    res.json(_mnRoomPublic(movieNightRooms.get(id)));
});

app.get('/api/movienight/rooms/:id', requireAuth, requireValidMnRoomId, (req, res) => {
    const room = movieNightRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found or expired' });
    res.json(_mnRoomPublic(room));
});

app.post('/api/movienight/rooms/:id/candidates', requireAuth, requireValidMnRoomId, requireMovieNightPermission, async (req, res) => {
    const room = movieNightRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.phase !== 'gathering') return res.status(400).json({ error: 'Candidates locked — vote already in progress' });
    const url = String((req.body || {}).url || '').trim();
    const detect = _watchDetectSource(url);
    if (detect.sourceType === 'invalid') return res.status(400).json({ error: detect.error });
    if (room.candidates.length >= MOVIENIGHT_MAX_CANDIDATES) return res.status(400).json({ error: 'Max ' + MOVIENIGHT_MAX_CANDIDATES + ' candidates' });
    if (room.candidates.some(c => c.url === url)) return res.status(400).json({ error: 'Already in the list' });
    const meta = await scrapeOgMeta(url).catch(() => null);
    const candidate = {
        url,
        title: meta?.title || url,
        poster: meta?.poster || null,
        description: meta?.description || null,
        sourceType: detect.sourceType,
        addedBy: req.session.user.username,
        addedAt: Date.now(),
        drmBlocked: detect.sourceType === 'drm-blocked',
    };
    room.candidates.push(candidate);
    room.lastActivity = Date.now();
    _mnBroadcast(room, { type: 'candidates', candidates: room.candidates });
    res.json({ ok: true, candidate, candidates: room.candidates });
});

app.delete('/api/movienight/rooms/:id/candidates/:idx', requireAuth, requireValidMnRoomId, (req, res) => {
    const room = movieNightRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.phase !== 'gathering') return res.status(400).json({ error: 'Vote in progress' });
    const idx = parseInt(req.params.idx, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= room.candidates.length) return res.status(400).json({ error: 'Bad index' });
    const cand = room.candidates[idx];
    const un = req.session.user.username;
    if (cand.addedBy !== un && un !== room.hostUsername && req.session.user.role !== 'superadmin') {
        return res.status(403).json({ error: 'Only the candidate adder, host, or superadmin can remove it' });
    }
    room.candidates.splice(idx, 1);
    room.lastActivity = Date.now();
    _mnBroadcast(room, { type: 'candidates', candidates: room.candidates });
    res.json({ ok: true, candidates: room.candidates });
});

app.post('/api/movienight/rooms/:id/start-vote', requireAuth, requireValidMnRoomId, (req, res) => {
    const room = movieNightRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.hostUsername !== req.session.user.username && req.session.user.role !== 'superadmin') return res.status(403).json({ error: 'Host only' });
    if (room.phase !== 'gathering') return res.status(400).json({ error: 'Vote already started or decided' });
    if (room.candidates.length < 2) return res.status(400).json({ error: 'Need at least 2 candidates' });
    const now = Date.now();
    room.phase = 'voting';
    room.vote = { startedAt: now, endsAt: now + MOVIENIGHT_VOTE_WINDOW_MS, byUser: new Map(), timer: null };
    room.vote.timer = setTimeout(() => _mnFinalize(room), MOVIENIGHT_VOTE_WINDOW_MS);
    room.lastActivity = now;
    _mnBroadcast(room, { type: 'vote-started', room: _mnRoomPublic(room) });
    res.json(_mnRoomPublic(room));
});

// 🎡 Wheel mode — animated random selection. Server picks the winner index
// + broadcasts it so every viewer's wheel lands on the same slot. Host
// only. Locks the room (phase becomes 'spinning' for ~5s, then 'decided').
app.post('/api/movienight/rooms/:id/start-spin', requireAuth, requireValidMnRoomId, (req, res) => {
    const room = movieNightRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.hostUsername !== req.session.user.username && req.session.user.role !== 'superadmin') return res.status(403).json({ error: 'Host only' });
    if (room.phase !== 'gathering') return res.status(400).json({ error: 'Spin already started or decided' });
    if (room.candidates.length < 2) return res.status(400).json({ error: 'Need at least 2 candidates' });
    const playable = room.candidates.map((c, i) => c.drmBlocked ? -1 : i).filter(i => i >= 0);
    if (!playable.length) return res.status(400).json({ error: 'No playable candidates' });
    const winnerIdx = playable[Math.floor(Math.random() * playable.length)];
    room.phase = 'spinning';
    room.winnerIdx = winnerIdx;
    room.lastActivity = Date.now();
    _mnBroadcast(room, { type: 'spin-started', winnerIdx, spinDurationMs: 4500, room: _mnRoomPublic(room) });
    // Auto-finalize when the spin animation ends.
    setTimeout(() => _mnFinalize(room), 4500);
    res.json(_mnRoomPublic(room));
});

app.post('/api/movienight/rooms/:id/vote', requireAuth, requireValidMnRoomId, requireMovieNightPermission, (req, res) => {
    const room = movieNightRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.phase !== 'voting' || !room.vote) return res.status(400).json({ error: 'Vote not in progress' });
    if (Date.now() > room.vote.endsAt) return res.status(400).json({ error: 'Voting window closed' });
    const idx = parseInt((req.body || {}).idx, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= room.candidates.length) return res.status(400).json({ error: 'Bad candidate index' });
    room.vote.byUser.set(req.session.user.username, idx);
    room.lastActivity = Date.now();
    _mnBroadcast(room, { type: 'tally', tallies: _mnTallies(room) });
    res.json({ ok: true });
});

app.post('/api/movienight/rooms/:id/end-vote', requireAuth, requireValidMnRoomId, (req, res) => {
    const room = movieNightRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.hostUsername !== req.session.user.username && req.session.user.role !== 'superadmin') return res.status(403).json({ error: 'Host only' });
    if (room.phase !== 'voting') return res.status(400).json({ error: 'Not in voting phase' });
    _mnFinalize(room);
    res.json(_mnRoomPublic(room));
});

app.delete('/api/movienight/rooms/:id', requireAuth, requireValidMnRoomId, (req, res) => {
    const room = movieNightRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.hostUsername !== req.session.user.username && req.session.user.role !== 'superadmin') return res.status(403).json({ error: 'Host only' });
    _mnBroadcast(room, { type: 'closed' });
    for (const ws of room.viewers) { try { ws.close(); } catch {} }
    if (room.vote?.timer) clearTimeout(room.vote.timer);
    movieNightRooms.delete(req.params.id);
    res.json({ ok: true });
});

app.get('/movienight/:id', (req, res) => {
    if (!MN_ID_RE.test(String(req.params.id || ''))) return res.status(400).type('text/plain').send('Invalid room id');
    res.sendFile(path.join(__dirname, 'public', 'movienight.html'));
});

// Search weflix's catalog by title. Scrapes their listing page since they
// don't expose a JSON API. Falls back to /movies?q=<query> which their
// search UI uses. Title + poster + canonical /movie/<slug> URL returned.
app.get('/api/movienight/catalog-search', requireAuth, requireMovieNightPermission, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q || q.length > 100) return res.status(400).json({ error: 'Bad query' });
    try {
        const url = 'https://weflix.org/search?keyword=' + encodeURIComponent(q);
        const r = await fetch(url, {
            headers: {
                'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml',
            },
        });
        if (!r.ok) return res.status(502).json({ error: 'weflix returned ' + r.status });
        const html = await r.text();
        // weflix cards: <a href="/movie/<slug>" ...><img src=poster ... alt="title"></a>
        // Tolerate variations. Extract dedupe by slug.
        const seen = new Set();
        const items = [];
        const re = /<a[^>]+href=["']\/(movie|tv-shows|tv-show|anime)\/([^"'\/]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = re.exec(html)) && items.length < 30) {
            const path = '/' + m[1] + '/' + m[2];
            if (seen.has(path)) continue;
            seen.add(path);
            const inner = m[3];
            const imgM = inner.match(/<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*(?:alt=["']([^"']+)["'])?/i);
            const titleM = inner.match(/<(?:h\d|div|span)[^>]+(?:class=["'][^"']*(?:title|name)[^"']*["'])[^>]*>([^<]+)</i);
            const title = (titleM && titleM[1] || imgM && imgM[2] || m[2].replace(/-/g, ' ')).trim();
            const poster = imgM && imgM[1] || null;
            items.push({ url: 'https://weflix.org' + path, title, poster });
        }
        res.json({ items, query: q });
    } catch (err) {
        console.error('[movienight] catalog-search failed:', err.message);
        res.status(502).json({ error: 'Catalog search failed: ' + err.message });
    }
});

app.delete('/api/watch/rooms/:id', requireAuth, requireValidWatchRoomId, (req, res) => {
    const room = watchRooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const un = req.session.user.username;
    if (un !== room.hostUsername && req.session.user.role !== 'superadmin') return res.status(403).json({ error: 'Only the host can close the room.' });
    _watchBroadcast(room, { type: 'closed' });
    for (const ws of room.viewers) { try { ws.close(); } catch {} }
    if (room.sourceMeta?.captureId) stopCaptureProxy(room.sourceMeta.captureId);
    watchRooms.delete(req.params.id);
    console.log(`[watch] room ${req.params.id} closed by ${un}`);
    res.json({ ok: true });
});

// Full suno metadata for one saved sound (used by the "regenerate" flow).
app.get('/api/suno/sound/:filename', requireAuth, (req, res) => {
    const safe = path.basename(req.params.filename);
    const meta = loadSoundsMeta();
    const m = meta[safe];
    if (!m || typeof m !== 'object' || !m.suno) return res.status(404).json({ error: 'No suno metadata for this sound' });
    res.json({ filename: safe, suno: m.suno, displayName: m.displayName || safe });
});

// --- Superadmin: voice training jobs ---

app.get('/api/superadmin/tts/train', requireSuperadmin, (req, res) => {
    try {
        const jobs = voiceTrainer.listJobs().sort((a, b) => b.started_at - a.started_at).slice(0, 50);
        const jobsWithProgress = jobs.map(j => ({ ...j, progress: voiceTrainer.computeProgress(j.id) }));
        res.json({ jobs: jobsWithProgress });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/superadmin/tts/train', requireSuperadmin, (req, res) => {
    try {
        const job = voiceTrainer.startJob(req.body || {});
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'voice-train.start',
            target: job && job.id ? String(job.id) : null,
            details: {
                voice_id: job && job.voice_id,
                run_after: (req.body && req.body.run_after) || null,
                urls: Array.isArray(req.body && req.body.urls) ? req.body.urls.length : undefined,
                target_engine: job && job.input && job.input.target_engine,
            },
        });
        res.json({ ok: true, job });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.get('/api/superadmin/tts/train/:id', requireSuperadmin, (req, res) => {
    try {
        const since = parseInt(req.query.since || '0', 10);
        const meta = voiceTrainer.getJobStatus(req.params.id);
        const { events, lines } = voiceTrainer.getJobEvents(req.params.id, since);
        const progress = voiceTrainer.computeProgress(req.params.id);
        res.json({ meta, events, progress, next_since: lines });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/superadmin/tts/train/:id/cancel', requireSuperadmin, (req, res) => {
    try {
        const meta = voiceTrainer.cancelJob(req.params.id);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'voice-train.cancel',
            target: String(req.params.id),
            details: { voice_id: meta && meta.voice_id, status: meta && meta.status },
        });
        res.json({ ok: true, meta });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/superadmin/tts/train/:id', requireSuperadmin, (req, res) => {
    try {
        const result = voiceTrainer.deleteJob(req.params.id);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'voice-train.delete',
            target: String(req.params.id),
            details: { voice_id: result.voice_id },
        });
        res.json({ ok: true, ...result });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/superadmin/tts/train/:id/adopt', requireSuperadmin, (req, res) => {
    try {
        const meta = voiceTrainer.adoptOrphan(req.params.id);
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'voice-train.adopt-orphan',
            target: String(req.params.id),
            details: { voice_id: meta && meta.input && meta.input.voice_id, pipeline_job_dir: meta && meta.pipeline_job_dir },
        });
        res.json({ ok: true, meta });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/superadmin/tts/train/:id/resume', requireSuperadmin, (req, res) => {
    try {
        const runAfter = (req.body && req.body.run_after) || null;
        const meta = voiceTrainer.resumeJob(req.params.id, { run_after: runAfter });
        statsDb.recordAdminAction({
            actor: req.session.user.username,
            actorRole: req.session.user.role,
            action: 'voice-train.resume',
            target: String(req.params.id),
            details: {
                voice_id: meta && meta.voice_id,
                status: meta && meta.status,
                run_after: meta && meta.run_after,
            },
        });
        res.json({ ok: true, meta });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

const token = (process.env.DISCORD_TOKEN || '').trim();
if (!token || token === 'your_bot_token_here') {
    console.error('DISCORD_TOKEN is missing or still the placeholder. Set it in .env from Discord Developer Portal → Your App → Bot → Token');
    process.exit(1);
}
// Log in with retry/backoff so a transient Discord outage or network blip at
// startup doesn't reject an uncaught promise and crash-loop the whole web UI
// (uploads, TTS, watch parties — none of which need Discord). An invalid token
// still exits immediately.
function loginWithRetry(attempt = 0) {
    client.login(token).catch((err) => {
        if (err && (err.code === 'TokenInvalid' || /invalid token/i.test(err.message || ''))) {
            console.error('[discord] invalid bot token — exiting');
            process.exit(1);
        }
        const delay = Math.min(60_000, 5_000 * 2 ** attempt);
        console.error(`[discord] login failed (${err && err.message}), retrying in ${Math.round(delay / 1000)}s`);
        setTimeout(() => loginWithRetry(attempt + 1), delay).unref();
    });
}
loginWithRetry();
// Start the voice-training queue scheduler so queued/scheduled jobs get picked
// up automatically when the GPU is free.
try { voiceTrainer.startScheduler(); } catch (e) { console.error('[voice-trainer] scheduler failed to start:', e.message); }
// Global error handler (registered after all routes). Catches synchronous
// throws in handlers and anything passed to next(err); returns a clean JSON
// error instead of leaking a stack trace, and logs the real error server-side.
app.use((err, req, res, next) => {
    console.error('[route error]', req.method, req.path, '-', err && (err.stack || err.message || err));
    if (res.headersSent) return next(err);
    res.status(err && err.status ? err.status : 500).json({ error: 'Internal error' });
});

const PORT = process.env.PORT || 3000;
const httpServer = app.listen(PORT, () => {
    console.log(`🌐 Web UI running at http://localhost:${PORT}`);
});

// WebSocket upgrade for Watch Together rooms.
const { WebSocketServer } = require('ws');
const watchWss = new WebSocketServer({ noServer: true });
watchWss.on('connection', (ws, req, room, username, role) => {
    ws._un = username;
    ws._role = role || null;
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });
    room.viewers.add(ws);
    room.lastActivity = Date.now();
    try {
        ws.send(JSON.stringify({
            type: 'hello',
            room: _watchRoomPublic(room),
            you: username,
            yourRole: role || null,
        }));
    } catch {}
    _watchBroadcast(room, { type: 'viewers', count: room.viewers.size, list: _viewerList(room) });
    ws.on('message', () => {});
    const cleanup = () => {
        room.viewers.delete(ws);
        if (watchRooms.has(room.id)) _watchBroadcast(room, { type: 'viewers', count: room.viewers.size, list: _viewerList(room) });
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
});

// WebSocket upgrade for Movie Night rooms — same shape, different room map.
const mnWss = new WebSocketServer({ noServer: true });
mnWss.on('connection', (ws, req, room, username, role) => {
    ws._un = username;
    ws._role = role || null;
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });
    room.viewers.add(ws);
    room.lastActivity = Date.now();
    try {
        ws.send(JSON.stringify({
            type: 'hello',
            room: _mnRoomPublic(room),
            you: username,
            yourRole: role || null,
        }));
    } catch {}
    _mnBroadcast(room, { type: 'viewers', count: room.viewers.size, list: _viewerList(room) });
    ws.on('message', () => {});
    const cleanup = () => {
        room.viewers.delete(ws);
        if (movieNightRooms.has(room.id)) _mnBroadcast(room, { type: 'viewers', count: room.viewers.size, list: _viewerList(room) });
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
});

// Heartbeat: ping every watch/movie-night viewer; terminate any that miss a
// round so a viewer whose network dropped uncleanly stops pinning the room —
// and its Xvfb+Chromium+ffmpeg capture quartet — open forever. Once the last
// real viewer is gone the room sweep can reclaim everything.
const _roomWssHeartbeat = setInterval(() => {
    for (const wss of [watchWss, mnWss]) {
        wss.clients.forEach((ws) => {
            if (ws._alive === false) { try { ws.terminate(); } catch {} return; }
            ws._alive = false;
            try { ws.ping(); } catch {}
        });
    }
}, 30000);
_roomWssHeartbeat.unref();

// WebSocket upgrade tunnel for the yt-session noVNC proxy. Authenticates the
// upgrade using the same session cookie as the rest of the app, then pipes
// bytes through to the localhost websockify.
httpServer.on('upgrade', (req, socket, head) => {
    // Movie Night rooms: /api/movienight/rooms/<id>/socket
    const mnm = req.url && req.url.match(/^\/api\/movienight\/rooms\/(mn_[a-f0-9]{8})\/socket$/i);
    if (mnm) {
        const stubRes = { setHeader: () => {}, getHeader: () => undefined, writeHead: () => {}, end: () => {}, on: () => {}, once: () => {}, emit: () => {} };
        sessionMiddleware(req, stubRes, () => {
            const user = req.session?.user;
            if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); try { socket.destroy(); } catch {} return; }
            if (!getMovieNightEnabled(user.role, user.username)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); try { socket.destroy(); } catch {} return; }
            const room = movieNightRooms.get(mnm[1]);
            if (!room) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); try { socket.destroy(); } catch {} return; }
            mnWss.handleUpgrade(req, socket, head, (ws) => { mnWss.emit('connection', ws, req, room, user.username, user.role); });
        });
        return;
    }
    // Watch Together rooms: /api/watch/rooms/<id>/socket
    const wm = req.url && req.url.match(/^\/api\/watch\/rooms\/(w_[a-f0-9]{8})\/socket$/i);
    if (wm) {
        const stubRes = { setHeader: () => {}, getHeader: () => undefined, writeHead: () => {}, end: () => {}, on: () => {}, once: () => {}, emit: () => {} };
        sessionMiddleware(req, stubRes, () => {
            const user = req.session?.user;
            if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); try { socket.destroy(); } catch {} return; }
            if (!getWatchPartyEnabled(user.role, user.username)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); try { socket.destroy(); } catch {} return; }
            const room = watchRooms.get(wm[1]);
            if (!room) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); try { socket.destroy(); } catch {} return; }
            if (room.viewers.size >= WATCH_ROOM_MAX_VIEWERS) { socket.write('HTTP/1.1 503 Too Many Viewers\r\n\r\n'); try { socket.destroy(); } catch {} return; }
            watchWss.handleUpgrade(req, socket, head, (ws) => {
                watchWss.emit('connection', ws, req, room, user.username, user.role);
            });
        });
        return;
    }
    if (!req.url || !req.url.startsWith(YT_VNC_PROXY_PREFIX + '/')) return;
    // express-session expects a Response-shaped object for setHeader / on('header').
    // We never send a response on this code path — we hijack the socket directly —
    // so a tiny stub is enough.
    const stubRes = { setHeader: () => {}, getHeader: () => undefined, writeHead: () => {}, end: () => {}, on: () => {}, once: () => {}, emit: () => {} };
    sessionMiddleware(req, stubRes, () => {
        if (req.session?.user?.role !== 'superadmin') {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            try { socket.destroy(); } catch {}
            return;
        }
        const upstreamPath = req.url.slice(YT_VNC_PROXY_PREFIX.length) || '/';
        const upstream = require('net').connect(YT_NOVNC_PORT, YT_NOVNC_HOST, () => {
            let raw = `${req.method} ${upstreamPath} HTTP/1.1\r\n`;
            for (const [k, v] of Object.entries(req.headers)) {
                if (Array.isArray(v)) for (const vv of v) raw += `${k}: ${vv}\r\n`;
                else raw += `${k}: ${v}\r\n`;
            }
            raw += '\r\n';
            upstream.write(raw);
            if (head && head.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        upstream.on('error', () => { try { socket.destroy(); } catch {} });
        socket.on('error', () => { try { upstream.destroy(); } catch {} });
    });
});
}

sodium.ready.then(() => {
    console.log('🔐 Voice encryption ready');
    startApp();
}).catch(err => {
    console.error('Failed to initialize voice encryption (libsodium-wrappers):', err);
    process.exit(1);
});
