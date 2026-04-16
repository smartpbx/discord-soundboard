# Discord Soundboard – Feature Roadmap

Features to implement, in rough priority order. Completed items move to the bottom.

---

## Authentication

- [ ] **Discord OAuth login** – Users who are part of the Discord server can log in with their Discord account. Permissions are based on their server role (e.g. server admin → admin, custom role → user). Replaces or complements the current username/password auth.

---

## Sounds

- [ ] **Playback queue** – Queue sounds instead of replacing; play next when current ends
- [ ] **Sound button icons** – Icons, emojis, or custom images on each sound button
- [ ] **Per-sound volume** – Saved per-sound multiplier applied at playback time
- [ ] **Audio piping** – Stream computer audio (select app / exclude Discord) into the bot for admin/superadmin. Requires virtual audio device (PulseAudio virtual sink on Linux, VB-Cable on Windows)

---

## Text-to-Speech roadmap

The TTS system has its own multi-phase plan tracked in a dedicated GitHub issue. Quick status:

- **Phase 1 — Kokoro (done):** 20 built-in generic voices, ultra-fast, CPU OK.
- **Phase 2 — Chatterbox + RVC (done):** voice-cloned celebrity/character voices with optional RVC refinement on GPU.
- **Phase 3 — GPT-SoVITS (done):** experimental third engine, used for one Trump test voice.
- **Phase 4 — Save TTS as sound + recents (done):** floppy-disk button on Now Playing, per-user TTS history.
- **Phase 5 — Superadmin Voice Management UI (done 2026-04-16):** add/replace/delete Chatterbox voices from the web UI via YouTube URL or audio upload, with in-browser preview and source provenance stored in `metadata.json`.
- **Phase 6 — Expression slider (done 2026-04-16):** Chatterbox `exaggeration` 0.25–2.0 slider in the TTS card, hidden for non-Chatterbox voices.
- [ ] **Phase 7 — Speed control:** `atempo` ffmpeg post-process slider (0.8×–1.5×, pitch-preserving). Works on every engine.
- [ ] **Phase 8 — TTS clip caching:** SHA-256 of (text, voiceId, exaggeration, speed) → cached WAV; skip GPU work for repeated phrases.
- [ ] **Phase 9 — OpenVoice integration:** Add OpenVoice as either a tone-color converter (post-process on Kokoro/Chatterbox output, like RVC) or a full engine with explicit emotion presets. Decide after Phase 6 lands and we know what's still missing.

See GitHub issue **#6** for the full plan and tracking.

---

## TTS quality-of-life

- [ ] **Pronunciation overrides** – admin-defined phonetic map ("Jira" → "Jee-ruh"). M
- [ ] **Voice presets** – save voice + speed + volume + exaggeration combo. M
- [ ] **Live character counter on TTS input, red when over limit.** S
- [ ] **Auto-preview on voice select** – test phrase plays locally. S
- [ ] **Queue preview** – who is about to speak what. S

---

## Everyday UX / QoL

- [ ] **Right-click context menu** on sound buttons (assign favorite, edit, duplicate, copy name, delete). M
- [ ] **Copy sound name to clipboard** icon on hover. S
- [ ] **Drag-to-reorder without toggling reorder mode** + hover affordance. S
- [ ] **Search result highlighting** – bold matched substring. S
- [ ] **Preview volume slider** independent of send-to-Discord volume. S
- [ ] **Instant-favorite hint** – show next open 1–9 slot in context menu. S

## Power-user / Organization

- [ ] **Bulk upload from folder** – drop folder, auto-name from filenames. M
- [ ] **Folder / collection view** – nest sounds, reorder, hide, export per folder. L
- [ ] **Sound aliases** – alt search terms (`laugh_1` also triggers on `lol`). M
- [ ] **Merge tags** – rename tag, bulk-reapply. S
- [ ] **Duplicate-upload detection** – warn on same stem/size/duration. M
- [ ] **Batch normalize** – multi-select + queue. M
- [ ] **Search by duration range** – "sounds 2–5s". M
- [ ] **Sound-sharing deep links** – `?sound=filename` jumps/opens edit. S
- [ ] **Export / import sound library** – JSON backup of all metadata. M

## Admin / Superadmin

- [ ] **Admin action log** – approvals, deletes, settings changes. L
- [ ] **Archive-on-delete** – move to backup dir instead of wipe. S
- [ ] **Moderation queue filters** – by uploader, date, size, duration. M

## Audio / Effects

- [ ] **Per-sound fade in/out** – extend trim handles with 0.5–2s fade. M
- [ ] **Playback speed** 0.8×–1.5× (pitch-preserving). M
- [ ] **Crossfade** between sequential sounds (multi-play mode). L
- [ ] **TTS ducking** – auto-lower music when TTS speaks. L
- [ ] **EQ presets** – bass boost / treble cut toggle. L

## Mobile / Touch

- [ ] **Swipe left/right** on sound for quick actions. M
- [ ] **Double-tap to favorite.** S
- [ ] **Bottom-sheet edit panel** on mobile (vs. center modal). M

## Accessibility

- [ ] **`aria-label`** on play/preview/edit/favorite/delete buttons. S
- [ ] **Full keyboard-only** nav of hamburger + options menus. M
- [ ] **Explicit high-contrast theme** beyond dark/light. M

## Observability / Stats

- [ ] **Play-count badge** on sound buttons. S
- [ ] **Last-played label** ("5h ago") on buttons. S
- [ ] **Personal stats** – "427 plays, 15h total" in profile. S

---

## Completed

- [x] Keyboard shortcuts (1–9 favorites, Space play/pause, S stop, Escape close)
- [x] Sound preview (play locally before sending to Discord)
- [x] Remember preferences (last channel, folder, filter, volume; persists across restarts)
- [x] Theme toggle (dark/light)
- [x] Compact view
- [x] Mobile view (responsive layout, pagination)
- [x] Recently played (last 5, waveform background, who played, when)
- [x] Favorites (up to 9, mapped to keys 1–9)
- [x] Pending uploads badge on Superadmin tab
- [x] Duplicate sound (file + metadata; opens duplicate in edit panel)
- [x] Normalize audio (in-place via ffmpeg loudnorm, EBU R128 -16 LUFS)
- [x] Multi-user roles (superadmin, admin, user)
- [x] Guest access with IP tracking
- [x] Sound reordering (drag-and-drop)
- [x] User/guest uploads with moderation queue
- [x] Playback hierarchy (users/guests can't override admin/superadmin)
- [x] Waveform display for remote viewers (guests)
- [x] Pause/resume with correct position
- [x] Admin can pause/stop their own, other admins', users', and guests' playback
- [x] Auto-normalize on upload + sound-pane play-count heatmap
- [x] Real-time waveform overlay during preview
- [x] Activity heatmap + sound play audit log + admin action log foundation
- [x] Bulk approve pending signups
- [x] Per-IP guest cooldown overrides
- [x] Bulk IP block/unblock from paste
- [x] Soft-ban users (disable flag)

### How to update data mount on older installs
For an existing container, to add the data mount:
- Stop the container: `pct stop 200` (replace 200 with your CTID)
- Create the host directory: `mkdir -p /var/lib/discord-soundboard-data/200`
- Copy existing data (if you have any):
   ```
   pct start 200
   pct exec 200 -- sh -c 'tar czf - -C /opt/discord-soundboard data 2>/dev/null' | tar xzf - -C /var/lib/discord-soundboard-data/200 --strip-components=1
   pct stop 200
   ```
- Add the mount – append this line to `/etc/pve/lxc/200.conf`:
   ```
   mp0: /var/lib/discord-soundboard-data/200,mp=/opt/discord-soundboard/data
   ```
- Start the container: `pct start 200`

After this, volume, channel, guest settings, and pending uploads will persist across updates and restarts.
