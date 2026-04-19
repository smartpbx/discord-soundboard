"""Chatterbox TTS engine — zero-shot voice cloning from reference audio.

Uses a 5-10 second reference clip to clone a celebrity's voice including
their prosody (speech rhythm, emphasis, pauses), not just timbre.
"""

import io
import os
import json
import logging

import torch
import torchaudio as ta

log = logging.getLogger("tts-server")

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "chatterbox")

_model = None
# Conditionals are keyed by (voice_id, emotion) so per-emotion reference
# clips each get their own cached prepared state. "neutral" is the legacy
# single-ref key and also the fallback when no emotion-specific ref exists.
_conditionals = {}  # (voice_id, emotion) -> pre-computed conditionals

# Emotions we look for in a voice's refs/ subdirectory. Missing ones fall
# back to "neutral" (the legacy reference.wav).
EMOTION_REFS = ("soft", "neutral", "excited", "yell", "angry", "sad", "happy")


def _get_model():
    """Load Chatterbox model (cached singleton)."""
    global _model
    if _model is not None:
        return _model

    from chatterbox.tts import ChatterboxTTS

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info("Loading Chatterbox model (first request may download ~2GB)...")
    _model = ChatterboxTTS.from_pretrained(device=device)
    log.info("Chatterbox model loaded (device=%s, sr=%d)", device, _model.sr)
    return _model


def _get_conditionals(voice_id: str, ref_path: str, emotion: str = "neutral"):
    """Pre-compute and cache voice conditionals for faster repeated synthesis.

    Keyed by (voice_id, emotion) so a voice with refs/angry.wav + refs/sad.wav
    gets one prepared state per emotion rather than clobbering one cache slot.
    """
    key = (voice_id, emotion)
    if key in _conditionals:
        return _conditionals[key]

    model = _get_model()
    log.info("Pre-computing conditionals for %s [%s] from %s", voice_id, emotion, ref_path)
    conds = model.prepare_conditionals(ref_path, exaggeration=0.5)
    _conditionals[key] = conds
    return conds


def _scan_voices():
    """Scan models/chatterbox/ for voice directories with reference.wav + metadata.json."""
    if not os.path.isdir(MODELS_DIR):
        return []

    voices = []
    for entry in sorted(os.listdir(MODELS_DIR)):
        voice_dir = os.path.join(MODELS_DIR, entry)
        if not os.path.isdir(voice_dir):
            continue

        ref_path = os.path.join(voice_dir, "reference.wav")
        meta_path = os.path.join(voice_dir, "metadata.json")

        if not os.path.exists(ref_path):
            continue

        # Load metadata or use defaults
        meta = {"name": entry.replace("_", " ").title(), "gender": "unknown", "group": "Celebrity"}
        if os.path.exists(meta_path):
            try:
                with open(meta_path) as f:
                    meta.update(json.load(f))
            except Exception:
                pass

        voice = {
            "id": f"cb_{entry}",
            "name": meta.get("name", entry),
            "engine": "chatterbox",
            "gender": meta.get("gender", "unknown"),
            "language": "en-us",
            "group": meta.get("group", "Celebrity"),
            "_ref_path": ref_path,
            "_dir": entry,
            "_skip_rvc": meta.get("skip_rvc", False),
        }
        for key in ("source_kind", "source_url", "source_filename", "source_start", "source_end", "updated_at"):
            if key in meta:
                voice[key] = meta[key]
        try:
            de = float(meta.get("default_exaggeration", 0.5))
            if 0.25 <= de <= 2.0:
                voice["default_exaggeration"] = round(de, 2)
        except (TypeError, ValueError):
            pass
        # Emotion-tagged reference clips (refs/<emotion>.wav).
        refs_dir = os.path.join(voice_dir, "refs")
        emo_refs = []
        if os.path.isdir(refs_dir):
            for emo in EMOTION_REFS:
                if os.path.exists(os.path.join(refs_dir, f"{emo}.wav")):
                    emo_refs.append(emo)
        voice["emotion_refs"] = emo_refs
        voices.append(voice)

    return voices


# Cache the voice list (refreshed on restart)
_voices_cache = None


def get_voices():
    """Return list of available Chatterbox voice dicts for the /voices endpoint."""
    global _voices_cache
    if _voices_cache is None:
        _voices_cache = _scan_voices()
        log.info("Chatterbox: found %d voice(s)", len(_voices_cache))
    return _voices_cache


def get_voice_ids():
    """Return set of valid Chatterbox voice IDs."""
    return {v["id"] for v in get_voices()}


def invalidate_voice(voice_id: str = None):
    """Drop cached voice list and pre-computed conditionals for a voice.

    Called after a reference clip changes on disk so the new audio is picked up.
    """
    global _voices_cache
    _voices_cache = None
    if voice_id:
        _conditionals.pop(voice_id, None)
    else:
        _conditionals.clear()


def free_caches():
    """Evict the Chatterbox model + cached conditionals from GPU memory.

    Called when the pipeline enters training mode — the ~2 GB Chatterbox
    model is the biggest TTS-side tenant of the 3090 other than RVC. Next
    /synthesize call will lazily reload (adds ~5 s latency once).
    """
    global _model
    log.info("Chatterbox: freeing model + %d cached conditionals", len(_conditionals))
    _model = None
    _conditionals.clear()
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception as e:
        log.warning("Chatterbox: empty_cache failed: %s", e)


def get_models_dir() -> str:
    return MODELS_DIR


def should_skip_rvc(voice_id: str) -> bool:
    """Check if a voice has RVC refinement disabled (e.g. cartoon voices)."""
    for v in get_voices():
        if v["id"] == voice_id:
            return v.get("_skip_rvc", False)
    return False


def get_ref_path(voice_id: str, emotion: str = "neutral") -> str:
    """Get the reference audio path for a voice, optionally per-emotion.

    Lookup order:
      1. models/chatterbox/<voice>/refs/<emotion>.wav  (per-emotion)
      2. models/chatterbox/<voice>/reference.wav        (legacy single ref)
    """
    vid = voice_id.replace("cb_", "", 1)
    voice_dir = os.path.join(MODELS_DIR, vid)
    if emotion and emotion != "neutral":
        per_emo = os.path.join(voice_dir, "refs", f"{emotion}.wav")
        if os.path.exists(per_emo):
            return per_emo
    neutral_per_emo = os.path.join(voice_dir, "refs", "neutral.wav")
    if os.path.exists(neutral_per_emo):
        return neutral_per_emo
    legacy = os.path.join(voice_dir, "reference.wav")
    if os.path.exists(legacy):
        return legacy
    raise FileNotFoundError(f"Reference audio not found for {voice_id} ({emotion})")


def list_refs(voice_id: str) -> dict:
    """Return {emotion: path} for every ref present for this voice.

    Includes the legacy reference.wav as 'neutral' if no refs/ dir exists.
    """
    vid = voice_id.replace("cb_", "", 1)
    voice_dir = os.path.join(MODELS_DIR, vid)
    refs = {}
    refs_dir = os.path.join(voice_dir, "refs")
    if os.path.isdir(refs_dir):
        for emo in EMOTION_REFS:
            p = os.path.join(refs_dir, f"{emo}.wav")
            if os.path.exists(p):
                refs[emo] = p
    if "neutral" not in refs:
        legacy = os.path.join(voice_dir, "reference.wav")
        if os.path.exists(legacy):
            refs["neutral"] = legacy
    return refs


def synthesize(
    text: str,
    voice_id: str,
    exaggeration: float = 0.5,
    cfg_weight: float = 0.5,
    temperature: float = 0.8,
    emotion: str = "neutral",
    seed: int = None,
) -> bytes:
    """Generate speech cloning the reference voice. Returns WAV bytes.

    Args:
        text: Text to speak
        voice_id: Chatterbox voice ID (cb_trump, cb_obama, etc.)
        exaggeration: Emotion intensity (0.25=calm, 0.5=neutral, 2.0=very expressive)
        cfg_weight: How strictly to follow the reference prosody (0.3-0.8, lower=more variation)
        temperature: Sampling randomness (0.6-1.0, lower=more deterministic)
        emotion: Which emotion-tagged reference clip to use (falls back to neutral/legacy)
        seed: Optional torch seed for reproducible takes (used by regenerate button)
    """
    model = _get_model()
    ref_path = get_ref_path(voice_id, emotion=emotion)

    log.info("Chatterbox synthesize: voice=%s emotion=%s ref=%s exag=%.2f cfg=%.2f temp=%.2f text_len=%d",
             voice_id, emotion, os.path.basename(ref_path), exaggeration, cfg_weight, temperature, len(text))

    if seed is not None:
        try:
            torch.manual_seed(int(seed))
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(int(seed))
        except Exception as e:
            log.warning("Chatterbox: failed to set seed %s: %s", seed, e)

    with torch.inference_mode():
        wav = model.generate(
            text,
            audio_prompt_path=ref_path,
            exaggeration=exaggeration,
            cfg_weight=cfg_weight,
            temperature=temperature,
        )

    # Convert tensor to WAV bytes using soundfile (avoids torchcodec dependency)
    import soundfile as sf
    import numpy as np

    audio_np = wav.squeeze(0).cpu().numpy()
    buf = io.BytesIO()
    sf.write(buf, audio_np, model.sr, format="WAV")
    buf.seek(0)
    return buf.getvalue()
