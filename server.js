require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Discord voice requires an encryption lib to be ready *before* the first connection.
// Load it first so @discordjs/voice can use it.
const sodium = require('libsodium-wrappers');

function startApp() {
const express = require('express');
const multer = require('multer');
const { execSync, spawn } = require('child_process');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, getVoiceConnection, StreamType, AudioPlayerStatus } = require('@discordjs/voice');

const SOUNDS_DIR = path.join(__dirname, 'sounds');
const PENDING_DIR = path.join(SOUNDS_DIR, 'pending');
const SOUNDS_META_PATH = path.join(SOUNDS_DIR, 'sounds.json');
const DATA_DIR = path.join(__dirname, 'data');
const GUEST_DATA_PATH = path.join(DATA_DIR, 'guest.json');
const PENDING_META_PATH = path.join(DATA_DIR, 'pending.json');
const SERVER_STATE_PATH = path.join(DATA_DIR, 'state.json');

const GUEST_COOLDOWN_SEC = 10;
const MAX_GUEST_SOUND_DURATION = 7;
const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2MB

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

function getMaxUploadDuration() {
    const d = loadGuestData();
    const n = Number(d.maxUploadDuration);
    return Number.isFinite(n) && n > 0 ? n : 7;
}

function setMaxUploadDuration(sec) {
    const d = loadGuestData();
    d.maxUploadDuration = Number(sec) > 0 ? Number(sec) : 7;
    saveGuestData(d);
}

function getMaxUploadBytes() {
    const d = loadGuestData();
    const n = Number(d.maxUploadBytes);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UPLOAD_BYTES;
}

function setMaxUploadBytes(bytes) {
    const d = loadGuestData();
    d.maxUploadBytes = Number(bytes) > 0 ? Number(bytes) : DEFAULT_MAX_UPLOAD_BYTES;
    saveGuestData(d);
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
    if (updates.folder !== undefined) {
        const f = updates.folder === null || updates.folder === '' ? null : String(updates.folder);
        next.folder = f;
        next.tags = f ? [f] : [];
    }
    meta[filename] = next;
    saveSoundsMeta(meta);
}

function getTags(meta, filename) {
    const m = meta[filename];
    if (m && typeof m === 'object' && Array.isArray(m.tags)) return m.tags.filter(t => typeof t === 'string' && t.trim() !== '');
    if (m && typeof m === 'object' && m.folder != null) return [String(m.folder)];
    return [];
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

function probeDuration(filePath) {
    try {
        const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 5000 });
        const d = parseFloat(out.trim());
        return Number.isFinite(d) && d > 0 ? d : null;
    } catch {
        return null;
    }
}
if (!fs.existsSync(SOUNDS_DIR)) {
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    console.log('📁 Created sounds directory');
}
if (!fs.existsSync(PENDING_DIR)) {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
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

const MAX_USER_SOUND_DURATION = 7;

// Parse users from env: USERS=username:password:role,username:password:role,...
// Roles: superadmin (stop everyone), admin (stop users only), user
// Fallback: ADMIN_PASSWORD, USER_PASSWORD, SUPERADMIN_PASSWORD for single-user per role
function loadUsers() {
    const users = new Map(); // username -> { username, password, role }
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
    // Fallback: legacy single-user vars
    const adminPw = (process.env.ADMIN_PASSWORD || '').trim();
    const userPw = (process.env.USER_PASSWORD || '').trim();
    const superPw = (process.env.SUPERADMIN_PASSWORD || '').trim();
    if (adminPw && !users.has('admin')) users.set('admin', { username: 'admin', password: adminPw, role: 'admin' });
    if (userPw && !users.has('user')) users.set('user', { username: 'user', password: userPw, role: 'user' });
    if (superPw && !users.has('superadmin')) users.set('superadmin', { username: 'superadmin', password: superPw, role: 'superadmin' });
    return users;
}
const USERS = loadUsers();
const guestLastPlayByIP = new Map();

function requireAuth(req, res, next) {
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
    if (entry && entry.password === p) return { username: entry.username, role: entry.role };
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
                daveEncryption: false,
            });
            currentConnection.on('error', err => {
                console.error('Voice connection error:', err.message);
                leaveVoiceChannel();
            });
            currentConnection.subscribe(player);
            console.log(`🔊 Auto-joined ${channel.name}`);
        }
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = checkCredentials(String(username || ''), String(password || ''));
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    req.session.user = user;
    req.session.save((err) => {
        if (err) return res.status(500).json({ error: 'Session error' });
        res.json(user);
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
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
    const u = { ...req.session.user };
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
    res.json({ channels, lastChannelId: lastChannelId || null });
});

let activeGuildId = null; // Track the server ID
let lastChannelId = null; // Persisted for auto-join on restart

(function initServerState() {
    const state = loadServerState();
    if (Number.isFinite(state.volume)) currentVolume = Math.max(0, Math.min(1, state.volume));
    if (typeof state.lastChannelId === 'string' && state.lastChannelId) lastChannelId = state.lastChannelId;
})();

// Catch and log audio errors so the bot doesn't crash silently
player.on('error', error => {
    const meta = error.resource?.metadata ?? 'unknown';
    console.error(`❌ Audio Player Error: ${error.message} (resource: ${meta})`);
    playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, duration: null, startedBy: null };
});

player.on('stateChange', (oldState, newState) => {
    if (newState.status === AudioPlayerStatus.Idle) {
        playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, duration: null, startedBy: null };
    }
});

function leaveVoiceChannel() {
    if (activeGuildId) {
        player.stop();
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
        // Use classic voice encryption; DAVE (end-to-end) requires @snazzah/davey
        daveEncryption: false,
    });
    currentConnection.on('error', err => {
        console.error('Voice connection error:', err.message);
        leaveVoiceChannel();
    });
    currentConnection.subscribe(player);
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
        }));
        res.json(list);
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
    res.setHeader('Content-Type', mime);
    fs.createReadStream(filePath).pipe(res);
});

app.patch('/api/sounds/metadata', requireAdmin, (req, res) => {
    const { filename, displayName, tags } = req.body;
    const safeFilename = filename && path.basename(filename);
    if (!safeFilename) return res.status(400).send('Filename required');
    const filePath = path.join(SOUNDS_DIR, safeFilename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    const updates = {};
    if (displayName !== undefined) updates.displayName = displayName != null ? String(displayName) : undefined;
    if (tags !== undefined) updates.tags = Array.isArray(tags) ? tags : (tags ? [tags] : []);
    setSoundMeta(safeFilename, updates);
    const meta = loadSoundsMeta();
    res.json({ filename: safeFilename, displayName: getDisplayName(meta, safeFilename), duration: getDuration(meta, safeFilename), tags: getTags(meta, safeFilename) });
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
    if (req.session.user.role === 'admin' || req.session.user.role === 'superadmin') {
        out.volume = currentVolume;
    }
    if (req.session.user.role === 'superadmin') {
        out.guestEnabled = getGuestEnabled();
        out.userUploadEnabled = getUserUploadEnabled();
        out.maxUploadDuration = getMaxUploadDuration();
        out.maxUploadBytes = getMaxUploadBytes();
        const pending = (loadPendingMeta().uploads || []).filter(u => fs.existsSync(path.join(PENDING_DIR, u.filename)));
        out.pendingCount = pending.length;
    }
    if (req.session.user.role === 'user' || req.session.user.role === 'guest') {
        out.userUploadEnabled = getUserUploadEnabled();
        if (getUserUploadEnabled()) {
            out.maxUploadDuration = getMaxUploadDuration();
            out.maxUploadBytes = getMaxUploadBytes();
        }
    }
    res.json(out);
});

app.patch('/api/settings', requireAdmin, (req, res) => {
    const { playbackLocked, guestEnabled, userUploadEnabled, maxUploadDuration, maxUploadBytes } = req.body;
    const out = {};
    if (typeof playbackLocked === 'boolean') {
        const byRole = req.session.user.role === 'superadmin' ? 'superadmin' : 'admin';
        setPlaybackLocked(playbackLocked, byRole);
        out.playbackLocked = playbackLocked;
    }
    if (req.session.user.role === 'superadmin') {
        if (typeof guestEnabled === 'boolean') { setGuestEnabled(guestEnabled); out.guestEnabled = guestEnabled; }
        if (typeof userUploadEnabled === 'boolean') { setUserUploadEnabled(userUploadEnabled); out.userUploadEnabled = userUploadEnabled; }
        if (typeof maxUploadDuration === 'number' && maxUploadDuration > 0) { setMaxUploadDuration(maxUploadDuration); out.maxUploadDuration = maxUploadDuration; }
        if (typeof maxUploadBytes === 'number' && maxUploadBytes > 0) { setMaxUploadBytes(maxUploadBytes); out.maxUploadBytes = maxUploadBytes; }
    }
    res.json(Object.keys(out).length ? out : { ok: true });
});

app.get('/api/superadmin/pending-count', requireSuperadmin, (req, res) => {
    const d = loadPendingMeta();
    const uploads = (d.uploads || []).filter(u => fs.existsSync(path.join(PENDING_DIR, u.filename)));
    res.json({ count: uploads.length });
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
    const targetPath = path.join(SOUNDS_DIR, safeFilename);
    if (!fs.existsSync(pendingPath)) return res.status(404).json({ error: 'Pending file not found' });
    if (fs.existsSync(targetPath)) {
        fs.unlinkSync(pendingPath);
        removePendingUpload(safeFilename);
        return res.status(400).json({ error: 'A sound with this name already exists' });
    }
    try {
        fs.renameSync(pendingPath, targetPath);
        const duration = probeDuration(targetPath);
        if (duration != null) setSoundMeta(safeFilename, { duration });
        removePendingUpload(safeFilename);
        res.json({ ok: true, filename: safeFilename });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to approve' });
    }
});

app.delete('/api/superadmin/pending-uploads/reject/:filename', requireSuperadmin, (req, res) => {
    const safeFilename = path.basename(req.params.filename || '');
    if (!safeFilename || !/\.(mp3|wav|ogg)$/i.test(safeFilename)) return res.status(400).json({ error: 'Invalid filename' });
    const pendingPath = path.join(PENDING_DIR, safeFilename);
    try {
        if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
        removePendingUpload(safeFilename);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to reject' });
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
    res.json({ ok: true, blocked: s });
});

app.delete('/api/guest/block-ip/:ip', requireSuperadmin, (req, res) => {
    const ip = decodeURIComponent(req.params.ip || '').trim();
    if (!ip) return res.status(400).json({ error: 'IP required' });
    unblockIP(ip);
    res.json({ ok: true });
});

function uploadHandler(req, res, next) {
    const role = req.session?.user?.role;
    const isAdminOrSuper = role === 'admin' || role === 'superadmin';
    const canDirectUpload = isAdminOrSuper;
    const canPendingUpload = (role === 'user' || role === 'guest') && getUserUploadEnabled();
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

    if (mode === 'direct') {
        const targetPath = path.join(SOUNDS_DIR, safeName);
        const resolvedPath = path.resolve(targetPath);
        if (!resolvedPath.startsWith(path.resolve(SOUNDS_DIR))) return res.status(403).json({ error: 'Invalid filename' });
        fs.rename(tempPath, targetPath, (err) => {
            if (err) return res.status(500).json({ error: 'Error saving file' });
            const duration = probeDuration(targetPath);
            if (duration != null) setSoundMeta(safeName, { duration });
            res.json({ ok: true, message: 'File uploaded!', pending: false });
        });
        return;
    }

    let targetPath = path.join(PENDING_DIR, safeName);
    if (fs.existsSync(targetPath)) {
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        safeName = `${base}_${Date.now()}${ext}`;
        targetPath = path.join(PENDING_DIR, safeName);
    }
    const resolvedPath = path.resolve(targetPath);
    if (!resolvedPath.startsWith(path.resolve(PENDING_DIR))) return res.status(403).json({ error: 'Invalid filename' });

    const stat = fs.statSync(tempPath);
    const size = stat.size;
    const maxBytes = getMaxUploadBytes();
    if (size > maxBytes) {
        fs.unlink(tempPath, () => {});
        return res.status(400).json({ error: `File too large. Max ${Math.round(maxBytes / 1024)}KB.` });
    }

    fs.rename(tempPath, targetPath, (err) => {
        if (err) return res.status(500).json({ error: 'Error saving file' });
        const duration = probeDuration(targetPath);
        const maxDur = getMaxUploadDuration();
        if (duration != null && duration > maxDur) {
            fs.unlinkSync(targetPath);
            return res.status(400).json({ error: `File too long. Max ${maxDur} seconds. This file is ${Math.ceil(duration)}s.` });
        }
        addPendingUpload(safeName, {
            uploadedBy,
            uploadedByRole,
            uploadedByIP,
            uploadedAt: Date.now(),
            duration: duration ?? null,
            size,
            originalName: origName,
        });
        res.json({ ok: true, message: 'Upload sent for moderation. A superadmin will review it.', pending: true });
    });
});

app.post('/api/play', requireAuth, (req, res) => {
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
        duration = probeDuration(filePath);
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
        if (lastPlay != null) {
            const elapsed = (Date.now() - lastPlay) / 1000;
            if (elapsed < GUEST_COOLDOWN_SEC) {
                return res.status(429).json({ error: `Wait ${Math.ceil(GUEST_COOLDOWN_SEC - elapsed)} seconds before playing again.`, cooldownRemaining: Math.ceil(GUEST_COOLDOWN_SEC - elapsed) });
            }
        }
    }

    if ((role === 'user' || isGuest) && duration != null && duration > MAX_USER_SOUND_DURATION) {
        return res.status(403).json({ error: `Only sounds ${MAX_USER_SOUND_DURATION} seconds or shorter are allowed. This sound is ${Math.ceil(duration)}s.` });
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
    if (isSomeonePlaying && (startedByRole === 'admin' || startedByRole === 'superadmin') && (role === 'user' || isGuest)) {
        return res.status(403).json({ error: 'An admin or superadmin is playing. You cannot override their playback.' });
    }

    const startTime = typeof req.body.startTime === 'number' && req.body.startTime >= 0 ? req.body.startTime : 0;

    try {
        let stream;
        if (startTime > 0) {
            const ff = spawn('ffmpeg', ['-nostdin', '-ss', String(startTime), '-i', filePath, '-f', 'mp3', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
            stream = ff.stdout;
            let errBuf = '';
            ff.stderr.on('data', (chunk) => { errBuf += chunk.toString(); });
            ff.on('error', (err) => { console.error('ffmpeg spawn error', err); });
            ff.on('close', (code) => { if (code !== 0 && code !== null) console.error('ffmpeg exit', code, errBuf.slice(-500)); });
        } else {
            stream = fs.createReadStream(filePath);
        }
        const resource = createAudioResource(stream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
            metadata: { filename: safeFilename, displayName },
        });
        resource.volume.setVolume(currentVolume);
        player.play(resource);
        const startedBy = { username: req.session.user.username, role: req.session.user.role };
        if (isGuest) {
            guestLastPlayByIP.set(getClientIP(req), Date.now());
            appendGuestHistory(getClientIP(req), safeFilename, displayName);
        }
        playbackState = {
            status: 'playing',
            filename: safeFilename,
            displayName,
            startTime: Date.now(),
            startTimeOffset: startTime,
            duration,
            startedBy,
        };
        res.json({ ok: true, duration, displayName, startTimeOffset: startTime, startedBy });
    } catch (err) {
        console.error('Play error:', err);
        res.status(500).json({ error: err.message || 'Failed to play audio' });
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
        const elapsed = (Date.now() - (playbackState.startTime || Date.now())) / 1000;
        state.currentTime = Math.max(0, Math.min((state.duration || 999999), offset + elapsed));
    } else if (status === 'paused' && playbackState.pausedAt != null) {
        state.currentTime = playbackState.pausedAt;
    }
    res.json(state);
});

app.post('/api/stop', requireAdmin, (req, res) => {
    const role = req.session.user.role;
    const startedBy = playbackState.startedBy;
    if (role === 'superadmin') {
        // Superadmin can stop everyone
    } else if (role === 'admin' && startedBy && startedBy.role !== 'user') {
        return res.status(403).json({ error: 'Only superadmin can stop admin playback.' });
    }
    player.stop();
    playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, startTimeOffset: null, duration: null, startedBy: null, pausedAt: null };
    res.json({ ok: true });
});

app.post('/api/pause', requireAdmin, (req, res) => {
    const role = req.session.user.role;
    const startedBy = playbackState.startedBy;
    if (role === 'superadmin') { /* ok */ } else if (role === 'admin' && startedBy && startedBy.role !== 'user') {
        return res.status(403).json({ error: 'Only superadmin can pause admin playback.' });
    }
    const offset = playbackState.startTimeOffset || 0;
    const elapsed = (Date.now() - (playbackState.startTime || Date.now())) / 1000;
    playbackState.pausedAt = Math.max(0, Math.min((playbackState.duration || 999999), offset + elapsed));
    player.pause(true);
    res.json({ ok: true });
});

app.post('/api/resume', requireAdmin, (req, res) => {
    const role = req.session.user.role;
    const startedBy = playbackState.startedBy;
    if (role === 'superadmin') { /* ok */ } else if (role === 'admin' && startedBy && startedBy.role !== 'user') {
        return res.status(403).json({ error: 'Only superadmin can resume admin playback.' });
    }
    const fromPaused = playbackState.pausedAt ?? 0;
    playbackState.startTime = Date.now();
    playbackState.startTimeOffset = fromPaused;
    playbackState.pausedAt = undefined;
    player.unpause();
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
