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
import threading

import requests

log = logging.getLogger("tts-server")

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "gptsovits")
API_URL = os.environ.get("GPT_SOVITS_URL", "http://localhost:9880").rstrip("/")

# Timeout for synthesis requests (seconds) — GPT-SoVITS can be slow on long text
_SYNTH_TIMEOUT = 120
_DEFAULT_GPT_MODEL = os.environ.get("GPT_SOVITS_DEFAULT_GPT_MODEL") or None
_DEFAULT_SOVITS_MODEL = os.environ.get("GPT_SOVITS_DEFAULT_SOVITS_MODEL") or None
_MODEL_SWITCH_LOCK = threading.Lock()
_UNKNOWN_MODEL_KEY = object()
_active_model_key = (_DEFAULT_GPT_MODEL, _DEFAULT_SOVITS_MODEL)


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
            "source_kind": meta.get("source_kind"),
            "source_url": meta.get("source_url"),
            "source_filename": meta.get("source_filename"),
            "source_start": meta.get("source_start"),
            "source_end": meta.get("source_end"),
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


def invalidate_loaded_weights():
    """Reset local switch tracking after the external service is restarted."""
    global _active_model_key
    with _MODEL_SWITCH_LOCK:
        _active_model_key = (_DEFAULT_GPT_MODEL, _DEFAULT_SOVITS_MODEL)


def requires_default_reset(voice_id: str) -> bool:
    """Return whether this voice needs a service restart to restore defaults."""
    voice = _find_voice(voice_id)
    desired = (
        voice.get("_gpt_model") or _DEFAULT_GPT_MODEL,
        voice.get("_sovits_model") or _DEFAULT_SOVITS_MODEL,
    )
    with _MODEL_SWITCH_LOCK:
        current = _active_model_key
        if current is _UNKNOWN_MODEL_KEY:
            return any(path is None for path in desired)
        return any(wanted is None and loaded is not None for wanted, loaded in zip(desired, current))


def _switch_weight(component: str, path: str):
    endpoint = "set_gpt_weights" if component == "GPT" else "set_sovits_weights"
    resp = requests.post(f"{API_URL}/{endpoint}", json={"weights_path": path}, timeout=30)
    resp.raise_for_status()
    log.info("GPT-SoVITS: switched %s model to %s", component, path)


def _set_model(voice: dict):
    """Atomically select the exact GPT/SoVITS weight pair for a voice."""
    global _active_model_key
    desired = (
        voice.get("_gpt_model") or _DEFAULT_GPT_MODEL,
        voice.get("_sovits_model") or _DEFAULT_SOVITS_MODEL,
    )
    current = _active_model_key
    if desired == current:
        return

    labels = ("GPT", "SoVITS")
    # A missing desired path means "service startup default". Once that
    # component has been changed, it cannot be restored safely without an
    # explicit default path.
    for label, wanted, loaded in zip(labels, desired, current if current is not _UNKNOWN_MODEL_KEY else (None, None)):
        if wanted is None and (current is _UNKNOWN_MODEL_KEY or loaded is not None):
            raise RuntimeError(
                f"Cannot restore the default {label} weights for {voice['id']}; "
                f"set GPT_SOVITS_DEFAULT_{label.upper()}_MODEL or add an explicit model path"
            )

    try:
        for label, wanted, loaded in zip(
            labels,
            desired,
            current if current is not _UNKNOWN_MODEL_KEY else (_UNKNOWN_MODEL_KEY, _UNKNOWN_MODEL_KEY),
        ):
            if wanted is not None and wanted != loaded:
                _switch_weight(label, wanted)
    except Exception:
        # A partial switch leaves the remote process in an unknown mixed state.
        # Fail closed and force both paths to be supplied on the next attempt.
        _active_model_key = _UNKNOWN_MODEL_KEY
        raise

    _active_model_key = desired


def synthesize(text: str, voice_id: str) -> bytes:
    """Generate speech via GPT-SoVITS API. Returns WAV bytes."""
    voice = _find_voice(voice_id)

    log.info("GPT-SoVITS synthesize: voice=%s text_len=%d text_preview=%.60s",
             voice_id, len(text), text)

    # Keep model selection and synthesis in one critical section: otherwise a
    # concurrent request can switch weights between this request's switch and
    # its /tts call.
    with _MODEL_SWITCH_LOCK:
        _set_model(voice)

        # GPT-SoVITS v2 API: POST with reference audio path, ref text, and target text
        payload = {
            "ref_audio_path": voice["_ref_path"],
            "prompt_text": voice["_ref_text"],
            "prompt_lang": voice.get("language", "en"),
            "text": text,
            "text_lang": voice.get("language", "en"),
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
