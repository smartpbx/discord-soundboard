# Changelog

User-facing changes, newest first. The web UI surfaces this through a
"What's New" modal and reads the running short-SHA as the version stamp.
Every commit that ships a user-visible change should add an entry here —
see `CLAUDE.md` for conventions.

## 2026-05-13
- **Clip button on the soundboard** — the Sounds card header gains a 📎 Clip button (sitting alongside TTS / URL / Song / Upload) with quick duration picks (10 s / 30 s / 1 min / 2 min) and a "Manage clips…" entry. Clicking a duration captures from the rolling buffer and auto-opens the Clips modal scrolled to the new clip. Same capture path as `/clip` in Discord, available to anyone logged in.
- **`/clip` rolling buffer + Clips modal** — the bot now keeps the last 3 minutes of voice-channel audio per active speaker in memory. Run `/clip` in Discord (defaults to 30 s, accepts 5–120) to mix it down into an MP3 you can preview, trim, name, and save to the soundboard. The hamburger menu gets a new **Clips** entry with a count badge for unsaved clips. Audio paths reuse the per-speaker capture pipeline that voice triggers already use; the rolling buffer lives in memory only and is cleared whenever the bot leaves a voice channel. Up to 30 clips are kept on disk; oldest are evicted automatically.
- **YouTube cookie session for the URL streamer** — fixes "Failed to start stream" on most YouTube videos. YouTube's bot-detection wall was rejecting yt-dlp requests from the soundboard's datacenter IP, even with the existing player-client workarounds. A persistent Chromium now runs under Xvfb on CT 109 holding a logged-in YouTube tab, and yt-dlp reads its cookies via `--cookies-from-browser`. Superadmin → Access & Limits gets a new "YouTube Cookie Session" panel: **Open browser** tunnels you into the Chromium UI through noVNC (one-time login on a throwaway Google account), **Enable cookies for yt-dlp** flips the env var live, **Test cookies** runs a real yt-dlp probe against the canary URL, and a 6-hour systemd timer reloads the YouTube tab so Google's session cookies stay refreshed indefinitely.

## 2026-05-12
- **UX polish pass** — destructive actions (delete sound, delete user, delete tag, delete trigger, disable user, normalize sound) now use an in-app modal instead of the browser's native confirm box (looks trusted, works properly on mobile, theme-aware, Escape/Enter wired up). A keyboard focus indicator was restored across every interactive element (the previous `outline:none` stripping left keyboard users with no feedback). The Controls button in the top bar now shows a badge with the count of currently-active toggles plus a tooltip listing which ones are on, so you don't have to open the popover to check state. The soundboard auto-enters the mobile-grid layout on viewports ≤640 px (still toggleable from the Sounds-options menu). New `confirmModal`/`alertModal`/`promptModal` helpers will replace the remaining native dialogs in follow-up commits.
- **Security hardening pass** — passwords are now stored as `scrypt`-hashed values; existing plaintext users are migrated transparently on their next login. `SESSION_SECRET` is required (no more placeholder fallback). Session cookies are SameSite=lax + Secure-when-HTTPS, and the app trusts the Caddy proxy so client IPs can't be spoofed via the `X-Forwarded-For` header anymore. Failed logins are throttled at 10 per 10 minutes per IP. The absurd-captcha token compare is now constant-time. Suno API routes reject malformed task IDs before they can reach any filesystem path. Voice triggers play sounds as a regular `user` role instead of `superadmin`, so they now respect admin-only / superadmin-only modes. A `.dockerignore` was added so future Docker builds don't accidentally bake `.env`, `data/`, `sounds/`, or the vosk model into the image.
- **Stability sprint** — atomic JSON state writes (a crash mid-write can no longer blank `guest.json` and wipe every setting), in-memory cache for `guest.json` and `state.json` (removes ~75 sync disk reads/sec from the voice-trigger hot path), every voice-connection rejoin path (manual `/rejoin`, Disconnect handler, premature-close burst) now funnels through one cooldown + in-flight guard so the disconnect race can't tear down a freshly-joined connection, `ENOBUFS` (kernel UDP-buffer pressure) added to the benign-error allowlist so it no longer triggers a process restart, and `unhandledRejection` now re-throws like `uncaughtException` instead of being silently swallowed.
- **`/rejoin` slash command** — any member can run `/rejoin` to move the soundboard into their current voice channel, or to bounce it out and back in when it's gotten stuck. Works whether the bot was already in another channel or not connected at all. Limited to one bounce per 5 seconds (rapid back-to-back invocations leaked UDP sockets badly enough to crash the bot).
- **Voice triggers fire faster and more accurately** — recognition now matches against vosk's partial (mid-utterance) transcripts, so a trigger fires within ~moments of the word being spoken instead of waiting for the speaker to finish the sentence + an 800 ms silence tail. The activity log's transcript field upgrades to the full sentence once recognition finalises.
- **Word-boundary trigger matching** — phrases now match on whole-word boundaries instead of bare substring, so `wife` no longer fires on "delegate" or "midwife" and `bad` no longer fires inside "badger". Existing triggers keep working; configured phrases are still case-insensitive and whitespace-normalised.
- **Voice connection stability** — bumped `@discordjs/voice` to 0.19.2 (upstream fix for the recent "every DAVE packet fails to decrypt" regression that caused choppy / missed triggers) and added auto-recovery on Discord disconnects and after a burst of audio-player "Premature close" errors. Discord.js bumped to 14.26.4.
- **Quieter voice diagnostics** — per-packet `[DAVE] Failed to decrypt a packet` debug noise is rolled up into a single `decrypt failures last 30s: N` line so journald keeps months of real history instead of hours.
- **Voting toggle in the Controls menu** — the top-bar ⚙ Controls popover gains a "Voting (/votekick · /votetimeout)" switch (superadmin-only), mirrored with the toggle in Superadmin → Voting.

## 2026-05-11
- **Voice triggers** — Superadmin → Voice Triggers configures phrase-to-sound mappings; the bot listens to its current voice channel and plays the mapped sound when it hears the phrase. Speech recognition runs on-device (vosk small English model, grammar-restricted to your configured phrases), so no audio leaves the host. Each trigger has its own cooldown and an optional speaker filter so a phrase can be scoped to one specific Discord user. The model installs automatically on `scripts/update.sh` (~40 MB one-time download).
- **Bot no longer self-deafens** — voice connections now join with `selfDeaf: false` so the bot can hear the channel for voice triggers (previously joined deafened by default).
- **Global voice-trigger cooldown** — Voice Triggers tab adds a "Global cooldown" input that throttles all trigger fires combined, on top of each row's per-trigger cooldown. 0 disables.
- **Voice trigger activity log** — Voice Triggers tab gains a "Recent activity" table showing the last 50 matched-phrase events: when, speaker, phrase, transcript, sound, and status (fired vs. cooldown-skipped vs. global-cooldown-skipped). Useful for tuning cooldowns and spotting false positives.
- **Controls menu in the top bar** — the inline "Only admins / Only superadmin" toggles fold into a single ⚙ Controls button that opens a popover containing those toggles plus Multi-play and Voice activation. The Multi-play card section and the Voice Triggers tab's Voice-activation toggle still work as before; flipping any of the four stays in sync across both surfaces.
- **Voice triggers now log the full sentence** — vosk runs open-vocabulary instead of grammar-restricted so the activity log's Transcript column shows the whole heard sentence (e.g. "this song is so bad") rather than just the matched word. Trigger matching is unchanged — phrases are substring-matched against the transcript.
- **/votekick and /votetimeout slash commands** — members in the bot's voice channel can call `/votekick @user [reason]` (disconnects the target from voice) or `/votetimeout @user minutes:N [reason]` (Discord guild timeout). The vote panel shows live Yes/No tallies with buttons; the vote ends as soon as the threshold is met or Yes can no longer win, or when the window expires. Superadmin → Voting configures threshold %, vote window, minimum eligible voters, target cooldown, max timeout duration, and immune roles. **Required Discord permissions on the bot's role:** `Move Members` for kick and `Moderate Members` for timeout — if missing, votes still pass but the action will fail (visible in the in-Discord embed and the Recent votes log).

## 2026-04-28
- **Delete sounds permission** — Superadmin → Access & Limits can allow users and/or admins to permanently delete library sounds (same archive behavior as before). Superadmin → Users → Overrides adds a per-account “Delete sounds” override. The edit-panel Delete button follows the same rules; guests still cannot delete.

## 2026-04-24 — 04235c7
- **Sort-row layout fix** — sort dropdown is now sized to its content instead of stretching full-width, the "0 plays only" toggle sits next to it, and the tag-row "more / less" expander moved up onto the same row instead of floating on top of the tags and hiding them when expanded.

## 2026-04-23 — 1d46410
- **Sort & filter the sound grid** — new row under the search box with a sort dropdown (Custom order / Recently added / Oldest first / Name A–Z / Most played / Least played) and a "0 plays only" toggle for surfacing sounds nobody has played yet. Both persist per-user. Non-default sort temporarily disables reorder mode so drag positions can't collide with a sort order.
- **Batch display-name cleanup** — 78 sounds with messy names (raw filenames, leftover `.mp3` / YouTube-ripper junk, slugified contractions like `don-t`) got cleaned display names. Files on disk and every other meta field (tags, color, volume, trim points, duration, etc.) are untouched — only the label users see changed.

## 2026-04-23 — d8cf0f1
- **Multi-file upload** — the upload card's file picker and drag-and-drop now accept multiple audio files at once. Each file is uploaded sequentially (respecting your role's size limit per file), and a single toast summarizes how many succeeded, were sent for moderation, or failed.

## 2026-04-22 — 20e84aa
- **User-overrides modal shows on top** — bumped its overlay z-index above the superadmin panel. Previously it opened behind the superadmin card and looked frozen.
- **Superadmin design pass** — Access & Limits, Moderation, and Activity tabs redone in the same visual language as the TTS card redesign: uppercase micro-labels above every input, border-top dividers between sections, custom toggle switches replacing bare checkboxes (Guest access, Uploads, Multi-play, Auto-normalize, TTS enable, Suno enable, URL-streaming role toggles), consistent `btn-sm` buttons. Section headers now carry meta content like the Suno credits display and refresh button inline on the right.

## 2026-04-22 — c35c884
- **Per-user permission overrides** — every role-level limit can now be overridden per username. Superadmin → Users → "Overrides" on any user opens a modal with: TTS enabled + max chars + cooldown, Suno daily limit, URL streaming enabled + max duration, playback max duration + cooldown, upload enabled + max duration + max size. Leaving a field blank (or set to "— role default —" for bools) falls back to the role default. Stored in `guest.json.userOverrides`; works for env-configured users too. Endpoints: `GET /api/superadmin/user-overrides`, `PUT /api/superadmin/user-overrides/:username`, `DELETE /api/superadmin/user-overrides/:username`.

## 2026-04-22 — d60e066
- **Removed 🔀 3 takes picker** — Fish (the only engine in active use) is deterministic, so N takes always returned N identical WAVs. Removed button, panel, client JS, and the `/api/tts/takes` + `/api/tts/takes/commit` endpoints. Revisit if a stochastic engine comes back.
- **What's New modal now always fetches fresh** — previously the client cached the changelog in memory on load, so if a deploy landed while the page was open you'd see stale notes until a hard refresh. Tiny file, no reason to cache.
- **First-visit "New" badge logic fixed** — the top release entry now flags as NEW on your first-ever open instead of silently blending in.

## 2026-04-22 — e301ec6
- **TTS clip caching** — every synth output gets hashed by its payload and kept in a disk LRU under `data/tts-cache/`. Repeat phrases (and every unchanged line in a conversation replay) skip the GPU entirely, so a Conv-mode edit that only changes line 3 reuses line 1, 2, 4, 5. Size-capped via `TTS_CACHE_MAX_MB` env (default 500 MB); set `TTS_CACHE_ENABLED=0` to turn off.
- **Voice presets** — save the current voice + expression + emotion + volume + humanize combo as a named preset, apply in one click. Preset dropdown lives at the left of the setup row with "Save current" and "Manage" actions. Up to 30 presets in localStorage.
- **🔀 3 takes picker** — new button next to Speak that synthesizes 3 candidate takes (cache-bypassed, so each one is a fresh stochastic Chatterbox sample). Inline panel with 3 audio previews + "Use this" per take; clicking commits that specific take to the Discord queue.

## 2026-04-22 — 2df4135
- **Squared-off TTS card buttons** — Single/Conversation mode switch, Speak/Again, and update-banner buttons no longer use pill-round corners; they now match the flat square style of the sound filter chips and TTS/URL/Song/Upload row elsewhere in the UI.

## 2026-04-22 — 95773db
- **Fish tag tray flattened** — dropped the DELIVERY / EMOTION / BODY / OTHER groupings so the expanded tray takes far less vertical space. Chip corners squared down (2px) to match the rest of the app's flat button style.
- **Per-line emotion dropdown in conversation mode** — each row now has its own Auto/Neutral/Soft/Excited/Yell/Angry/Sad/Happy selector, matching single mode. Forces the emotion for that line's synth.
- **What's New modal already scrolls** — the body has `max-height: calc(100vh - 4rem); overflow-y: auto`, so older release notes are always reachable below the latest entry.

## 2026-04-22 — 7b6fd87
- **Version stamp in the header menu** + **What's New modal** — footer of the hamburger menu shows the running `vX · shortSha`; click to open the changelog. Unseen entries highlight with a "New" badge.
- **Update banner** — page polls `/api/version` every 60s; when the deployed build changes, a purple banner prompts to reload so you're not stuck on stale JS/CSS.
- **Design-pass fixes** — tag chips back to the neon-green palette (clearer), bottom controls get more breathing room, Speak/Again restyled as pill buttons to match the mode switch + AI cluster, Volume slider lives next to Speak so conversation mode doesn't leave the button orphaned.

## 2026-04-22 — 3bb5c33
- **TTS card redesign** — cleaner hierarchy, categorized collapsible Fish tag tray, stacked conversation bubbles with alternating accent colors, labeled control rows, segmented Single/Conversation switch.
- **Shared tag tray in conversation mode** — click any `[laughing]`/`[sigh]`/… chip and it inserts into whichever TTS input was last focused (main textarea or a conversation row).
- ✨ Rewrite button disables itself when the textarea is empty — it rewrites existing text, it doesn't generate.

## 2026-04-22 — 1148866
- **Multi-voice conversation mode** — toggle 💬 Conversation in the TTS card to compose an exchange. Each line picks its own voice, has its own pause-before slider, humanize toggle, and ✨ rewrite button. Server stitches all lines into one playback with ffmpeg silence padding. Up to 12 lines.
- **Enter to speak** — plain Enter in the TTS textarea sends now (Shift+Enter for newline), matching Discord-send convention.

## 2026-04-22 — e6bef93
- **Click-to-insert tag chips** — the Fish/Chatterbox tag pills under the TTS textarea are now clickable buttons. Clicking inserts the tag at the cursor position in the TTS textarea (auto-pads with whitespace).

## 2026-04-21 — fc8563d
- **Rewrite uses inline Fish tags more actively** — the ✨ Rewrite LLM now actively inserts `[laughing]`/`[sigh]`/`[shouting]`/`[pause]` etc. when the voice runs through Fish, instead of just preserving pre-existing tags.

## 2026-04-21 — 2e75ea8
- **✨ Rewrite button** — new button in the top-right of the TTS textarea that rewrites your message in the selected voice's actual style (Trump → rally riff, Herzog → philosophical narration). Unlike Humanize, it reshapes phrasing / vocabulary / length — not just disfluencies.
- Humanize length caps loosened — the LLM now uses as many palette phrases as a sentence can carry naturally instead of obeying a hard 1.3× ratio.

## 2026-04-21 — 78f5947
- **Per-voice humanize style profiles** — 37 voices get tailored disfluency and cadence rules (Trump skips "uhh"s, Peterson/Von/Morty lean heavier, Herzog stays philosophical). Fish voices get explicit permission to insert inline `[tags]` where emotion is obvious.
- Reference-audio time selectors in voice-creation modals now accept `m:ss` format instead of raw seconds.

## 2026-04-21 — 27ac8c1
- Humanize LLM uses a smaller context window (4K tokens) so it coexists with Fish-Speech on the 3090 instead of OOM-ing it at startup.

## Earlier
- Humanize fixes for dropped-tag false positives + Ollama native-chat reliability + Qwen3 `think:false` support.
- Fish per-emotion reference clips reach parity with Chatterbox (#72).
