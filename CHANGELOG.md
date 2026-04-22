# Changelog

User-facing changes, newest first. The web UI surfaces this through a
"What's New" modal and reads the running short-SHA as the version stamp.
Every commit that ships a user-visible change should add an entry here —
see `CLAUDE.md` for conventions.

## 2026-04-22 — pending
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
