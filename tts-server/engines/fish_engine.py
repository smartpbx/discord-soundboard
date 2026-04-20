"""Fish-Speech (openaudio-s1-mini) engine — voice cloning via the local
fish-speech api_server (systemd unit fish-speech.service on CT 110, port
8881 by default).

Per-voice setup matches Chatterbox: each voice lives at
models/fish/<voice>/ with:
  - reference.wav     — 5-15 s clean clip
  - metadata.json     — { name, gender, group, ref_text, language }

Inline emotion control is native to openaudio-s1-mini via parenthesized
markers ((laughing), (sighing), (whisper), (shouting), etc.) — these can
be embedded directly in the synthesized text. The TTS server's segments
flow translates emotion presets into these tags before calling synthesize.
"""

import io
import os
import json
import logging

import requests

try:
    import ormsgpack  # fish-speech requires msgpack-encoded request body
except ImportError:
    ormsgpack = None

log = logging.getLogger("tts-server")

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "fish")
API_URL = os.environ.get("FISH_API_URL", "http://localhost:8881").rstrip("/")
_SYNTH_TIMEOUT = 120

# Map our preset emotions to Fish's native inline markers. A segment
# tagged "yell" gets prepended with "(shouting) " before being sent.
EMOTION_TAGS = {
    "soft":    "(whispering)",
    "neutral": "",
    "excited": "(excited)",
    "yell":    "(shouting)",
    "angry":   "(angrily)",
    "sad":     "(sadly)",
    "happy":   "(laughing)",
}


def _scan_voices():
    """Scan models/fish/ for voice dirs with reference.wav + metadata.json."""
    if not os.path.isdir(MODELS_DIR):
        return []
    voices = []
    for entry in sorted(os.listdir(MODELS_DIR)):
        voice_dir = os.path.join(MODELS_DIR, entry)
        if not os.path.isdir(voice_dir): continue
        ref_path = os.path.join(voice_dir, "reference.wav")
        meta_path = os.path.join(voice_dir, "metadata.json")
        if not os.path.exists(ref_path): continue
        meta = {"name": entry.replace("_", " ").title(), "gender": "unknown", "group": "Celebrity"}
        if os.path.exists(meta_path):
            try:
                with open(meta_path) as f:
                    meta.update(json.load(f))
            except Exception:
                pass
        if "ref_text" not in meta:
            log.warning("fish: skipping %s — metadata.json missing ref_text", entry)
            continue
        voices.append({
            "id": f"fish_{entry}",
            "name": meta.get("name", entry),
            "engine": "fish",
            "gender": meta.get("gender", "unknown"),
            "language": meta.get("language", "en"),
            "group": meta.get("group", "Celebrity"),
            "_ref_path": ref_path,
            "_ref_text": meta["ref_text"],
            "_dir": entry,
            "source_kind": meta.get("source_kind"),
            "source_url": meta.get("source_url"),
            "source_filename": meta.get("source_filename"),
            "source_start": meta.get("source_start"),
            "source_end": meta.get("source_end"),
        })
    return voices


_voices_cache = None


def get_voices():
    global _voices_cache
    if _voices_cache is None:
        _voices_cache = _scan_voices()
        log.info("Fish: found %d voice(s)", len(_voices_cache))
    return _voices_cache


def get_voice_ids():
    return {v["id"] for v in get_voices()}


def invalidate_cache():
    global _voices_cache
    _voices_cache = None


def free_caches():
    """Fish models live in fish-speech.service's process — nothing to free
    inside tts-server. Provided for parity with chatterbox/rvc engines."""
    pass


def _find_voice(voice_id: str) -> dict:
    for v in get_voices():
        if v["id"] == voice_id:
            return v
    raise ValueError(f"Unknown Fish voice: {voice_id}")


def _decorate_with_emotion(text: str, emotion: str) -> str:
    tag = EMOTION_TAGS.get(emotion or "neutral", "")
    if not tag: return text
    # Prepend the marker; keep the original text intact so prosody isn't broken
    # by tag injection mid-utterance.
    return f"{tag} {text}"


def synthesize(text: str, voice_id: str, emotion: str = "neutral", seed: int = None,
               temperature: float = 0.8, top_p: float = 0.8) -> bytes:
    """Generate speech via fish-speech. Returns WAV bytes."""
    if ormsgpack is None:
        raise RuntimeError("ormsgpack not installed in tts-server venv; pip install ormsgpack")
    voice = _find_voice(voice_id)
    decorated = _decorate_with_emotion(text, emotion)
    log.info("Fish synthesize: voice=%s emotion=%s text_len=%d preview=%.60s",
             voice_id, emotion, len(decorated), decorated)
    with open(voice["_ref_path"], "rb") as f:
        audio_bytes = f.read()
    payload = {
        "text": decorated,
        "format": "wav",
        "references": [{
            "audio": audio_bytes,
            "text": voice["_ref_text"],
        }],
        "temperature": float(max(0.1, min(1.0, temperature))),
        "top_p": float(max(0.1, min(1.0, top_p))),
        "use_memory_cache": "on",  # caches conditionals across calls — big speed win
        "normalize": True,
    }
    if seed is not None:
        payload["seed"] = int(seed)
    body = ormsgpack.packb(payload)
    try:
        resp = requests.post(
            f"{API_URL}/v1/tts",
            data=body,
            headers={"Content-Type": "application/msgpack"},
            timeout=_SYNTH_TIMEOUT,
        )
        resp.raise_for_status()
    except requests.ConnectionError:
        raise RuntimeError(f"Cannot connect to Fish-Speech at {API_URL}. Is fish-speech.service running?")
    except requests.HTTPError as e:
        raise RuntimeError(f"Fish API error: {e} — {resp.text[:200]}")
    if "audio" not in resp.headers.get("content-type", "") and "octet-stream" not in resp.headers.get("content-type", ""):
        raise RuntimeError(f"Fish returned unexpected content-type: {resp.headers.get('content-type')}")
    wav_bytes = resp.content
    log.info("Fish synthesis complete: %d bytes", len(wav_bytes))
    return wav_bytes
