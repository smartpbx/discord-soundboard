"""RVC v2 voice conversion engine. Converts base TTS audio to a target voice."""

import os
import json
import tempfile
import logging

log = logging.getLogger("tts-server")

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "rvc")
MANIFEST_PATH = os.path.join(MODELS_DIR, "manifest.json")

_converter = None


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


def _save_manifest(entries):
    os.makedirs(MODELS_DIR, exist_ok=True)
    with open(MANIFEST_PATH, "w") as f:
        json.dump(entries, f, indent=2)


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


def convert(audio_bytes: bytes, rvc_model_id: str) -> bytes:
    """Convert audio to target voice using RVC. Returns WAV bytes."""
    # Strip the rvc_ prefix to get the manifest ID
    model_id = rvc_model_id.replace("rvc_", "", 1)
    manifest = _load_manifest()
    entry = next((e for e in manifest if e["id"] == model_id), None)
    if not entry:
        raise ValueError(f"RVC model not found: {model_id}")

    pth_path = os.path.join(MODELS_DIR, entry["pth"])
    index_path = os.path.join(MODELS_DIR, entry["index"]) if entry.get("index") else None

    if not os.path.exists(pth_path):
        raise FileNotFoundError(f"Model file not found: {pth_path}")
    if index_path and not os.path.exists(index_path):
        index_path = None

    # Write input audio to temp file, run RVC, read output
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as inf:
        inf.write(audio_bytes)
        input_path = inf.name

    output_path = input_path.replace(".wav", "_rvc.wav")

    try:
        from rvc_python import RVCInference

        global _converter
        if _converter is None:
            _converter = RVCInference(device="cuda:0" if _has_cuda() else "cpu")

        _converter.set_params(
            f0method="rmvpe",
            f0up_key=0,
            index_rate=0.75 if index_path else 0,
            filter_radius=3,
            rms_mix_rate=0.25,
            protect=0.33,
        )
        _converter.load_model(pth_path, index_path=index_path)
        _converter.infer_file(input_path, output_path)

        with open(output_path, "rb") as f:
            return f.read()
    finally:
        for p in [input_path, output_path]:
            try:
                os.unlink(p)
            except OSError:
                pass


def _has_cuda():
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False
