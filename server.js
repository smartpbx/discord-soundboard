require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Discord voice requires an encryption lib to be ready *before* the first connection.
// Load it first so @discordjs/voice can use it.
const sodium = require('libsodium-wrappers');

function startApp() {
const { Readable } = require('stream');
const express = require('express');
const multer = require('multer');
const { execSync, spawn } = require('child_process');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, getVoiceConnection, StreamType, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const statsDb = require('./lib/stats-db');
const ttsVoiceAdmin = require('./lib/tts-voice-admin');
const voiceTrainer = require('./lib/voice-trainer');

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

const DEFAULT_GUEST_COOLDOWN_SEC = 10;
const DEFAULT_GUEST_MAX_DURATION = 7;
const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2MB

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

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return req.ip || req.connection?.remoteAddress || 'unknown';
}

function loadGuestData() {
    try {
        const raw = fs.readFileSync(GUEST_DATA_PATH, 'utf8');
        const data = JSON.parse(raw);
        return typeof data === 'object' && data !== null ? data : { enabled: false, blockedIPs: [], history: [] };
    } catch {
        return { enabled: false, blockedIPs: [], history: [] };
    }
}

function saveGuestData(data) {
    fs.writeFileSync(GUEST_DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
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

function getUserUploadEnabled() {
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

function getUserMaxUploadDuration() {
    const d = loadGuestData();
    const n = Number(d.userMaxUploadDuration);
    return Number.isFinite(n) && n > 0 ? n : (Number(d.maxUploadDuration) || 7);
}

function setUserMaxUploadDuration(sec) {
    const d = loadGuestData();
    d.userMaxUploadDuration = Number(sec) > 0 ? Number(sec) : 7;
    saveGuestData(d);
}

function getUserMaxUploadBytes() {
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

function getUserMaxDuration() {
    const d = loadGuestData();
    const n = Number(d.userMaxDuration);
    return Number.isFinite(n) && n > 0 ? n : 7;
}

function setUserMaxDuration(sec) {
    const d = loadGuestData();
    d.userMaxDuration = Number(sec) > 0 ? Number(sec) : 7;
    saveGuestData(d);
}

function getUserCooldownSec() {
    const d = loadGuestData();
    const n = Number(d.userCooldownSec);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function setUserCooldownSec(sec) {
    const d = loadGuestData();
    d.userCooldownSec = Number(sec) >= 0 ? Number(sec) : 0;
    saveGuestData(d);
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
function getTtsEnabled() {
    const d = loadGuestData();
    return d.ttsEnabled === true;
}
function setTtsEnabled(v) {
    const d = loadGuestData();
    d.ttsEnabled = !!v;
    saveGuestData(d);
}
function getTtsMaxTextLength(role) {
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
function getTtsCooldownSec(role) {
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

// --- URL streaming settings (per-role enable + max duration) ---
function getUrlStreamEnabled(role) {
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
function getUrlStreamMaxDurationSec(role) {
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

function loadServerState() {
    try {
        const raw = fs.readFileSync(SERVER_STATE_PATH, 'utf8');
        const data = JSON.parse(raw);
        return typeof data === 'object' && data !== null ? data : {};
    } catch {
        return {};
    }
}

function saveServerState(updates) {
    try {
        const state = { ...loadServerState(), ...updates };
        fs.writeFileSync(SERVER_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save server state:', err.message);
    }
}

const RECENTLY_PLAYED_MAX = 5;
function getRecentlyPlayedFromState() {
    const state = loadServerState();
    const arr = Array.isArray(state.recentlyPlayed) ? state.recentlyPlayed : [];
    return arr.slice(0, RECENTLY_PLAYED_MAX);
}
function addToRecentlyPlayedServer(filename, displayName, playedBy, playedAt) {
    if (!filename) return;
    let list = getRecentlyPlayedFromState();
    list = list.filter((x) => x.filename !== filename);
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
    fs.writeFileSync(PENDING_META_PATH, JSON.stringify(data, null, 2), 'utf8');
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
    fs.writeFileSync(SOUNDS_META_PATH, JSON.stringify(data, null, 2), 'utf8');
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
app.use(express.static('public'));
app.use(express.json());
app.use(require('cookie-parser')());
app.use(require('express-session')({
    secret: process.env.SESSION_SECRET || 'soundboard-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));


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
    fs.writeFileSync(USERS_JSON_PATH, JSON.stringify({ users: arr }, null, 2), 'utf8');
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
    fs.writeFileSync(PENDING_USERS_PATH, JSON.stringify(arr, null, 2), 'utf8');
}
function addApprovedUser(username, password, role) {
    const un = String(username).trim().toLowerCase();
    if (!un || !password) return false;
    const r = (role === 'admin' ? 'admin' : 'user');
    USERS.set(un, { username: un, password: password, role: r, mustChangePassword: false, disabled: false });
    approvedSignups.push({ username: un, password, role: r, mustChangePassword: false, disabled: false });
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
    approvedSignups[idx].password = newPassword;
    approvedSignups[idx].mustChangePassword = forceChange === true;
    const entry = USERS.get(un);
    if (entry) {
        entry.password = newPassword;
        entry.mustChangePassword = forceChange === true;
    }
    saveApprovedSignups(approvedSignups);
    return true;
}
function updateOwnPassword(username, currentPassword, newPassword) {
    const un = String(username).trim().toLowerCase();
    const entry = USERS.get(un);
    if (!entry || entry.password !== currentPassword) return false;
    if (envUsernames.has(un)) return false;
    const idx = approvedSignups.findIndex(u => u.username === un);
    if (idx < 0) return false;
    if (!newPassword || newPassword.length < 6) return false;
    approvedSignups[idx].password = newPassword;
    approvedSignups[idx].mustChangePassword = false;
    entry.password = newPassword;
    entry.mustChangePassword = false;
    saveApprovedSignups(approvedSignups);
    return true;
}
// --- Discord user linking & entrance/exit sounds ---
// data/discord-links.json shape:
// { globalEnabled: bool, users: { [username]: { discordId, entranceSound, exitSound, disabled } } }
function loadDiscordLinks() {
    try {
        const raw = fs.readFileSync(DISCORD_LINKS_PATH, 'utf8');
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') return { globalEnabled: false, users: {} };
        return {
            globalEnabled: data.globalEnabled === true,
            users: (data.users && typeof data.users === 'object') ? data.users : {},
        };
    } catch {
        return { globalEnabled: false, users: {} };
    }
}
function saveDiscordLinks(data) {
    fs.writeFileSync(DISCORD_LINKS_PATH, JSON.stringify(data, null, 2), 'utf8');
}
function getDiscordLinkGlobalEnabled() {
    return loadDiscordLinks().globalEnabled === true;
}
function setDiscordLinkGlobalEnabled(enabled) {
    const d = loadDiscordLinks();
    d.globalEnabled = enabled === true;
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
    }
    next();
}
function requireAdmin(req, res, next) {
    if (injectCompanionAuth(req)) return next();
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'superadmin') return res.status(403).json({ error: 'Admin or superadmin only' });
    next();
}

function requireSuperadmin(req, res, next) {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (req.session.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
    next();
}

function checkCredentials(username, password) {
    const u = username ? String(username).trim().toLowerCase() : '';
    const p = String(password || '');
    const entry = USERS.get(u);
    if (entry && entry.password === p) {
        if (entry.disabled === true) return { disabled: true };
        return { username: entry.username, role: entry.role, mustChangePassword: entry.mustChangePassword === true };
    }
    return null;
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

    addTrack(pcmStream, metadata) {
        const id = this.nextTrackId++;
        const track = { id, stream: pcmStream, chunks: [], chunkBytes: 0, ended: false, metadata };
        pcmStream.on('data', chunk => { track.chunks.push(chunk); track.chunkBytes += chunk.length; });
        pcmStream.on('end', () => { track.ended = true; });
        pcmStream.on('error', () => { track.ended = true; });
        this.tracks.set(id, track);
        if (!this.mixTimer) this._startMixing();
        return id;
    }

    _consumeFrame(track) {
        if (track.chunkBytes < this.FRAME_SIZE) return null;
        // Consolidate chunks into a single buffer and slice a frame
        const buf = Buffer.concat(track.chunks);
        const frame = buf.subarray(0, this.FRAME_SIZE);
        const rest = buf.subarray(this.FRAME_SIZE);
        track.chunks = rest.length > 0 ? [rest] : [];
        track.chunkBytes = rest.length;
        return frame;
    }

    removeTrack(id) {
        const track = this.tracks.get(id);
        if (track) {
            if (track.stream && !track.stream.destroyed) track.stream.destroy();
            this.tracks.delete(id);
        }
    }

    removeAllTracks() {
        for (const [, track] of this.tracks) {
            if (track.stream && !track.stream.destroyed) track.stream.destroy();
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
                for (const [, track] of this.tracks) {
                    const frame = this._consumeFrame(track);
                    if (frame) {
                        for (let i = 0; i < this.FRAME_SIZE; i += 2) {
                            let sum = mixed.readInt16LE(i) + frame.readInt16LE(i);
                            mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i);
                        }
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

client.once('ready', () => {
    console.log(`🤖 Bot logged in as ${client.user.tag}`);
    if (lastChannelId) {
        const channel = client.channels.cache.get(lastChannelId);
        if (channel?.isVoiceBased()) {
            activeGuildId = channel.guild.id;
            currentConnection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                daveEncryption: true,
                debug: true,
            });
            currentConnection.on('error', err => {
                console.error('Voice connection error:', err.message);
                leaveVoiceChannel();
            });
            currentConnection.on('close', code => { console.log('[DIAG] voice.close code=', code); });
            currentConnection.on('debug', msg => { console.log('[DIAG] voice.debug', msg); });
            currentConnection.on('stateChange', (o, n) => {
                const rejoin = currentConnection?.rejoinAttempts ?? '?';
                const nwCode = n.networking?.state?.code ?? '?';
                console.log('[DIAG] voice.stateChange', o.status, '->', n.status, 'rejoinAttempts=', rejoin, 'networkingCode=', nwCode);
            });
            currentConnection.subscribe(player);
            console.log(`🔊 Auto-joined ${channel.name}`);
        }
    }
});

// Play entrance/exit sounds when linked users join or leave the bot's current channel.
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        if (!getDiscordLinkGlobalEnabled()) return;
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

app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = checkCredentials(String(username || ''), String(password || ''));
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    if (user.disabled) return res.status(403).json({ error: 'Account is disabled. Contact an admin.' });
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
    const { username, password } = req.body || {};
    const un = String(username || '').trim();
    const pw = String(password || '');
    if (!un || !pw) return res.status(400).json({ error: 'Username and password required' });
    if (!USERNAME_RE.test(un)) return res.status(400).json({ error: 'Username must be 2–32 chars, letters, numbers, underscore, hyphen only' });
    if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const unLower = un.toLowerCase();
    if (USERS.has(unLower)) return res.status(400).json({ error: 'Username already taken' });
    const pending = loadPendingUsers();
    if (pending.some(p => String(p.username || '').toLowerCase() === unLower)) return res.status(400).json({ error: 'Registration already pending' });
    pending.push({ username: unLower, password: pw, createdAt: Date.now() });
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

// Catch and log audio errors so the bot doesn't crash silently
player.on('error', error => {
    const meta = error.resource?.metadata ?? 'unknown';
    console.error(`❌ Audio Player Error: ${error.message} (resource: ${meta})`);
    console.log('[DIAG] player.error', error.message, 'resource:', meta);
    finalizeAllOpenPlays(true);
    playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, duration: null, startedBy: null };
    if (activeMixer) { activeMixer.destroy(); activeMixer = null; }
    activeTracks.clear();
});

player.on('stateChange', (oldState, newState) => {
    console.log('[DIAG] player.stateChange', oldState.status, '->', newState.status);
    if (newState.status === AudioPlayerStatus.Idle) {
        const wasTts = playbackState.tts === true;
        finalizeAllOpenPlays();
        playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, duration: null, startedBy: null };
        if (activeMixer) { activeMixer.destroy(); activeMixer = null; }
        activeTracks.clear();
        if (wasTts) ttsIsPlaying = false;
        processTtsQueue();
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
            const trackId = activeMixer.addTrack(ff.stdout, { filename: 'tts', displayName });
            activeTracks.set(trackId, { filename: 'tts', displayName, startTime: Date.now(), startTimeOffset: 0, duration: null, startedBy });
            playbackState = { status: 'playing', filename: 'tts', displayName, startTime: Date.now(), startTimeOffset: 0, duration: null, startedBy, tts: true, ttsVoice: voiceId };
        } else {
            const ff = spawn('ffmpeg', ['-nostdin', '-i', 'pipe:0', '-f', 'mp3', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
            ff.stderr.on('data', () => {});
            ff.on('error', (err) => console.error('[TTS] ffmpeg error', err));
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
    if (ttsIsPlaying || ttsQueue.length === 0) return;
    // Don't start TTS if a non-TTS sound is currently playing
    const playerStatus = player.state.status;
    if ((playerStatus === AudioPlayerStatus.Playing || playerStatus === AudioPlayerStatus.Buffering) && !playbackState.tts) return;
    const item = ttsQueue.shift();
    console.log('[TTS Queue] playing next item, %d remaining', ttsQueue.length);
    addToRecentlyPlayedServer('tts', item.displayName, item.startedBy?.username ?? null, Date.now());
    playTtsBuffer(item);
}

function leaveVoiceChannel() {
    if (activeGuildId) {
        player.stop();
        if (activeMixer) { activeMixer.destroy(); activeMixer = null; }
        activeTracks.clear();
        const connection = getVoiceConnection(activeGuildId);
        if (connection) connection.destroy();
        activeGuildId = null;
        currentConnection = null;
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

    activeGuildId = channel.guild.id;
    currentConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        daveEncryption: true,
        debug: true,
    });
    currentConnection.on('error', err => {
        console.error('Voice connection error:', err.message);
        console.log('[DIAG] voice.connectionError', err.message);
        leaveVoiceChannel();
    });
    currentConnection.on('close', code => { console.log('[DIAG] voice.close code=', code); });
    currentConnection.on('debug', msg => { console.log('[DIAG] voice.debug', msg); });
    currentConnection.on('stateChange', (o, n) => {
        const rejoin = currentConnection?.rejoinAttempts ?? '?';
        const nwCode = n.networking?.state?.code ?? '?';
        console.log('[DIAG] voice.stateChange', o.status, '->', n.status, 'rejoinAttempts=', rejoin, 'networkingCode=', nwCode);
    });
    currentConnection.subscribe(player);
    console.log('[DIAG] voice.join channelId=', channelId, 'guildId=', channel.guild.id, 'connectionState=', currentConnection.state?.status ?? 'unknown');
    lastChannelId = channelId;
    saveServerState({ lastChannelId });
    res.send(`Joined ${channel.name}`);
});

app.post('/api/leave', requireAdmin, (req, res) => {
    if (leaveVoiceChannel()) {
        res.send('Left channel');
    } else {
        res.send('Not in a channel');
    }
});

app.get('/api/sounds', requireAuth, (req, res) => {
    fs.readdir(SOUNDS_DIR, (err, files) => {
        if (err) return res.status(500).send('Error reading sounds directory');
        const meta = loadSoundsMeta();
        const audioFiles = (files || []).filter(f => f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.ogg'));
        const order = getSoundOrder(meta);
        const orderSet = new Set(order);
        const ordered = order.filter(f => audioFiles.includes(f));
        const rest = audioFiles.filter(f => !orderSet.has(f));
        const sorted = [...ordered, ...rest];
        const list = sorted.map(filename => ({
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
        }));
        const tagOrder = getTagOrder(meta);
        const hidden = getHiddenTags(meta);
        const allTags = getAllTagsFromSounds(meta);
        const tags = tagOrder.length ? [...tagOrder, ...allTags.filter(t => !tagOrder.includes(t))] : allTags;
        res.json({ list, tags: [...new Set(tags)], hidden });
    });
});

app.patch('/api/sounds/order', requireAdmin, (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
    const safe = order.filter(f => typeof f === 'string' && /\.(mp3|wav|ogg)$/i.test(f));
    setSoundOrder(safe);
    res.json({ order: safe });
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
    res.setHeader('Cache-Control', 'no-cache');
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

app.delete('/api/sounds/:filename', requireSuperadmin, (req, res) => {
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
function normalizeFileInPlace(filePath, cb) {
    const measure = spawn('ffmpeg', ['-nostdin', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    normalizeFileInPlace(filePath, (err, result) => {
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
        out.autoNormalizeUploads = getAutoNormalizeUploads();
        const pending = (loadPendingMeta().uploads || []).filter(u => fs.existsSync(path.join(PENDING_DIR, u.filename)));
        out.pendingCount = pending.length;
        // TTS settings (superadmin)
        out.ttsEnabled = getTtsEnabled();
        out.ttsAvailable = !!TTS_API_URL;
        out.ttsMaxTextLength = { guest: getTtsMaxTextLength('guest'), user: getTtsMaxTextLength('user'), admin: getTtsMaxTextLength('admin'), superadmin: getTtsMaxTextLength('superadmin') };
        out.ttsCooldownSec = { guest: getTtsCooldownSec('guest'), user: getTtsCooldownSec('user'), admin: getTtsCooldownSec('admin'), superadmin: getTtsCooldownSec('superadmin') };
        out.ttsDisabledVoices = getTtsDisabledVoices();
        out.ttsVoiceRvcOverrides = getTtsVoiceRvcOverrides();
        out.ttsMaxQueueSize = getTtsMaxQueueSize();
    }
    // TTS availability for all roles
    out.ttsEnabled = getTtsEnabled();
    out.ttsAvailable = !!TTS_API_URL;
    out.autoNormalizeUploads = getAutoNormalizeUploads();
    const role = req.session.user.role;
    out.ttsMaxTextLength_self = getTtsMaxTextLength(role);
    out.ttsCooldownSec_self = getTtsCooldownSec(role);
    // URL streaming: per-role config (superadmin sees full matrix, others get only their own)
    if (req.session.user.role === 'superadmin') {
        out.urlStreamEnabled = { guest: getUrlStreamEnabled('guest'), user: getUrlStreamEnabled('user'), admin: getUrlStreamEnabled('admin'), superadmin: getUrlStreamEnabled('superadmin') };
        out.urlStreamMaxDurationSec = { guest: getUrlStreamMaxDurationSec('guest'), user: getUrlStreamMaxDurationSec('user'), admin: getUrlStreamMaxDurationSec('admin'), superadmin: getUrlStreamMaxDurationSec('superadmin') };
    }
    out.urlStreamEnabled_self = getUrlStreamEnabled(role);
    out.urlStreamMaxDurationSec_self = getUrlStreamMaxDurationSec(role);
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
            out.userMaxDuration = getUserMaxDuration();
            out.userCooldownSec = getUserCooldownSec();
            out.userUploadEnabled = getUserUploadEnabled();
            if (getUserUploadEnabled()) {
                out.userMaxUploadDuration = getUserMaxUploadDuration();
                out.userMaxUploadBytes = getUserMaxUploadBytes();
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
        const { ttsDisabledVoices, ttsVoiceRvcOverrides, ttsMaxQueueSize } = req.body;
        if (Array.isArray(ttsDisabledVoices)) { setTtsDisabledVoices(ttsDisabledVoices); out.ttsDisabledVoices = getTtsDisabledVoices(); }
        if (ttsVoiceRvcOverrides && typeof ttsVoiceRvcOverrides === 'object' && !Array.isArray(ttsVoiceRvcOverrides)) { setTtsVoiceRvcOverrides(ttsVoiceRvcOverrides); out.ttsVoiceRvcOverrides = getTtsVoiceRvcOverrides(); }
        if (typeof ttsMaxQueueSize === 'number') { setTtsMaxQueueSize(ttsMaxQueueSize); out.ttsMaxQueueSize = getTtsMaxQueueSize(); }
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
    res.json({ globalEnabled: d.globalEnabled === true, users: list });
});

app.patch('/api/superadmin/entrance-exit-config', requireSuperadmin, (req, res) => {
    const body = req.body || {};
    if ('globalEnabled' in body) setDiscordLinkGlobalEnabled(body.globalEnabled === true);
    statsDb.recordAdminAction({
        actor: req.session.user.username,
        actorRole: req.session.user.role,
        action: 'entrance-exit.config',
        target: null,
        details: { globalEnabled: body.globalEnabled === true },
    });
    res.json({ ok: true, globalEnabled: getDiscordLinkGlobalEnabled() });
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
    const isAdminOrSuper = role === 'admin' || role === 'superadmin';
    const canDirectUpload = isAdminOrSuper;
    const canGuestPendingUpload = role === 'guest' && getGuestUploadEnabled();
    const canUserPendingUpload = role === 'user' && getUserUploadEnabled();
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
    const maxBytes = role === 'guest' ? getGuestMaxUploadBytes() : getUserMaxUploadBytes();
    if (size > maxBytes) {
        fs.unlink(tempPath, () => {});
        return res.status(400).json({ error: `File too large. Max ${Math.round(maxBytes / 1024)}KB.` });
    }

    fs.rename(tempPath, targetPath, (err) => {
        if (err) return res.status(500).json({ error: 'Error saving file' });
        const duration = probeDuration(targetPath);
        const maxDur = role === 'guest' ? getGuestMaxUploadDuration() : getUserMaxUploadDuration();
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
            const trackId = activeMixer.addTrack(ff.stdout, { filename: safeFilename, displayName });
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
        const cooldownSec = getUserCooldownSec();
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
    const maxDur = isGuest ? getGuestMaxDuration() : getUserMaxDuration();
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

            const trackId = activeMixer.addTrack(ff.stdout, { filename: safeFilename, displayName });
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

// Args applied to every yt-dlp invocation. The android/ios player clients
// avoid YouTube's 'Sign in to confirm you're not a bot' wall that hits the
// default web client, and also expose Shorts formats. YTDLP_COOKIES_FILE
// lets an operator point at an exported cookies.txt for gated content.
function ytdlpCommonArgs() {
    const args = ['--extractor-args', 'youtube:player_client=android,ios,web'];
    const cookies = (process.env.YTDLP_COOKIES_FILE || '').trim();
    if (cookies) args.push('--cookies', cookies);
    const extra = (process.env.YTDLP_EXTRA_ARGS || '').trim();
    if (extra) args.push(...extra.split(/\s+/));
    return args;
}
let activeUrlStream = null; // { ytdlp, ff, killTimer }
// previewId -> { filePath, url, title, duration, createdAt, username }
const urlPreviewCache = new Map();

function sweepUrlPreviews() {
    const now = Date.now();
    for (const [id, entry] of urlPreviewCache) {
        if (now - entry.createdAt > URL_PREVIEW_TTL_MS) {
            try { fs.unlinkSync(entry.filePath); } catch {}
            urlPreviewCache.delete(id);
        }
    }
    try {
        for (const name of fs.readdirSync(URL_PREVIEW_DIR)) {
            const full = path.join(URL_PREVIEW_DIR, name);
            const st = fs.statSync(full);
            if (now - st.mtimeMs > URL_PREVIEW_TTL_MS) {
                try { fs.unlinkSync(full); } catch {}
            }
        }
    } catch {}
}
setInterval(sweepUrlPreviews, 10 * 60 * 1000).unref();

function validateStreamUrl(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1') return null;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return null;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return null;
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

// Download the URL audio to a server-side cache so the client can render a
// waveform, scrub locally, and then either stream the trimmed segment to
// Discord or import it as a sound — all without re-downloading.
app.post('/api/stream-url/preview', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    if (!getUrlStreamEnabled(role)) return res.status(403).json({ error: 'URL streaming is disabled for your role.' });
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
    const maxPlay = getUrlStreamMaxDurationSec(role);
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
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, max-age=900');
    fs.createReadStream(entry.filePath).pipe(res);
});

// Trim a preview and save it to the sounds library. Admin/superadmin get direct
// save; user/guest goes into the existing pending-upload queue.
app.post('/api/stream-url/import', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    if (!getUrlStreamEnabled(role)) return res.status(403).json({ error: 'URL streaming is disabled for your role.' });
    const isAdminOrSuper = role === 'admin' || role === 'superadmin';
    const canDirectUpload = isAdminOrSuper;
    const canGuestPendingUpload = role === 'guest' && getGuestUploadEnabled();
    const canUserPendingUpload = role === 'user' && getUserUploadEnabled();
    const canPendingUpload = canGuestPendingUpload || canUserPendingUpload;
    if (!canDirectUpload && !canPendingUpload) return res.status(403).json({ error: 'Importing to the library is not allowed for your role.' });

    const body = req.body || {};
    const previewId = String(body.previewId || '').trim();
    const entry = urlPreviewCache.get(previewId);
    if (!entry || !fs.existsSync(entry.filePath)) return res.status(400).json({ error: 'Preview expired. Load the URL again.' });

    let trimStart = Number(body.trimStart);
    let trimEnd = Number(body.trimEnd);
    const dur = entry.duration || 0;
    if (!Number.isFinite(trimStart) || trimStart < 0) trimStart = 0;
    if (!Number.isFinite(trimEnd) || trimEnd <= trimStart) trimEnd = dur || (trimStart + 1);
    if (dur && trimEnd > dur) trimEnd = dur;
    const trimLen = Math.max(0, trimEnd - trimStart);
    if (trimLen < 0.25) return res.status(400).json({ error: 'Trim length must be at least 0.25s.' });

    // Enforce the user's upload-duration cap (same as /api/upload).
    const maxDur = role === 'guest' ? getGuestMaxUploadDuration() : (role === 'user' ? getUserMaxUploadDuration() : null);
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
    if (!getUrlStreamEnabled(role)) return res.status(403).json({ error: 'URL streaming is disabled for your role.' });
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
    if (role === 'guest') return res.status(403).json({ error: 'Guests cannot stream URLs.' });
    if (!getUrlStreamEnabled(role)) return res.status(403).json({ error: 'URL streaming is disabled for your role.' });
    if (!activeGuildId || !getVoiceConnection(activeGuildId)) return res.status(400).json({ error: 'Join a voice channel first.' });

    const body = req.body || {};
    const previewId = body.previewId ? String(body.previewId).trim() : '';
    const previewEntry = previewId ? urlPreviewCache.get(previewId) : null;
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

    const currentStatus = player.state.status;
    const isSomeonePlaying = currentStatus === AudioPlayerStatus.Playing || currentStatus === AudioPlayerStatus.Paused || currentStatus === AudioPlayerStatus.Buffering || currentStatus === AudioPlayerStatus.AutoPaused;
    const startedByRole = playbackState.startedBy?.role;
    if (isSomeonePlaying) {
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
    const effectiveDuration = previewEntry ? (trimEnd != null ? trimEnd - trimStart : duration) : duration;

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

    const maxDur = getUrlStreamMaxDurationSec(role);
    const checkDur = previewEntry ? effectiveDuration : duration;
    if (maxDur > 0 && checkDur != null && checkDur > maxDur) {
        return res.status(403).json({ error: `Length ${Math.ceil(checkDur)}s exceeds your ${maxDur}s cap.` });
    }

    const conn = getVoiceConnection(activeGuildId);
    if (conn && conn.state?.status !== 'ready') {
        try { await entersState(conn, VoiceConnectionStatus.Ready, 15_000); }
        catch { return res.status(503).json({ error: 'Voice connection failed to establish.' }); }
    }

    // Preempt — URL streams are always single-play.
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

    const crypto = require('crypto');
    const safeName = 'url:' + crypto.createHash('sha1').update(url + ':' + trimStart + ':' + (trimEnd || '')).digest('hex').slice(0, 10);
    const startedBy = { username: req.session.user.username, role };
    const plannedDurationMs = effectiveDuration != null ? Math.round(effectiveDuration * 1000) : null;
    const newPlayId = statsDb.recordPlayStart({
        filename: safeName, displayName: title,
        userId: req.session.user.username, userRole: role,
        guestIp: null, plannedDurationMs,
    });

    try {
        let ytdlp = null, ff;
        if (previewEntry) {
            // Stream from cached WAV through ffmpeg with trim.
            const ffArgs = ['-nostdin'];
            if (trimStart > 0) ffArgs.push('-ss', String(trimStart));
            ffArgs.push('-i', previewEntry.filePath);
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

        const killAfterMs = ((effectiveDuration != null ? effectiveDuration : maxDur) || 600) * 1000 + 10_000;
        const killTimer = setTimeout(() => {
            console.log('[url-stream] hard-killing stream after max duration');
            try { ff.kill('SIGKILL'); } catch {}
            try { ytdlp?.kill('SIGKILL'); } catch {}
        }, killAfterMs);

        activeUrlStream = { ytdlp, ff, killTimer };

        ff.on('close', () => {
            clearTimeout(killTimer);
            try { ytdlp?.kill('SIGTERM'); } catch {}
            if (activeUrlStream && activeUrlStream.ff === ff) activeUrlStream = null;
            if (currentSinglePlayId === newPlayId) {
                statsDb.recordPlayEnd(newPlayId, { stoppedEarly: false });
                currentSinglePlayId = null;
            }
        });

        const resource = createAudioResource(ff.stdout, {
            inputType: StreamType.Arbitrary, inlineVolume: true,
            metadata: { filename: safeName, displayName: title },
        });
        resource.volume.setVolume(currentVolume);
        player.play(resource);
        currentSinglePlayId = newPlayId;
        playbackState = {
            status: 'playing',
            filename: safeName,
            displayName: title,
            startTime: Date.now(),
            startTimeOffset: 0,
            duration: effectiveDuration,
            startedBy,
        };
        addToRecentlyPlayedServer(safeName, title, startedBy.username, Date.now());
        res.json({ ok: true, title, duration: effectiveDuration, url, trimStart, trimEnd });
    } catch (err) {
        console.error('[url-stream] fatal', err);
        res.status(500).json({ error: err.message || 'Failed to start stream' });
    }
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

app.post('/api/stop', requireAdmin, (req, res) => {
    const role = req.session.user.role;
    const startedBy = playbackState.startedBy;
    if (role === 'admin' && startedBy && startedBy.role === 'superadmin') {
        return res.status(403).json({ error: 'Only superadmin can stop superadmin playback.' });
    }
    player.stop();
    if (activeMixer) { activeMixer.destroy(); activeMixer = null; }
    activeTracks.clear();
    killActiveUrlStream();
    ttsQueue.length = 0;
    ttsIsPlaying = false;
    playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, startTimeOffset: null, duration: null, startedBy: null, pausedAt: null };
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
    try {
        const res = await fetch(`${TTS_API_URL}${urlPath}`, { ...opts, signal: controller.signal });
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
    const { text, voiceId, volume: reqVolume, exaggeration: reqExag } = req.body;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Text required' });
    if (!voiceId || typeof voiceId !== 'string') return res.status(400).json({ error: 'Voice ID required' });
    const ttsVolume = typeof reqVolume === 'number' ? Math.max(0, Math.min(2, reqVolume)) : 1;
    const exaggeration = typeof reqExag === 'number' ? Math.max(0.25, Math.min(2.0, reqExag)) : 0.5;

    // Check TTS availability
    if (!TTS_API_URL) return res.status(503).json({ error: 'TTS service not configured' });
    if (!getTtsEnabled()) return res.status(403).json({ error: 'TTS is disabled' });

    // Check if voice is disabled
    if (getTtsDisabledVoices().includes(voiceId)) return res.status(403).json({ error: 'This voice is currently disabled.' });

    const role = req.session.user.role;
    const isGuest = role === 'guest';

    // Check guest access
    if (isGuest) {
        if (!getGuestEnabled()) return res.status(403).json({ error: 'Guest access is disabled.' });
        const ip = getClientIP(req);
        if (isIPBlocked(ip)) return res.status(403).json({ error: 'Your IP has been blocked.' });
    }

    // Text length limit
    const maxLen = getTtsMaxTextLength(role);
    if (maxLen <= 0) return res.status(403).json({ error: 'TTS is not available for your role.' });
    const trimmed = text.trim();
    if (trimmed.length > maxLen) return res.status(400).json({ error: `Text too long. Maximum ${maxLen} characters for your role.` });
    if (!trimmed) return res.status(400).json({ error: 'Text is empty' });

    // TTS cooldown (separate from sound cooldown)
    const cooldownSec = getTtsCooldownSec(role);
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

    // Call TTS service (serialized — parallel generations on the same GPU garble).
    console.log('[TTS] queued for synthesis voice=%s text_len=%d pending=%d', voiceId, trimmed.length, ttsSynthPending);
    let ttsRes;
    try {
        ttsRes = await runTtsSynthSerially(() => {
            console.log('[TTS] synthesize voice=%s text_len=%d', voiceId, trimmed.length);
            return ttsFetch('/synthesize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: trimmed, voice_id: voiceId, use_rvc: getTtsVoiceRvcOverrides()[voiceId] ?? true, exaggeration }),
                timeout: 120000,
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

    let wavBuffer;
    try {
        const ab = await ttsRes.arrayBuffer();
        wavBuffer = Buffer.from(ab);
    } catch (e) {
        console.error('[TTS] buffer error:', e);
        return res.status(502).json({ error: 'Failed to read TTS audio' });
    }

    // Cache for legacy "save last TTS" feature
    ttsLastBuffer.set(req.session.user.username, { wavBuffer, text: trimmed, voiceId, timestamp: Date.now() });

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
    res.json({ ok: true, queued: true, queuePosition, displayName: ttsDisplayName, startedBy, multiPlay: multiPlayEnabled });
});

// --- TTS recents (per-user, max 5) ---

// List the current user's TTS recents (most recent first).
app.get('/api/tts/recents', requireAuth, (req, res) => {
    if (req.session.user.role === 'guest') return res.json([]);
    const rows = statsDb.listTtsRecents(req.session.user.username, TTS_RECENTS_PER_USER);
    res.json(rows.map(r => ({
        id: r.id,
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
    if (!row || row.owner !== req.session.user.username) return res.status(404).json({ error: 'Recent not found' });
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
    res.json({ ok: true, queued: true, queuePosition: ttsQueue.length, displayName: queueItem.displayName });
});

// Save a stored TTS recent as a permanent sound (WAV → MP3, adds tts metadata).
app.post('/api/tts/recents/:id/save-as-sound', requireAuth, async (req, res) => {
    const role = req.session.user.role;
    if (role === 'guest') return res.status(403).json({ error: 'Guests cannot save TTS clips.' });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = statsDb.getTtsRecent(id);
    if (!row || row.owner !== req.session.user.username) return res.status(404).json({ error: 'Recent not found' });
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
    res.json({ ok: true, filename: finalName, displayName: meta.displayName, duration });
});

// Remove a stored recent and its WAV file.
app.delete('/api/tts/recents/:id', requireAuth, (req, res) => {
    if (req.session.user.role === 'guest') return res.status(403).json({ error: 'Guests have no recents.' });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = statsDb.getTtsRecent(id);
    if (!row || row.owner !== req.session.user.username) return res.status(404).json({ error: 'Recent not found' });
    try {
        const p = path.join(TTS_RECENTS_DIR, path.basename(row.wav_path));
        if (p.startsWith(TTS_RECENTS_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { console.warn('[TTS Recents] unlink failed:', e.message); }
    statsDb.deleteTtsRecent(row.id);
    res.json({ ok: true });
});

app.post('/api/tts/queue/clear', requireAdmin, (req, res) => {
    ttsQueue.length = 0;
    console.log('[TTS Queue] cleared by %s', req.session.user.username);
    res.json({ ok: true });
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

app.post('/api/superadmin/tts/source/youtube', requireSuperadmin, async (req, res) => {
    const { url, startSec, endSec } = req.body || {};
    if (!ttsVoiceAdmin.validateYouTubeUrl(url)) return res.status(400).json({ error: 'Provide a youtube.com or youtu.be URL.' });
    try {
        const { sourcePath, cached } = await ttsVoiceAdmin.fetchYouTubeSource(url);
        const sourceDuration = await ttsVoiceAdmin.probeDuration(sourcePath);
        const { token, duration } = await ttsVoiceAdmin.extractClip(sourcePath, startSec, endSec);
        res.json({ token, duration, sourceDuration, sourceCached: cached, previewUrl: `/api/superadmin/tts/preview/${token}` });
    } catch (err) {
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
        // Keep the uploaded source around so retrim works without re-uploading.
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

// --- Superadmin: voice training jobs ---

app.get('/api/superadmin/tts/train', requireSuperadmin, (req, res) => {
    try {
        const jobs = voiceTrainer.listJobs().sort((a, b) => b.started_at - a.started_at).slice(0, 50);
        res.json({ jobs });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/superadmin/tts/train', requireSuperadmin, (req, res) => {
    try {
        const job = voiceTrainer.startJob(req.body || {});
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
        res.json({ meta, events, next_since: lines });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/superadmin/tts/train/:id/cancel', requireSuperadmin, (req, res) => {
    try {
        const meta = voiceTrainer.cancelJob(req.params.id);
        res.json({ ok: true, meta });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

const token = (process.env.DISCORD_TOKEN || '').trim();
if (!token || token === 'your_bot_token_here') {
    console.error('DISCORD_TOKEN is missing or still the placeholder. Set it in .env from Discord Developer Portal → Your App → Bot → Token');
    process.exit(1);
}
client.login(token);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Web UI running at http://localhost:${PORT}`);
});
}

sodium.ready.then(() => {
    console.log('🔐 Voice encryption ready');
    startApp();
}).catch(err => {
    console.error('Failed to initialize voice encryption (libsodium-wrappers):', err);
    process.exit(1);
});
