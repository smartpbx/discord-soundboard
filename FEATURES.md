# Discord Soundboard – Feature Roadmap

Features to implement, in rough priority order.

---

## Authentication

- **Discord OAuth login** – Users who are part of the Discord server can log in with their Discord account. Permissions are based on their server role (e.g. server admin → admin, custom role → user). Replaces or complements the current username/password auth.

---

## Quick Wins

- [x] **Keyboard shortcuts** – 1–9: play favorites, Space: play/pause, S: stop, Escape: close panels
- [x] **Sound preview** – Play locally in browser before sending to Discord (test volume/content)
- [x] **Remember preferences** – Last channel, folder, sound filter (localStorage + server-side state.json for volume/channel across restarts)
- [x] **Theme toggle** – Dark/light mode (saved in preferences)
- [x] **Compact view** – Smaller sound buttons, more on screen (saved in preferences)
- [x] **Mobile view** – Fullscreen soundboard, buttons fill screen (min/max size), pagination with swipe when many sounds (saved in preferences). *TODO: improve later – refine button sizing, swipe UX*

---

## Medium Effort

- [x] **Recently played** – Last 5 sounds for quick re-play (with waveform background, who played, when)
- [x] **Favorites** – Up to 9 favorites, mapped to keys 1–9 (saved in preferences)
- [ ] **Playback queue** – Queue sounds instead of replacing; play next when current ends
- [ ] **Sound button icons** – Icons, emojis, or custom images on each sound button
- [x] **Pending uploads badge** – Badge on Superadmin tab when uploads await approval
---

## Nice to Have
- [ ] **Duplicate sound** – Copy a sound (file + metadata) for variations
- [ ] **Per-sound volume** – Volume adjustment per sound for normalization

---

## Completed

- [x] Keyboard shortcuts (1–9 favorites, Space play/pause, S stop, Escape close)
- [x] Favorites (up to 9, mapped to keys 1–9)
- [x] Multi-user roles (superadmin, admin, user)
- [x] Guest access with IP tracking
- [x] Sound reordering (drag-and-drop)
- [x] User/guest uploads with moderation queue
- [x] Playback hierarchy (users/guests can't override admin/superadmin)
- [x] Waveform display for remote viewers (guests)
- [x] Pause/resume with correct position
- [x] Recently played (last 5, waveform background, who played & when)
- [x] Remember preferences
- [x] Pending uploads badge on Superadmin tab


### How to update data mount on older installs
For an existing container
To add the data mount to a container that was created before this change:
- Stop the container: `pct stop 200` (replace 200 with your CTID)
- Create the host directory: `mkdir -p /var/lib/discord-soundboard-data/200`
- Copy existing data (if you have any):
   ```pct start 200   pct exec 200 -- sh -c 'tar czf - -C /opt/discord-soundboard data 2>/dev/null' | tar xzf - -C /var/lib/discord-soundboard-data/200 --strip-components=1   pct stop 200```
- Add the mount – append this line to `/etc/pve/lxc/200.conf`:
   ```mp0: /var/lib/discord-soundboard-data/200,mp=/opt/discord-soundboard/data```
- Start the container: pct start 200
After this, volume, channel, guest settings, and pending uploads will persist across updates and restarts.