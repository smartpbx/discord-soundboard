# Discord Soundboard

Self-hosted Discord soundboard with a web UI, multi-user roles, real activity stats, optional public guest access, and a separate GPU-backed text-to-speech service. Designed to run as two LXC containers under Proxmox (one Node.js app, one GPU TTS server) but also runs fine on a single host or via Docker.

`FEATURES.md` is the canonical "what's done vs planned" list. This README is the operator's guide.

## Capabilities at a glance

- **Soundboard** — upload, tag, drag-reorder, trim, normalize, per-sound volume, multi-track playback, real-time waveform.
- **Roles** — `superadmin` / `admin` / `user` / `guest`. Hierarchy enforced for upload, playback, override, lock states.
- **Web UI** — single-file SPA in `public/index.html`. Keyboard shortcuts, favorites bar, mobile layout.
- **Stats** — SQLite play log, audit log, activity heatmap, CSV export, per-sound play-count overlay.
- **Guest mode** — public link with IP-based rate limits, blocklist, per-IP cooldown overrides, optional moderation queue.
- **TTS** — four engines on a separate GPU container (Kokoro, Chatterbox, RVC, GPT-SoVITS). Voice management UI for adding/replacing Chatterbox voices from YouTube or audio uploads.
- **Companion** — Python tkinter app for system-wide hotkeys (stop/pause from anywhere on your desktop).

## Architecture

```
┌────────────────────────────────────────────────────┐
│  Discord                                           │
│  └─ voice channel ◄──── Opus stream ──────┐        │
└──────────────────────────────────┬────────┘        │
                                   │                 │
┌──────────────────────────────────┴─────────────────┐
│  CT 109 — Node.js soundboard (Express + discord.js)│
│  • SQLite stats (data/stats.db)                    │
│  • JSON-on-disk settings (data/*.json)             │
│  • yt-dlp + ffmpeg for TTS voice admin             │
│  • Companion API (/companion/*) for desktop tool   │
│  • Static SPA (public/index.html)                  │
└──────────────────────────────────┬─────────────────┘
                                   │ HTTP (TTS_API_URL)
                                   ▼
┌────────────────────────────────────────────────────┐
│  CT 110 — FastAPI TTS server (RTX 3090)            │
│  • Kokoro (built-in voices)                        │
│  • Chatterbox (zero-shot voice clone)              │
│  • RVC (post-process voice conversion)             │
│  • GPT-SoVITS (separate process on :9880)          │
└────────────────────────────────────────────────────┘
```

## Quick start (single host)

```bash
git clone https://github.com/smartpbx/discord-soundboard.git
cd discord-soundboard
npm install
cp .env.example .env  # edit DISCORD_TOKEN, USERS, etc.
node server.js
```

The TTS service is optional — leave `TTS_API_URL` unset and the soundboard runs without TTS features.

For LXC install (recommended for production), see `proxmox/README.md`. For Docker, `docker-compose.yml` provides both containers (the TTS container needs NVIDIA GPU passthrough).

## Roles and what they can do

| | superadmin | admin | user | guest |
|---|---|---|---|---|
| Play sounds | ✓ | ✓ | ✓ (≤7s default) | ✓ (≤7s default) |
| Upload sounds | ✓ (no limit) | ✓ (no limit) | ✓ (limited, optional moderation) | ✓ (limited, optional moderation) |
| Edit metadata | ✓ | ✓ | — | — |
| Delete sounds | ✓ | — | — | — |
| Pause/stop own playback | ✓ | ✓ | ✓ | ✓ |
| Pause/stop others' playback | ✓ (anyone) | ✓ (users + guests; not other admins) | — | — |
| Lock playback | ✓ (everyone-only mode too) | ✓ (admins-and-up only) | — | — |
| Approve uploads/signups | ✓ | — | — | — |
| Manage users / roles | ✓ | — | — | — |
| Manage TTS voices (add/replace/delete) | ✓ | — | — | — |
| TTS character limit | 2000 | 500 | 200 | 0 (off) by default |

Limits are configurable from the Superadmin → Access & Limits tab.

## Environment variables

Edit `.env` (see `.env.example` for the full template):

| Variable | Required | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token from the Discord Developer Portal |
| `PORT` | no (3000) | Web UI port |
| `SESSION_SECRET` | yes | Random hex, signs session cookies |
| `USERS` | (one of) | Inline `username:password:role` list (e.g. `clayton:hunter2:superadmin,bob:pw:user`) |
| `ADMIN_PASSWORD` / `USER_PASSWORD` / `SUPERADMIN_PASSWORD` | (one of) | Legacy single-account shortcuts; ignored if same username already in `USERS` |
| `TTS_API_URL` | no | TTS server base URL (e.g. `http://10.10.10.72:8880`); leave unset to disable TTS |
| `TTS_ADMIN_TOKEN` | no | Shared secret for `PUT/DELETE /voices/chatterbox/...`; **must match the TTS server's own `.env`**. Without it, the voice admin UI returns 503. |
| `YT_DLP_BIN` / `FFMPEG_BIN` | no | Override binary paths if not on `$PATH` |
| `COMPANION_TOKEN` | no | Bearer token for the companion app |

The TTS server has its own `.env` at `tts-server/.env` with `TTS_ADMIN_TOKEN`, `GPT_SOVITS_URL`, and engine-specific paths.

## Data layout

Everything stateful lives under `data/` (gitignored):

```
data/
├── users.json            # approved accounts (in addition to USERS env)
├── pending-users.json    # signup queue
├── guest.json            # guest settings, IP blocklist, cooldown overrides, history,
│                         #   TTS settings (enabled, per-role limits, disabled voices, RVC overrides)
├── pending.json          # pending uploads metadata
├── state.json            # playback state, volume, multi-play flag
├── stats.db              # SQLite: plays, admin_actions, tts_recents
├── stats.db-shm / -wal   # SQLite WAL files
├── tts-recents/          # per-user TTS audio cache
└── tts-staging/          # short-TTL staging for voice admin downloads/previews

sounds/
├── sounds.json           # sound metadata (display name, tags, color, volume, trim)
├── pending/              # uploads awaiting moderation
└── *.mp3 / *.wav / ...   # actual audio files
```

For Proxmox, the install script bind-mounts `data/` from the host (`/var/lib/discord-soundboard-data/<CTID>`) so it survives container rebuilds. See `FEATURES.md` for the migration steps if your container predates this.

## TTS voice management

From the web: **Superadmin → TTS Voices**.

- **Per voice:** enable/disable toggle, RVC refinement toggle (Chatterbox only), Replace button, Delete button.
- **+ Add Chatterbox voice:** modal with two source modes — paste a YouTube URL with start/end seconds, or upload an audio file. The soundboard server runs `yt-dlp → ffmpeg trim+loudnorm → 24kHz mono WAV`, lets you preview the clip, then uploads to the TTS server's `PUT /voices/chatterbox/{id}` endpoint. Source URL/timestamps are stored in `metadata.json` and shown under each voice's name.
- **Expression slider:** Chatterbox voices get a per-request `0.25 calm → 2.0 very expressive` knob in the TTS card.

Reference clips live at `tts-server/models/chatterbox/<voice_id>/reference.wav`. RVC refinement requires a matching `rvc_<voice_id>` model in `tts-server/models/rvc/manifest.json` — newly added voices fall back to Chatterbox-only output unless that model exists.

The full TTS roadmap (caching, speed control, OpenVoice, automated SoVITS fine-tuning) lives in GH issue **#6**.

## Companion app

`companion/hotkeys.py` — system-wide hotkey app. Runs locally on your machine alongside the soundboard. Bind keys to **Stop** and **Pause/Resume** so you can control playback without alt-tabbing to the browser.

```bash
cd companion
pip install -r requirements.txt
python hotkeys.py
```

Configure URL, token, and key bindings in the GUI (saved to `companion/config.json`) or via `.env` defaults: `SOUNDBOARD_URL`, `COMPANION_TOKEN`, `STOP_KEY`, `PAUSE_KEY`. Auth is Bearer-token via `/companion/*` routes.

## Deploy

The production setup pulls from `main` on push:

```bash
# CT 109 (soundboard)
ssh root@vm.mannerow.net "pct exec 109 -- update"

# CT 110 (TTS server)
ssh root@vm.mannerow.net "pct exec 110 -- bash -c 'cd /opt/discord-soundboard && git pull && systemctl restart tts-server'"
```

`scripts/update.sh` handles `git pull`, `npm install`, `pip install --upgrade yt-dlp`, and the service restart.

## Backup / restore

```bash
# In the container
./scripts/backup.sh                          # writes discord-soundboard-backup-YYYYMMDD-HHMMSS.tar.gz
./scripts/restore.sh /path/to/backup.tar.gz  # stops service, untars, restarts
```

The tarball contains `.env`, `sounds/`, and `data/`. TTS voice models on CT 110 are not included — back those up separately if you've added custom voices.

## Repo layout

```
server.js                  Express + Discord bot (single-process)
lib/
  stats-db.js              SQLite tables and queries
  tts-voice-admin.js       yt-dlp + ffmpeg pipeline for voice admin
public/
  index.html               Single-file SPA (HTML + CSS + JS, ~5k lines)
tts-server/
  main.py                  FastAPI app
  engines/
    kokoro_engine.py
    chatterbox_engine.py
    rvc_engine.py
    gptsovits_engine.py
  models/                  Voice clips and weights (gitignored)
  requirements.txt
companion/
  hotkeys.py               Tkinter hotkey app
sounds/                    User-uploaded audio (gitignored)
data/                      Settings, users, stats DB (gitignored)
proxmox/
  install/                 LXC container install scripts
  README.md
scripts/
  update.sh                In-container update
  backup.sh / restore.sh
  install-motd.sh          Login banner installer
  purge-env-from-history.sh
docker-compose.yml         Optional Docker path
DIAGNOSTICS.md             Voice / playback troubleshooting
FEATURES.md                Feature inventory + roadmap
```

## Diagnostics

If audio doesn't reach Discord, see `DIAGNOSTICS.md` — usually a UDP firewall/LXC issue. The bot logs `[DIAG]` lines for voice connection and player state changes; capturing those while reproducing is enough to pin down where it dies.

## License

Private project. No license declared.
