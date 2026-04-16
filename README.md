# Discord Soundboard

Self-hosted Discord soundboard with a web UI, multi-user roles, and a separate GPU-backed TTS service. Designed to run as two LXC containers under Proxmox: one for the Node.js app, one for the GPU TTS server.

## What it does

- **Soundboard** — upload audio, organize with tags, drag-and-drop reorder, trim, normalize, set per-user volume, play into a Discord voice channel.
- **Multi-role auth** — `superadmin` / `admin` / `user` / `guest`. Roles control upload, playback, moderation, and override behavior.
- **Guest access** — public link with IP-based rate limits, blocklist, per-IP cooldown overrides, moderation queue.
- **Live web UI** — waveform display, real-time scrub, pause/resume, recently-played, favorites (1–9 hotkeys), keyboard shortcuts.
- **Stats** — play-count heatmap on the sound grid, activity heatmap calendar, full audit log of plays and admin actions.
- **Text-to-Speech** — four engines on the GPU container (Kokoro, Chatterbox, RVC, GPT-SoVITS); generic and celebrity-cloned voices; save TTS clips as permanent sounds.
- **Voice management UI** — superadmins can add/replace/delete Chatterbox voices from the web by pasting a YouTube URL or uploading audio (yt-dlp + ffmpeg pipeline, preview before commit, source URL/timestamps stored).

See `FEATURES.md` for the full roadmap and `proxmox/README.md` for the LXC install path.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Discord                                    │
│  └─ voice channel ◄───── Opus stream ──────┐│
└──────────────────────────────────┬──────────┘│
                                   │           │
┌──────────────────────────────────┴───────────┴──┐
│  CT 109 (or local) — Node.js soundboard         │
│  • Express + discord.js                         │
│  • SQLite for stats (lib/stats-db.js)           │
│  • JSON-on-disk for settings (data/*.json)      │
│  • Proxies TTS via HTTP to CT 110               │
│  • yt-dlp + ffmpeg for voice admin uploads      │
└──────────────────────────────────┬──────────────┘
                                   │ HTTP (TTS_API_URL)
                                   ▼
┌─────────────────────────────────────────────────┐
│  CT 110 — FastAPI TTS server (RTX 3090)         │
│  • Kokoro (built-in voices)                     │
│  • Chatterbox (zero-shot voice clone from ref)  │
│  • RVC (post-process voice conversion)          │
│  • GPT-SoVITS (separate process on :9880)       │
│  • Models: tts-server/models/{kokoro,chatterbox,│
│            rvc,gptsovits}/                      │
└─────────────────────────────────────────────────┘
```

## Quick start (local)

```bash
git clone https://github.com/smartpbx/discord-soundboard.git
cd discord-soundboard
npm install
cp .env.example .env  # then edit DISCORD_TOKEN, USERS, etc.
node server.js
```

For Proxmox LXC install (recommended for production), see `proxmox/README.md`.

## Environment variables

Set in `.env`:

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Bot token from the Discord Developer Portal |
| `PORT` | Port for the web UI (default 3000) |
| `SESSION_SECRET` | Random hex string for session cookies |
| `USERS` | Comma-separated `username:password:role` (e.g. `clayton:hunter2:superadmin,bob:pw:user`) |
| `ADMIN_PASSWORD` / `USER_PASSWORD` / `SUPERADMIN_PASSWORD` | Optional shortcuts for `admin`/`user`/`superadmin` users |
| `TTS_API_URL` | Base URL of the TTS server (e.g. `http://10.10.10.72:8880`); leave unset to disable TTS |
| `TTS_ADMIN_TOKEN` | Shared secret for the voice admin endpoints; **must match the value on the TTS server** |
| `YT_DLP_BIN` / `FFMPEG_BIN` | Optional paths if not on `$PATH` |

The TTS server also reads `TTS_ADMIN_TOKEN` from its own `.env`.

## TTS voice management

From the web UI: **Superadmin → TTS Voices → + Add Chatterbox voice** (or **Replace** on an existing row).

The modal accepts either a YouTube URL with start/end seconds or a direct audio upload. The soundboard server downloads via `yt-dlp`, trims and loudnorm-normalizes via `ffmpeg`, generates a 24kHz mono WAV, lets you preview it in-browser, then uploads it to the TTS server's `PUT /voices/chatterbox/{id}` endpoint. The original source URL/filename and timestamps are persisted in `metadata.json` and shown under each voice's name.

Reference clips live at `tts-server/models/chatterbox/<voice_id>/reference.wav`. For RVC refinement, an `rvc_<voice_id>` model must exist in `tts-server/models/rvc/manifest.json` — the UI's RVC toggle silently falls back to Chatterbox-only output if the model isn't there.

## Deploy

Production lives on Proxmox at `vm.mannerow.net`:
- CT 109 — soundboard (`pct exec 109 -- update`)
- CT 110 — TTS server (`pct exec 110 -- bash -c 'cd /opt/discord-soundboard && git pull && systemctl restart tts-server'`)

Both pull from `main`. The soundboard's `scripts/update.sh` handles `git pull`, `npm install`, `pip install --upgrade yt-dlp`, and a service restart.

## Repo layout

```
server.js                    Main Express + Discord bot
lib/
  stats-db.js                SQLite for play tracking
  tts-voice-admin.js         yt-dlp/ffmpeg pipeline for voice admin
public/
  index.html                 Single-file SPA (HTML + CSS + JS)
tts-server/
  main.py                    FastAPI app
  engines/
    kokoro_engine.py
    chatterbox_engine.py
    rvc_engine.py
    gptsovits_engine.py
  models/                    Voice reference clips and weights (gitignored)
  requirements.txt
sounds/                      Uploaded sound files (gitignored)
data/                        Settings, users, stats DB (gitignored)
proxmox/
  install/                   Container install scripts
scripts/
  update.sh                  In-container update script
  backup.sh / restore.sh
companion/                   Optional companion utilities
```

## Documentation

- `FEATURES.md` — feature roadmap with done/planned status
- `DIAGNOSTICS.md` — operational notes
- `proxmox/README.md` — LXC install instructions
- `companion/README.md` — companion app

## License

Private project. No license declared.
