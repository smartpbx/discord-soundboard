"""GPT-SoVITS TTS engine — voice cloning via an external GPT-SoVITS API server.

Each voice needs a directory under models/gptsovits/<voice_name>/ containing:
  - reference.wav   — 3-10 second reference audio clip
  - metadata.json   — voice config (name, gender, group, ref_text, plus optional
                       gpt_model / sovits_model paths for per-voice model switching)

The engine calls the GPT-SoVITS API (default http://localhost:9880) which must be
running separately.  Set GPT_SOVITS_URL in .env to override.
"""

import io
import os
import json
import logging

import requests

log = logging.getLogger("tts-server")

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "gptsovits")
API_URL = os.environ.get("GPT_SOVITS_URL", "http://localhost:9880").rstrip("/")

# Timeout for synthesis requests (seconds) — GPT-SoVITS can be slow on long text
_SYNTH_TIMEOUT = 120


def _scan_voices():
    """Scan models/gptsovits/ for voice directories with reference.wav + metadata.json."""
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

        # metadata.json is required for GPT-SoVITS (need ref_text at minimum)
        meta = {"name": entry.replace("_", " ").title(), "gender": "unknown", "group": "Celebrity"}
        if os.path.exists(meta_path):
            try:
                with open(meta_path) as f:
                    meta.update(json.load(f))
            except Exception:
                pass

        if "ref_text" not in meta:
            log.warning("gptsovits: skipping %s — metadata.json missing ref_text", entry)
            continue

        voices.append({
            "id": f"gsv_{entry}",
            "name": meta.get("name", entry),
            "engine": "gptsovits",
            "gender": meta.get("gender", "unknown"),
            "language": meta.get("language", "en"),
            "group": meta.get("group", "Celebrity"),
            "_ref_path": ref_path,
            "_ref_text": meta["ref_text"],
            "_dir": entry,
            "_gpt_model": meta.get("gpt_model"),
            "_sovits_model": meta.get("sovits_model"),
        })

    return voices


_voices_cache = None


def get_voices():
    """Return list of available GPT-SoVITS voice dicts."""
    global _voices_cache
    if _voices_cache is None:
        _voices_cache = _scan_voices()
        log.info("GPT-SoVITS: found %d voice(s)", len(_voices_cache))
    return _voices_cache


def get_voice_ids():
    """Return set of valid GPT-SoVITS voice IDs."""
    return {v["id"] for v in get_voices()}


def _find_voice(voice_id: str) -> dict:
    """Look up a voice by ID, raise if not found."""
    for v in get_voices():
        if v["id"] == voice_id:
            return v
    raise ValueError(f"Unknown GPT-SoVITS voice: {voice_id}")


def _set_model(voice: dict):
    """Switch GPT / SoVITS models on the API server if the voice specifies them."""
    gpt = voice.get("_gpt_model")
    sovits = voice.get("_sovits_model")

    if gpt:
        try:
            resp = requests.post(f"{API_URL}/set_gpt_weights", json={"weights_path": gpt}, timeout=30)
            resp.raise_for_status()
            log.info("GPT-SoVITS: switched GPT model to %s", gpt)
        except Exception as e:
            log.warning("GPT-SoVITS: failed to set GPT model %s: %s", gpt, e)

    if sovits:
        try:
            resp = requests.post(f"{API_URL}/set_sovits_weights", json={"weights_path": sovits}, timeout=30)
            resp.raise_for_status()
            log.info("GPT-SoVITS: switched SoVITS model to %s", sovits)
        except Exception as e:
            log.warning("GPT-SoVITS: failed to set SoVITS model %s: %s", sovits, e)


def synthesize(text: str, voice_id: str) -> bytes:
    """Generate speech via GPT-SoVITS API. Returns WAV bytes."""
    voice = _find_voice(voice_id)

    log.info("GPT-SoVITS synthesize: voice=%s text_len=%d text_preview=%.60s",
             voice_id, len(text), text)

    # Switch models if this voice specifies custom weights
    _set_model(voice)

    # Read reference audio as raw bytes for multipart upload
    with open(voice["_ref_path"], "rb") as f:
        ref_audio = f.read()

    # GPT-SoVITS v2 API: POST with reference audio, ref text, and target text
    payload = {
        "refer_wav_path": voice["_ref_path"],
        "prompt_text": voice["_ref_text"],
        "prompt_language": voice.get("language", "en"),
        "text": text,
        "text_language": voice.get("language", "en"),
    }

    try:
        resp = requests.post(f"{API_URL}/tts", json=payload, timeout=_SYNTH_TIMEOUT)
        resp.raise_for_status()
    except requests.ConnectionError:
        raise RuntimeError(
            f"Cannot connect to GPT-SoVITS server at {API_URL}. "
            "Make sure the GPT-SoVITS API server is running."
        )
    except requests.HTTPError as e:
        raise RuntimeError(f"GPT-SoVITS API error: {e} — {resp.text[:200]}")

    content_type = resp.headers.get("content-type", "")
    if "audio" not in content_type and "octet-stream" not in content_type:
        raise RuntimeError(f"GPT-SoVITS returned unexpected content-type: {content_type}")

    wav_bytes = resp.content
    log.info("GPT-SoVITS synthesis complete: %d bytes", len(wav_bytes))
    return wav_bytes
