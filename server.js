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
const SOUNDS_META_PATH = path.join(SOUNDS_DIR, 'sounds.json');

function loadSoundsMeta() {
    try {
        const raw = fs.readFileSync(SOUNDS_META_PATH, 'utf8');
        const data = JSON.parse(raw);
        return typeof data === 'object' && data !== null ? data : {};
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
    if (updates.folder !== undefined) next.folder = updates.folder === null || updates.folder === '' ? null : String(updates.folder);
    meta[filename] = next;
    saveSoundsMeta(meta);
}

function getFolder(meta, filename) {
    const m = meta[filename];
    if (m && typeof m === 'object' && m.folder != null) return m.folder;
    return null;
}

function getFolders(meta) {
    const list = meta._folders;
    return Array.isArray(list) ? list.filter(f => typeof f === 'string' && f.trim() !== '') : [];
}

function setFolders(folders) {
    const meta = loadSoundsMeta();
    meta._folders = Array.isArray(folders) ? folders.filter(f => typeof f === 'string' && f.trim() !== '') : [];
    saveSoundsMeta(meta);
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

const app = express();
const upload = multer({ dest: 'sounds/' });
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

function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'superadmin') return res.status(403).json({ error: 'Admin or superadmin only' });
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

app.get('/api/me', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    res.json(req.session.user);
});

app.get('/api/channels', requireAdmin, (req, res) => {
    const channels = [];
    client.guilds.cache.forEach(guild => {
        guild.channels.cache.filter(c => c.isVoiceBased()).forEach(channel => {
            channels.push({ id: channel.id, name: `${guild.name} - ${channel.name}` });
        });
    });
    res.json(channels);
});

let activeGuildId = null; // Track the server ID

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
            folder: getFolder(meta, filename),
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
    const { filename, displayName, folder } = req.body;
    const safeFilename = filename && path.basename(filename);
    if (!safeFilename) return res.status(400).send('Filename required');
    const filePath = path.join(SOUNDS_DIR, safeFilename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    const updates = {};
    if (displayName !== undefined) updates.displayName = displayName != null ? String(displayName) : undefined;
    if (folder !== undefined) updates.folder = folder === null || folder === '' ? null : String(folder);
    setSoundMeta(safeFilename, updates);
    const meta = loadSoundsMeta();
    res.json({ filename: safeFilename, displayName: getDisplayName(meta, safeFilename), duration: getDuration(meta, safeFilename), folder: getFolder(meta, safeFilename) });
});

app.get('/api/folders', requireAuth, (req, res) => {
    const meta = loadSoundsMeta();
    res.json(getFolders(meta));
});

app.patch('/api/folders', requireAdmin, (req, res) => {
    const { folders } = req.body;
    if (!Array.isArray(folders)) return res.status(400).json({ error: 'folders must be an array' });
    const safe = folders.filter(f => typeof f === 'string' && f.trim() !== '').map(f => f.trim());
    setFolders(safe);
    res.json(safe);
});

app.patch('/api/folders/rename', requireAdmin, (req, res) => {
    const { oldName, newName } = req.body;
    const oldN = typeof oldName === 'string' ? oldName.trim() : '';
    const newN = typeof newName === 'string' ? newName.trim() : '';
    if (!oldN || !newN) return res.status(400).json({ error: 'oldName and newName required' });
    if (oldN === newN) return res.json({ ok: true });
    const meta = loadSoundsMeta();
    const folders = getFolders(meta);
    if (!folders.includes(oldN)) return res.status(404).json({ error: 'Folder not found' });
    if (folders.includes(newN)) return res.status(400).json({ error: 'Target folder name already exists' });
    meta._folders = folders.map(f => f === oldN ? newN : f);
    Object.keys(meta).forEach(key => {
        if (key.startsWith('_')) return;
        const m = meta[key];
        if (m && typeof m === 'object' && m.folder === oldN) m.folder = newN;
    });
    saveSoundsMeta(meta);
    res.json({ ok: true, folders: meta._folders });
});

app.delete('/api/folders/:name', requireAdmin, (req, res) => {
    const name = decodeURIComponent(req.params.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Folder name required' });
    const meta = loadSoundsMeta();
    const folders = getFolders(meta);
    if (!folders.includes(name)) return res.status(404).json({ error: 'Folder not found' });
    Object.keys(meta).forEach(key => {
        if (key.startsWith('_')) return;
        const m = meta[key];
        if (m && typeof m === 'object' && m.folder === name) m.folder = null;
    });
    meta._folders = folders.filter(f => f !== name);
    saveSoundsMeta(meta);
    res.json({ ok: true });
});

app.get('/api/settings', requireAuth, (req, res) => {
    const meta = loadSoundsMeta();
    res.json({ playbackLocked: getPlaybackLocked(meta), playbackLockedBy: getPlaybackLocked(meta) ? getPlaybackLockedBy(meta) : null });
});

app.patch('/api/settings', requireAdmin, (req, res) => {
    const { playbackLocked } = req.body;
    if (typeof playbackLocked !== 'boolean') return res.status(400).json({ error: 'playbackLocked must be boolean' });
    const byRole = req.session.user.role === 'superadmin' ? 'superadmin' : 'admin';
    setPlaybackLocked(playbackLocked, byRole);
    res.json({ playbackLocked });
});

app.post('/api/upload', requireAdmin, upload.single('soundFile'), (req, res) => {
    const tempPath = req.file.path;
    const safeName = path.basename(req.file.originalname || 'sound');
    const targetPath = path.join(SOUNDS_DIR, safeName);
    const resolvedPath = path.resolve(targetPath);
    if (!resolvedPath.startsWith(path.resolve(SOUNDS_DIR))) return res.status(403).send('Invalid filename');
    fs.rename(tempPath, targetPath, err => {
        if (err) return res.status(500).send('Error saving file');
        const duration = probeDuration(targetPath);
        if (duration != null) setSoundMeta(safeName, { duration });
        res.send('File uploaded!');
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

    if (req.session.user.role === 'user' && duration != null && duration > MAX_USER_SOUND_DURATION) {
        return res.status(403).json({ error: `Only sounds ${MAX_USER_SOUND_DURATION} seconds or shorter are allowed for your role. This sound is ${Math.ceil(duration)}s.` });
    }

    if (getPlaybackLocked(meta)) {
        const lockedBy = getPlaybackLockedBy(meta);
        const role = req.session.user.role;
        if (lockedBy === 'superadmin') {
            return res.status(403).json({ error: 'Playback is locked by superadmin.' });
        }
        if (role === 'user') {
            return res.status(403).json({ error: 'Playback is locked by an admin.' });
        }
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
        playbackState = {
            status: 'playing',
            filename: safeFilename,
            displayName,
            startTime: Date.now(),
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
    playbackState = { status: 'idle', filename: null, displayName: null, startTime: null, duration: null, startedBy: null };
    res.json({ ok: true });
});

app.post('/api/pause', requireAdmin, (req, res) => {
    const role = req.session.user.role;
    const startedBy = playbackState.startedBy;
    if (role === 'superadmin') { /* ok */ } else if (role === 'admin' && startedBy && startedBy.role !== 'user') {
        return res.status(403).json({ error: 'Only superadmin can pause admin playback.' });
    }
    player.pause(true);
    res.json({ ok: true });
});

app.post('/api/resume', requireAdmin, (req, res) => {
    const role = req.session.user.role;
    const startedBy = playbackState.startedBy;
    if (role === 'superadmin') { /* ok */ } else if (role === 'admin' && startedBy && startedBy.role !== 'user') {
        return res.status(403).json({ error: 'Only superadmin can resume admin playback.' });
    }
    player.unpause();
    res.json({ ok: true });
});

app.post('/api/volume', requireAdmin, (req, res) => {
    const { volume } = req.body;
    const v = parseFloat(volume);
    if (Number.isFinite(v)) currentVolume = Math.max(0, Math.min(1, v));
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
