"""RVC v2 voice conversion engine. Converts base TTS audio to a target voice."""

import os
import json
import tempfile
import logging

log = logging.getLogger("tts-server")

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "rvc")
MANIFEST_PATH = os.path.join(MODELS_DIR, "manifest.json")

_loader = None


def _load_manifest():
    """Load the voice manifest. Each entry: { id, name, group, pth, index (optional) }"""
    if not os.path.exists(MANIFEST_PATH):
        return []
    try:
        with open(MANIFEST_PATH) as f:
            return json.load(f)
    except Exception as e:
        log.error("Failed to load RVC manifest: %s", e)
        return []


def get_voices():
    """Return list of available RVC voice dicts for the /voices endpoint."""
    manifest = _load_manifest()
    voices = []
    for entry in manifest:
        pth_path = os.path.join(MODELS_DIR, entry["pth"])
        if not os.path.exists(pth_path):
            continue
        voices.append({
            "id": f"rvc_{entry['id']}",
            "name": entry.get("name", entry["id"]),
            "engine": "rvc",
            "gender": entry.get("gender", "unknown"),
            "language": "en-us",
            "group": entry.get("group", "Celebrity"),
        })
    return voices


def get_rvc_model_ids():
    """Return set of valid RVC model IDs (with rvc_ prefix)."""
    return {v["id"] for v in get_voices()}


def _has_cuda():
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


def _get_loader():
    """Get or create the BaseLoader singleton."""
    global _loader
    if _loader is None:
        from infer_rvc_python import BaseLoader
        _loader = BaseLoader(only_cpu=not _has_cuda())
        log.info("RVC BaseLoader initialized (cuda=%s)", _has_cuda())
    return _loader


def convert(audio_bytes: bytes, rvc_model_id: str) -> bytes:
    """Convert audio to target voice using RVC. Returns WAV bytes."""
    model_id = rvc_model_id.replace("rvc_", "", 1)
    manifest = _load_manifest()
    entry = next((e for e in manifest if e["id"] == model_id), None)
    if not entry:
        raise ValueError(f"RVC model not found: {model_id}")

    pth_path = os.path.join(MODELS_DIR, entry["pth"])
    index_path = os.path.join(MODELS_DIR, entry["index"]) if entry.get("index") else ""

    if not os.path.exists(pth_path):
        raise FileNotFoundError(f"Model file not found: {pth_path}")
    if index_path and not os.path.exists(index_path):
        index_path = ""

    # Write input audio to temp file (generate_from_cache accepts file paths)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as inf:
        inf.write(audio_bytes)
        input_path = inf.name

    try:
        loader = _get_loader()

        # Register model config with a tag matching the model ID
        tag = f"rvc_{model_id}"
        loader.apply_conf(
            tag=tag,
            file_model=pth_path,
            pitch_algo="rmvpe",
            pitch_lvl=0,
            file_index=index_path,
            index_influence=0.75 if index_path else 0,
            respiration_median_filtering=3,
            envelope_ratio=0.25,
            consonant_breath_protection=0.33,
        )

        # Run voice conversion
        result = loader.generate_from_cache(
            audio_data=input_path,
            tag=tag,
        )

        # Result is a generator yielding (sample_rate, audio_array) or (audio_array, sample_rate)
        import soundfile as sf
        import numpy as np

        segments = list(result)
        if not segments:
            raise RuntimeError("RVC produced no output")

        sr, audio = segments[0]
        # Handle both (sr, audio) and (audio, sr) conventions
        if isinstance(sr, np.ndarray):
            sr, audio = audio, sr

        output_path = input_path.replace(".wav", "_rvc.wav")
        sf.write(output_path, audio, sr)

        with open(output_path, "rb") as f:
            return f.read()
    finally:
        for p in [input_path, input_path.replace(".wav", "_rvc.wav")]:
            try:
                os.unlink(p)
            except OSError:
                pass
