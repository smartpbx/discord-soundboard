# Discord Soundboard – Features & Roadmap

A self-hosted Discord soundboard with a web UI, multi-user roles, an SQLite-backed stats system, and a separate GPU TTS service. This document is a complete inventory of what the app does today, plus what's planned. Anything checked is shipped.

---

## Auth & sessions

- [x] Username + password login (`/api/login`, `/api/logout`, cookie sessions via express-session)
- [x] Self-registration with optional moderation queue (`/api/register` → `data/pending-users.json`)
- [x] Password change for any signed-in user (`/api/me/password`, min 6 chars, force-change flag)
- [x] Four-tier role model: `superadmin` / `admin` / `user` / `guest`
- [x] Users defined inline via `USERS=username:password:role,...` env var, or via `data/users.json` for self-registered/approved accounts
- [x] Heartbeat endpoint to keep sessions alive (`/api/heartbeat`)
- [x] Settings endpoint exposes role-appropriate config to the frontend (`/api/settings`)
- [ ] Discord OAuth login — server-role to app-role mapping. Replaces or complements password auth.

---

## Sound library

- [x] Upload from drag-and-drop or file picker (`POST /api/upload`, multipart)
- [x] Per-role upload limits: max bytes, max duration; oversized rejected client-side before POST
- [x] Optional auto-normalize on upload (ffmpeg loudnorm EBU R128 / -16 LUFS)
- [x] Tags: per-sound array, drag-reorder, hide/unhide, rename, delete
- [x] Edit panel: rename, trim (start/end), color, per-sound volume multiplier, `stopOthers` flag, normalize, duplicate, delete (superadmin)
- [x] Drag-and-drop reorder for the sound grid
- [x] Search + tag filter (client-side)
- [x] Favorites bar — up to 10 slots, mapped to keys 0–9, drag-reorder
- [x] Keyboard shortcuts: 1–9 favorites, Space play/pause, S stop, ? cheatsheet, Escape close panels
- [x] Download the original file from the edit modal
- [ ] Sound button icons (emoji or custom image)
- [ ] Playback queue (queue instead of replace)
- [ ] Bulk upload from folder
- [ ] Folder/collection view above tags
- [ ] Sound aliases (alt search terms)
- [ ] Merge tags
- [ ] Duplicate-upload detection
- [ ] Search by duration range

---

## Playback to Discord

- [x] Play with optional trim (`POST /api/play`)
- [x] Pause / resume / stop with correct restored position
- [x] Volume: global slider plus per-sound multiplier (0–2×)
- [x] Multi-track mode: simultaneous playback with audio mixing (`multiPlayEnabled` flag)
- [x] `stopOthers` flag forces interruption of other tracks
- [x] Lock states: superadmin-only mode, admin-locked mode (per-role override hierarchy)
- [x] Real-time waveform overlay during local browser preview
- [x] Static waveform display + scrub for guests/remote viewers
- [x] Recently-played sidebar (last 5, with waveform thumbnail, who played, when)
- [ ] Per-sound fade in/out
- [ ] Playback speed 0.8×–1.5× (pitch-preserving)
- [ ] Crossfade between sequential sounds in multi-play mode
- [ ] EQ presets

---

## Discord bot

- [x] discord.js + @discordjs/voice; libsodium-wrappers loaded before voice connection
- [x] Voice intent set (`Guilds`, `GuildVoiceStates`); no message intent
- [x] Bot joins voice channels via the web UI (no slash commands)
- [x] Diagnostic logging on voice/player state changes (see `DIAGNOSTICS.md`)

---

## Guest mode

- [x] Toggleable public access (`/api/guest/start`)
- [x] Per-role limits: max clip duration, cooldown seconds, upload bytes/seconds
- [x] IP tracking with full play history (`data/guest.json`)
- [x] IP blocklist with single + bulk add/remove from clipboard paste
- [x] Per-IP cooldown overrides (e.g. 0 for known/trusted IPs)
- [x] Guest uploads optionally route to moderation queue

---

## Moderation queue

- [x] Pending uploads view: approve (move to `sounds/`) or reject (delete from `sounds/pending/`)
- [x] Per-pending audio preview (`/api/superadmin/pending-uploads/audio/:filename`)
- [x] Pending signup view: approve with role selection, bulk-approve, reject
- [x] Pending count badge on the Superadmin tab

---

## Stats & activity

SQLite at `data/stats.db` (`lib/stats-db.js`):

| Table | Columns |
|---|---|
| `plays` | `id, sound_filename, display_name, user_id, user_role, guest_ip, started_at, ended_at, planned_duration_ms, actual_duration_ms, stopped_early` |
| `admin_actions` | `id, actor, actor_role, action, target, details, at` |
| `tts_recents` | `id, owner, text, voice_id, voice_label, display_name, wav_path, created_at` |

- [x] Activity heatmap (last 90 days) on Superadmin → Activity tab
- [x] Sound play audit log with filters (user, sound, date range), CSV export (`/api/stats/plays.csv`)
- [x] Plays-per-day series (`/api/stats/plays-per-day`)
- [x] Per-sound play-count heatmap overlay on the sound grid (toggle)
- [x] Admin actions log (approvals, deletes, settings changes)
- [ ] Per-user personal stats ("427 plays, 15h total")
- [ ] Last-played label on sound buttons ("5h ago")
- [ ] Play-count badge on sound buttons (always-on, not just heatmap mode)

---

## Text-to-Speech

Engines on the GPU container:

- [x] **Kokoro** — 20 generic voices, ultra-fast, CPU-OK
- [x] **Chatterbox** — zero-shot voice cloning from a 5–10s reference clip; 14 celebrity/character voices
- [x] **RVC** — post-process voice conversion for 14 voices (Chatterbox output → RVC refinement); auto-skipped for cartoon voices
- [x] **GPT-SoVITS** — separate FastAPI process on port 9880 (one experimental Trump voice)

Web features:

- [x] TTS card with text input, voice dropdown (grouped), volume slider, expression slider
- [x] Per-role text-length limits and cooldowns
- [x] TTS queue (sequential playback, configurable max)
- [x] Save TTS as permanent sound (floppy-disk button)
- [x] Per-user TTS recents sidebar (replay, delete, save-as-sound)
- [x] **Superadmin Voice Management UI** — add/replace/delete Chatterbox voices via YouTube URL or audio file upload, in-browser preview, source URL/timestamps persisted in `metadata.json`
- [x] **Chatterbox expression slider** — emotion intensity 0.25–2.0, hidden for non-Chatterbox voices

Planned (full plan in GH issue **#6**):

- [ ] **Phase 7** — Speed control (`atempo` ffmpeg post-process, every engine)
- [ ] **Phase 8** — TTS clip caching (skip GPU work on repeat phrases)
- [ ] **Phase 8b** — Voice presets (saved voice + speed + volume + exaggeration combos)
- [ ] **Phase 9** — OpenVoice integration (likely as tone-color converter alongside RVC, possibly as full engine #5)
- [ ] **Phase 10** — Automated GPT-SoVITS fine-tuning per voice (yt-dlp → diarization → Whisper → train → auto-deploy). The current quality cap on celebrity voices is here; fine-tuned SoVITS is the path to "indistinguishable from source" output.

TTS QoL not yet shipped:
- [ ] Pronunciation overrides (admin phonetic map)
- [ ] Voice presets
- [ ] Live character counter (red over limit)
- [ ] Auto-preview on voice select (test phrase plays locally)
- [ ] Queue preview ("who's about to speak what")

---

## Companion app

`companion/hotkeys.py` — Python tkinter GUI, cross-platform:

- [x] System-wide hotkey binding via `keyboard` library (works while soundboard is in background)
- [x] Stop and pause/resume actions; configurable keys
- [x] Bearer-token auth to a separate `/companion/*` route surface
- [x] Connection settings persisted to `companion/config.json`; defaults from `.env`

---

## Operations

- [x] Backup script (`scripts/backup.sh`) — tarballs `.env`, `sounds/`, `data/`
- [x] Restore script (`scripts/restore.sh`) — stops service, untars, restarts
- [x] Update script (`scripts/update.sh`) — `git pull`, `npm install`, refresh yt-dlp, restart service
- [x] Login banner / MOTD installer (`scripts/install-motd.sh`)
- [x] Proxmox LXC install scripts for both containers (`proxmox/install/`)
- [x] Docker / docker-compose paths (CPU + optional NVIDIA GPU TTS)
- [x] Health endpoints: TTS server has `/health`; soundboard does not yet
- [ ] `/health` on soundboard for orchestrator probes
- [ ] Atomic JSON writes (write-temp + rename) — current writes are not concurrency-safe (see #1)
- [ ] Persist TTS queue across restarts
- [ ] ffmpeg child cleanup on client abort
- [ ] Structured logging (pino), restart policies, request/error counters

---

## Security & hardening

Open items tracked in GH issue **#1**:
- [ ] Cookie `secure: false` is hardcoded — needs env-driven flip
- [ ] Weak default session secret — should refuse to boot without a real one
- [ ] Rate limiting on `/api/login`, `/api/register`, `/api/guest/start`, `/companion/*`
- [ ] CSRF middleware on state-changing POSTs
- [ ] In-memory password hashing for `USERS`-defined accounts
- [ ] Unify `esc()` (currently re-defined ~8 times in `public/index.html`)
- [ ] `cors` package declared but unused — wire up or remove
- [ ] Tests (none today)

---

## Settings & accessibility

- [x] Theme toggle (dark/light, persisted to localStorage)
- [x] Compact view (smaller buttons, more on screen)
- [x] Mobile responsive layout with pagination
- [x] Per-user preferences (channel, folder, filter, volume) persisted to localStorage + server `state.json`
- [ ] `aria-label`s on all action buttons
- [ ] Full keyboard-only nav of menus
- [ ] Explicit high-contrast theme

---

## Brainstorm (everything else)

The full feature wishlist (UX, social, audio effects, mobile, stats) lives in GH issue **#2** with effort tags (S/M/L). Pull from there when picking the next thing.
