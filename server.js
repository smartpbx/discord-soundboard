require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Discord voice requires an encryption lib to be ready *before* the first connection.
// Load it first so @discordjs/voice can use it.
const sodium = require('libsodium-wrappers');

function startApp() {
const express = require('express');
const multer = require('multer');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, getVoiceConnection, StreamType } = require('@discordjs/voice');

const SOUNDS_DIR = path.join(__dirname, 'sounds');
if (!fs.existsSync(SOUNDS_DIR)) {
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    console.log('📁 Created sounds directory');
}

const app = express();
const upload = multer({ dest: 'sounds/' });
app.use(express.static('public'));
app.use(express.json());

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] 
});
const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

let currentConnection = null;
let currentVolume = 0.5;

client.once('ready', () => {
    console.log(`🤖 Bot logged in as ${client.user.tag}`);
});

app.get('/api/channels', (req, res) => {
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

app.post('/api/join', (req, res) => {
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

app.post('/api/leave', (req, res) => {
    if (leaveVoiceChannel()) {
        res.send('Left channel');
    } else {
        res.send('Not in a channel');
    }
});

app.get('/api/sounds', (req, res) => {
    fs.readdir(SOUNDS_DIR, (err, files) => {
        if (err) return res.status(500).send('Error reading sounds directory');
        const audioFiles = (files || []).filter(f => f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.ogg'));
        res.json(audioFiles);
    });
});

app.post('/api/upload', upload.single('soundFile'), (req, res) => {
    const tempPath = req.file.path;
    const safeName = path.basename(req.file.originalname || 'sound');
    const targetPath = path.join(SOUNDS_DIR, safeName);
    const resolvedPath = path.resolve(targetPath);
    if (!resolvedPath.startsWith(path.resolve(SOUNDS_DIR))) return res.status(403).send('Invalid filename');
    fs.rename(tempPath, targetPath, err => {
        if (err) return res.status(500).send('Error saving file');
        res.send('File uploaded!');
    });
});

app.post('/api/play', (req, res) => {
    const { filename } = req.body;
    if (!filename || typeof filename !== 'string') return res.status(400).send('Filename required');

    // Prevent path traversal - only allow basename
    const safeFilename = path.basename(filename);
    const filePath = path.join(SOUNDS_DIR, safeFilename);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(SOUNDS_DIR))) return res.status(403).send('Invalid path');
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

    if (!activeGuildId || !getVoiceConnection(activeGuildId)) {
        return res.status(400).send('Join a voice channel first');
    }

    try {
        const stream = fs.createReadStream(filePath);
        const resource = createAudioResource(stream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
        });
        resource.volume.setVolume(currentVolume);
        player.play(resource);
        res.send(`Playing ${safeFilename}`);
    } catch (err) {
        console.error('Play error:', err);
        res.status(500).send('Failed to play audio');
    }
});

app.post('/api/volume', (req, res) => {
    const { volume } = req.body;
    currentVolume = parseFloat(volume);
    res.send(`Volume set to ${currentVolume}`);
});

client.login(process.env.DISCORD_TOKEN);
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
