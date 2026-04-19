# Expressive TTS Plan

Goal: close the naturalness + celebrity-accuracy gap between our current
Chatterbox+RVC stack and cloud TTS (ElevenLabs) without leaving local hardware.

## Why the current output feels flat

1. **Chatterbox prosody is locked to the reference clip.** A calm podcast
   ref makes every synth calm, no matter how high `exaggeration` goes.
2. **RVC only swaps timbre.** It inherits the base TTS's cadence and
   dynamics, so a flat base becomes a flat celebrity.
3. **Single reference per voice.** No emotional range.
4. **Only one knob exposed** (`exaggeration`). Chatterbox also has
   `cfg_weight` and `temperature` that affect variation we don't touch.
5. **No text-aware expression.** ALL CAPS / ellipses / bracketed tags
   aren't interpreted — the whole utterance gets one uniform synth.

## Strategy: engine-agnostic infra first, then widen the engine bench

The following work sits *above* whichever TTS engine runs. Building it first
means every engine we add later plugs in for free.

### Phase 1 — Engine-agnostic expression layer

- **P1a. Text → emotion segment preprocessor** (`lib/tts-expression.js`)
  Parse input into segments `[{text, emotion, intensity, pause_ms}]`.
  Detect:
  - `ALL CAPS` word runs → `yell`, intensity 1.0
  - trailing `...` or `*softly*` / `[soft]` → `soft`, intensity 0.4
  - `!!!` → `excited`, intensity 0.9
  - explicit `[angry]`, `[sad]`, `[happy]`, `[whisper]` bracketed tags
  - default → `neutral`
  Unit-testable, engine-agnostic.

- **P1b. Multi-reference clips per voice (Chatterbox + anything that
  supports ref audio)**
  Each voice gets up to 5 refs tagged by emotion
  (`calm / neutral / excited / angry / sad`). Stored under
  `models/chatterbox/<voice_id>/refs/<emotion>.wav` with a `refs.json`
  index. Existing single ref becomes `neutral.wav` (backwards-compatible).
  TTS server picks the ref matching a segment's emotion, falls back to
  `neutral` if not present.

- **P1c. Expose cfg_weight + temperature + emotion presets**
  Pass through `/synthesize`. Ship defaults as emotion → preset map:

  | emotion  | exag | cfg | temp |
  |----------|------|-----|------|
  | soft     | 0.35 | 0.55 | 0.7 |
  | neutral  | 0.50 | 0.50 | 0.8 |
  | excited  | 1.20 | 0.42 | 0.9 |
  | yell     | 1.70 | 0.35 | 0.95|
  | angry    | 1.80 | 0.30 | 0.95|
  | sad      | 0.45 | 0.55 | 0.75|

  Per-voice overrides stored in voice metadata.

- **P1d. Segmented synth + stitch**
  When P1a produces >1 segment, the TTS server synthesizes each with its
  own ref + preset and concatenates with small inter-segment gaps
  (100–250 ms) plus a 30 ms crossfade to avoid clicks.

- **P1e. Regenerate button (3 takes)**
  TTS card shows 🔄 Regenerate after a synth → resynthesizes 3 times
  with different seeds (served in parallel when engine supports it),
  user picks their favorite before playing to Discord.

### Phase 2 — Engine alternatives

Keep Chatterbox + RVC as the default, but let each voice pick its engine.

- **P2a. F5-TTS** (zero-shot flow-matching, late-2024) — no per-voice
  training. Same reference clip as Chatterbox. Engine file
  `engines/f5tts_engine.py` following the existing shape. Voice id
  prefix `f5_`.
- **P2b. GPT-SoVITS zero-shot** — stub already exists; wire to the
  running gptsovits service on `:9880`. Reuses Chatterbox refs. Voice
  id prefix `gsv_`.
- **P2c. GPT-SoVITS fine-tune pipeline** (optional, heavier) — one-click
  per voice via superadmin. Reuses the cleaned dataset archive that
  Phase 6 of RVC training already stores. New phase script
  `phases/05b_sovits_finetune.py`, ~30 min on 3090. Deploys to
  `tts-server/models/gptsovits/<voice_id>/` and updates manifest.

### Phase 3 — Superadmin UX overhaul

- Tabs per engine in the TTS Voices panel
- Multi-ref upload + tag per voice
- Inline editor for emotion presets (knobs above)
- Default-engine selector per voice
- Per-voice "Test" button with live preview
- Existing Train RVC action stays; Fine-tune SoVITS action added

### Phase 4 — Frontend TTS card expressive controls

- Engine dropdown (default / per-engine picker)
- Emotion override (auto-detect / force specific)
- Tooltip showing which refs will be used for the current text
- Everything routes through the same expression preprocessor

## Latency budget

Target: <10 s for a typical Discord TTS turn, <5 s for short messages.

Current: 2–3 s Chatterbox + 0.2 s RVC. Segmented synth adds linear cost
per segment; 2–3 segments stays well under 10 s. Regenerate (3 takes)
runs sequentially with cache eviction to stay GPU-safe; user sees
results as they complete.

## Training still hands-off

All new training pipelines (SoVITS fine-tune) reuse the existing
Claude-Code-driven automation:

- Dataset comes from Phase 6 archive (already saved per voice)
- One-click per voice in superadmin
- Progress + ETA via remote train-log tail (infra already shipped)
- Training-mode hook drops GPU caches during any training job
  (`/admin/training-mode`)

## Open questions (see council doc)

- Drop RVC once the base TTS is expressive enough?
- Single long multi-emotion reference vs multiple short tagged refs?
- Streaming synth — can F5 / SoVITS stream chunks?
- Phoneme-level SSML-style control — any engine supporting it?

## Milestones

1. P1a + P1b + P1c + P1d + regenerate → expressive Chatterbox +
   superadmin upload UI. Ship, test on `gilbert_godfrey` + the
   finishing `gilbert_yell`.
2. P2a F5-TTS — new engine, no new training.
3. P2b GPT-SoVITS zero-shot — new engine, no new training.
4. P2c SoVITS fine-tune pipeline — one-click retraining.
5. Phase 3 + 4 UX finishing.
