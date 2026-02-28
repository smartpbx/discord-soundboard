# Discord Soundboard – Feature Roadmap

Features to implement, in rough priority order.

---

## Authentication

- **Discord OAuth login** – Users who are part of the Discord server can log in with their Discord account. Permissions are based on their server role (e.g. server admin → admin, custom role → user). Replaces or complements the current username/password auth.

---

## Quick Wins

- [ ] **Keyboard shortcuts** – Space: play/pause, S: stop, number keys 1–9 for first 9 sounds, Escape: close panels
- [x] **Sound preview** – Play locally in browser before sending to Discord (test volume/content)
- [x] **Remember preferences** – Last channel, folder, sound filter (localStorage)
- [x] **Theme toggle** – Dark/light mode (saved in preferences)
- [x] **Compact view** – Smaller sound buttons, more on screen (saved in preferences)
- [x] **Mobile view** – Full-screen buttons, swipe through sounds, folder tabs (saved in preferences)

---

## Medium Effort

- [ ] **Recently played** – Last 5–10 sounds for quick re-play
- [ ] **Favorites** – Star sounds for a favorites tab
- [ ] **Playback queue** – Queue sounds instead of replacing; play next when current ends
- [ ] **Hover preview** – Optional short preview on hover (with delay to avoid accidental plays)

---

## Nice to Have

- [ ] **Pending uploads badge** – Badge on Superadmin tab when uploads await approval
- [ ] **Duplicate sound** – Copy a sound (file + metadata) for variations
- [ ] **Per-sound volume** – Volume adjustment per sound for normalization

---

## Completed

- [x] Multi-user roles (superadmin, admin, user)
- [x] Guest access with IP tracking
- [x] Sound reordering (drag-and-drop)
- [x] User/guest uploads with moderation queue
- [x] Playback hierarchy (users/guests can't override admin/superadmin)
- [x] Waveform display for remote viewers (guests)
- [x] Pause/resume with correct position
- [x] Remember preferences
