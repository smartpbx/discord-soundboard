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
_conditionals = {}  # cache: voice_id -> pre-computed conditionals


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


def _get_conditionals(voice_id: str, ref_path: str):
    """Pre-compute and cache voice conditionals for faster repeated synthesis."""
    if voice_id in _conditionals:
        return _conditionals[voice_id]

    model = _get_model()
    log.info("Pre-computing conditionals for %s from %s", voice_id, ref_path)
    conds = model.prepare_conditionals(ref_path, exaggeration=0.5)
    _conditionals[voice_id] = conds
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


def get_models_dir() -> str:
    return MODELS_DIR


def should_skip_rvc(voice_id: str) -> bool:
    """Check if a voice has RVC refinement disabled (e.g. cartoon voices)."""
    for v in get_voices():
        if v["id"] == voice_id:
            return v.get("_skip_rvc", False)
    return False


def get_ref_path(voice_id: str) -> str:
    """Get the reference audio path for a voice ID."""
    vid = voice_id.replace("cb_", "", 1)
    ref = os.path.join(MODELS_DIR, vid, "reference.wav")
    if os.path.exists(ref):
        return ref
    raise FileNotFoundError(f"Reference audio not found: {ref}")


def synthesize(text: str, voice_id: str, exaggeration: float = 0.5) -> bytes:
    """Generate speech cloning the reference voice. Returns WAV bytes.

    Args:
        text: Text to speak
        voice_id: Chatterbox voice ID (cb_trump, cb_obama, etc.)
        exaggeration: Emotion intensity (0.25=calm, 0.5=neutral, 2.0=very expressive)
    """
    model = _get_model()
    ref_path = get_ref_path(voice_id)

    log.info("Chatterbox synthesize: voice=%s exaggeration=%.2f text_len=%d",
             voice_id, exaggeration, len(text))

    with torch.inference_mode():
        wav = model.generate(
            text,
            audio_prompt_path=ref_path,
            exaggeration=exaggeration,
            cfg_weight=0.5,
            temperature=0.8,
        )

    # Convert tensor to WAV bytes using soundfile (avoids torchcodec dependency)
    import soundfile as sf
    import numpy as np

    audio_np = wav.squeeze(0).cpu().numpy()
    buf = io.BytesIO()
    sf.write(buf, audio_np, model.sr, format="WAV")
    buf.seek(0)
    return buf.getvalue()
