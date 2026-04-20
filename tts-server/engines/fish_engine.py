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
from typing import Optional

import requests

try:
    import ormsgpack  # fish-speech requires msgpack-encoded request body
except ImportError:
    ormsgpack = None

log = logging.getLogger("tts-server")

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "fish")
API_URL = os.environ.get("FISH_API_URL", "http://localhost:8881").rstrip("/")
_SYNTH_TIMEOUT = 120

# Emotions we look for in a voice's refs/ subdirectory. Missing ones fall
# back to "neutral" (the legacy reference.wav). Same set as Chatterbox so
# the auto-pick librosa scorer can target both engines with one pass.
EMOTION_REFS = ("soft", "neutral", "excited", "yell", "angry", "sad", "happy")

# Map our preset emotions to Fish's native inline markers. S2 Pro uses
# [tag] syntax (square brackets — see its README) and supports 15,000+
# free-form descriptors; these are just the canonical short forms we
# reach for when the segmenter assigns a broad preset emotion. Users can
# type arbitrary tags directly (e.g. "[professional broadcast tone]") in
# the message text and those flow through untouched.
EMOTION_TAGS = {
    "soft":    "[whisper]",
    "neutral": "",
    "excited": "[excited]",
    "yell":    "[shouting]",
    "angry":   "[angry]",
    "sad":     "[sad]",
    "happy":   "[laughing]",
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
        # Emotion-tagged reference clips at refs/<emotion>.wav — optional, fall
        # back to the legacy reference.wav when a specific emotion isn't present.
        refs_dir = os.path.join(voice_dir, "refs")
        emo_refs = []
        if os.path.isdir(refs_dir):
            for emo in EMOTION_REFS:
                if os.path.exists(os.path.join(refs_dir, f"{emo}.wav")):
                    emo_refs.append(emo)
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
            "_skip_rvc": meta.get("skip_rvc", False),
            "_rvc_model_id": meta.get("rvc_model_id"),
            "rvc_model_id": meta.get("rvc_model_id"),
            "skip_rvc": meta.get("skip_rvc", False),
            "emotion_refs": emo_refs,
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


def should_skip_rvc(voice_id: str) -> bool:
    """Per-voice opt-out from Fish→RVC refinement (stored as skip_rvc in
    metadata.json). Matches chatterbox_engine's API for parity."""
    for v in get_voices():
        if v["id"] == voice_id:
            return v.get("_skip_rvc", False)
    return False


def get_rvc_model_id(voice_id: str) -> Optional[str]:
    """Return the explicit rvc_model_id set in a Fish voice's metadata, or
    None to fall back to the stem-match convention (fish_x → rvc_x)."""
    for v in get_voices():
        if v["id"] == voice_id:
            return v.get("_rvc_model_id")
    return None


def _find_voice(voice_id: str) -> dict:
    for v in get_voices():
        if v["id"] == voice_id:
            return v
    raise ValueError(f"Unknown Fish voice: {voice_id}")


def get_ref_for_emotion(voice_id: str, emotion: str = "neutral"):
    """Pick the best reference (wav_path, ref_text) for this voice+emotion.

    Fish's API needs BOTH the reference audio and its transcript, so this
    returns the pair. Per-emotion clips live at refs/<emotion>.wav with an
    adjacent refs/<emotion>.txt (Whisper-generated on upload). Falls back
    through: specific emotion → neutral → legacy reference.wav + metadata
    ref_text. Guarantees something usable for every known voice.
    """
    voice = _find_voice(voice_id)
    vid = voice["_dir"]
    voice_dir = os.path.join(MODELS_DIR, vid)

    def _pick(name):
        wav = os.path.join(voice_dir, "refs", f"{name}.wav")
        if not os.path.exists(wav): return None
        txt = os.path.join(voice_dir, "refs", f"{name}.txt")
        text = ""
        if os.path.exists(txt):
            try: text = open(txt).read().strip()
            except Exception: pass
        return (wav, text or voice["_ref_text"])

    if emotion and emotion != "neutral":
        hit = _pick(emotion)
        if hit: return hit
    hit = _pick("neutral")
    if hit: return hit
    # Legacy reference.wav + metadata.ref_text
    return (voice["_ref_path"], voice["_ref_text"])


def list_refs(voice_id: str) -> dict:
    """Return {emotion: {path, text}} for every emotion-specific ref on disk.
    Used by the /admin/voices/fish/<id>/refs endpoint for UI + auto-pick."""
    voice = _find_voice(voice_id)
    voice_dir = os.path.join(MODELS_DIR, voice["_dir"])
    refs_dir = os.path.join(voice_dir, "refs")
    out = {}
    if os.path.isdir(refs_dir):
        for emo in EMOTION_REFS:
            wav = os.path.join(refs_dir, f"{emo}.wav")
            if not os.path.exists(wav): continue
            txt = os.path.join(refs_dir, f"{emo}.txt")
            text = ""
            if os.path.exists(txt):
                try: text = open(txt).read().strip()
                except Exception: pass
            out[emo] = {"path": wav, "text": text}
    return out


def get_models_dir() -> str:
    return MODELS_DIR


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
    ref_wav, ref_text = get_ref_for_emotion(voice_id, emotion)
    ref_note = "refs/" + emotion if ref_wav != voice["_ref_path"] and emotion != "neutral" else "legacy"
    log.info("Fish synthesize: voice=%s emotion=%s ref=%s text_len=%d preview=%.60s",
             voice_id, emotion, ref_note, len(decorated), decorated)
    with open(ref_wav, "rb") as f:
        audio_bytes = f.read()
    payload = {
        "text": decorated,
        "format": "wav",
        "references": [{
            "audio": audio_bytes,
            "text": ref_text,
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
    # Fish ships at noticeably lower loudness than Chatterbox/RVC outputs, so
    # the soundboard's volume slider has to be cranked. Apply a peak-normalize
    # pass to bring it in line with the other engines (-1 dBFS ceiling, no
    # compression — keeps the dynamic range Fish chose intact).
    try:
        wav_bytes = _peak_normalize(wav_bytes, target_dbfs=-1.0)
    except Exception as e:
        log.warning("Fish post-synth normalize failed (returning raw): %s", e)
    return wav_bytes


def _peak_normalize(wav_bytes: bytes, target_dbfs: float = -1.0) -> bytes:
    """Boost a WAV blob so its peak hits target_dbfs. Pure NumPy — no ffmpeg
    spin-up cost. Returns original bytes if peak is already ≥ target."""
    import io as _io
    import soundfile as _sf
    import numpy as _np
    data, sr = _sf.read(_io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
    peak = float(_np.max(_np.abs(data))) if data.size else 0.0
    if peak <= 0.0:
        return wav_bytes  # silent — nothing to scale
    target_lin = 10 ** (target_dbfs / 20.0)
    gain = target_lin / peak
    if gain <= 1.05:
        return wav_bytes  # already loud enough; don't waste cycles
    boosted = _np.clip(data * gain, -1.0, 1.0)
    buf = _io.BytesIO()
    _sf.write(buf, boosted, sr, format="WAV")
    return buf.getvalue()
