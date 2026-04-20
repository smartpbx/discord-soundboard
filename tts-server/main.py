"""TTS Service -- FastAPI app exposing Kokoro + Chatterbox + RVC + GPT-SoVITS for the Discord soundboard."""

import io
import json
import os
import re
import shutil
import time
import logging
from typing import Optional

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts-server")

app = FastAPI(title="TTS Service", version="2.0.0")

# ---------------------------------------------------------------------------
# Engine loading (lazy -- first request triggers model load)
# ---------------------------------------------------------------------------

from engines import kokoro_engine, rvc_engine, chatterbox_engine, gptsovits_engine, fish_engine  # noqa: E402


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class SegmentSpec(BaseModel):
    """One text segment + its emotion routing info.

    The soundboard preprocesses text into segments (lib/tts-expression.js) so
    each piece can be synthesized with its own reference clip + preset. When
    the caller sends `segments`, the top-level `text` field is ignored for
    Chatterbox; segments are concatenated with optional inter-segment gaps.
    """
    text: str = Field(..., min_length=1, max_length=2000)
    emotion: str = "neutral"      # soft / neutral / excited / yell / angry / sad / happy
    intensity: float = 0.5         # 0..1, scales the preset's exaggeration
    pause_ms_after: int = 0        # silence gap after this segment (0–2000 ms)
    # Explicit overrides (rare) — if set, these win over the preset for this segment
    exaggeration: Optional[float] = None
    cfg_weight: Optional[float] = None
    temperature: Optional[float] = None


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice_id: str = Field(..., min_length=1)
    rvc_model_id: Optional[str] = None
    use_rvc: bool = True  # When True, pipe Chatterbox output through RVC if available
    exaggeration: float = Field(0.5, ge=0.25, le=2.0)  # Legacy top-level knob
    cfg_weight: Optional[float] = None      # 0.3–0.8; falls back to preset/default
    temperature: Optional[float] = None     # 0.6–1.0; falls back to preset/default
    seed: Optional[int] = None              # for "regenerate 3 takes" flow
    # Pre-segmented input from the Node-side emotion preprocessor. When present,
    # server synthesizes each segment with its own preset and stitches.
    segments: Optional[list[SegmentSpec]] = None


# Per-emotion preset bundles (exag / cfg_weight / temperature). The
# segment's `intensity` (0..1) scales exaggeration within the preset's
# range so a mild yell isn't as cranked as an unhinged one.
EMOTION_PRESETS = {
    "soft":    {"exaggeration": 0.35, "cfg_weight": 0.55, "temperature": 0.7, "exag_max": 0.55},
    "neutral": {"exaggeration": 0.50, "cfg_weight": 0.50, "temperature": 0.8, "exag_max": 0.75},
    "excited": {"exaggeration": 1.20, "cfg_weight": 0.42, "temperature": 0.9, "exag_max": 1.50},
    "yell":    {"exaggeration": 1.70, "cfg_weight": 0.35, "temperature": 0.95, "exag_max": 2.00},
    "angry":   {"exaggeration": 1.80, "cfg_weight": 0.30, "temperature": 0.95, "exag_max": 2.00},
    "sad":     {"exaggeration": 0.45, "cfg_weight": 0.55, "temperature": 0.75, "exag_max": 0.70},
    "happy":   {"exaggeration": 0.95, "cfg_weight": 0.45, "temperature": 0.85, "exag_max": 1.30},
}


def _resolve_segment_params(seg: SegmentSpec):
    """Collapse emotion + intensity + explicit overrides → final synth params."""
    preset = EMOTION_PRESETS.get(seg.emotion, EMOTION_PRESETS["neutral"])
    # Linear interpolation between preset base and exag_max based on intensity
    base = preset["exaggeration"]
    top = preset.get("exag_max", base + 0.25)
    t = max(0.0, min(1.0, float(seg.intensity or 0.5)))
    exag = base + (top - base) * t
    cfg = preset["cfg_weight"]
    temp = preset["temperature"]
    if seg.exaggeration is not None: exag = float(seg.exaggeration)
    if seg.cfg_weight is not None: cfg = float(seg.cfg_weight)
    if seg.temperature is not None: temp = float(seg.temperature)
    # Clamp
    exag = max(0.25, min(2.0, exag))
    cfg = max(0.25, min(0.9, cfg))
    temp = max(0.5, min(1.1, temp))
    return exag, cfg, temp


class HealthResponse(BaseModel):
    status: str
    engines: list[str]


class VoiceInfo(BaseModel):
    id: str
    name: str
    engine: str
    gender: str
    language: str
    group: str
    source_kind: Optional[str] = None
    source_url: Optional[str] = None
    source_filename: Optional[str] = None
    source_start: Optional[float] = None
    source_end: Optional[float] = None
    updated_at: Optional[int] = None
    default_exaggeration: Optional[float] = None
    # Per-emotion reference clips present on disk (subset of soft, neutral,
    # excited, yell, angry, sad, happy). Missing emotions fall back to neutral
    # then to the legacy reference.wav at synth time.
    emotion_refs: Optional[list[str]] = None


# ---------------------------------------------------------------------------
# Training mode — drops big model caches during RVC training so the 3090
# doesn't OOM. Set via POST /admin/training-mode. While active, synthesize
# calls return 503 (voice LISTING still works — the soundboard UI stays
# functional; only synth is paused).
# ---------------------------------------------------------------------------
import threading

_TRAINING_MODE = False
_TRAINING_MODE_SINCE = None
# Serialize synth calls while training is active so only ONE set of model
# weights is ever resident in VRAM at a time. Concurrent lazy-loads from
# parallel synth requests would race for headroom and OOM the GPU.
_TRAINING_SYNTH_LOCK = threading.Lock()
_TRAINING_SYNTH_TIMEOUT_SEC = 30


class TrainingModeRequest(BaseModel):
    active: bool
    reason: Optional[str] = None


@app.post("/admin/training-mode")
def set_training_mode(req: TrainingModeRequest):
    global _TRAINING_MODE, _TRAINING_MODE_SINCE
    if req.active:
        if not _TRAINING_MODE:
            log.info("Entering training mode (%s) — freeing GPU caches", req.reason or "no reason given")
            try: chatterbox_engine.free_caches()
            except Exception as e: log.warning("chatterbox free_caches failed: %s", e)
            try: rvc_engine.free_caches()
            except Exception as e: log.warning("rvc free_caches failed: %s", e)
        _TRAINING_MODE = True
        _TRAINING_MODE_SINCE = time.time()
    else:
        if _TRAINING_MODE:
            log.info("Leaving training mode (%s) — caches will lazy-reload on next synth", req.reason or "no reason given")
        _TRAINING_MODE = False
        _TRAINING_MODE_SINCE = None
    return {"training_mode": _TRAINING_MODE, "since": _TRAINING_MODE_SINCE}


@app.get("/admin/training-mode")
def get_training_mode():
    return {"training_mode": _TRAINING_MODE, "since": _TRAINING_MODE_SINCE}


@app.get("/admin/emotion-presets")
def get_emotion_presets():
    """Return the server-side emotion preset bundles so the superadmin UI
    can display defaults + let operators override per-voice."""
    return {"presets": EMOTION_PRESETS}


# ---------------------------------------------------------------------------
# GPT-SoVITS voice bootstrapping from an existing Chatterbox voice.
#
# Creates a matching gsv_<voice> by trimming the Chatterbox reference to
# ~8 s (GSV requires 3–10 s refs) and Whisper-transcribing it so the
# engine has a prompt_text. One-click hands-off conversion so every
# trained voice gets a second engine to A/B against.
# ---------------------------------------------------------------------------
import subprocess

class CloneToGsvRequest(BaseModel):
    trim_start_sec: float = 0.0
    trim_length_sec: float = 8.0


async def _ensure_engine_dir(engine: str, voice_id: str):
    if engine not in ("gptsovits", "fish"):
        raise HTTPException(status_code=400, detail="Unsupported engine")
    dir_id = _normalize_voice_dir_id(voice_id)
    base = os.path.join(os.path.dirname(__file__), "models", engine, dir_id)
    return dir_id, base


def _engine_invalidate(engine: str):
    if engine == "gptsovits": gptsovits_engine._voices_cache = None
    elif engine == "fish": fish_engine.invalidate_cache()


def _whisper_transcribe(wav_path: str) -> str:
    """Shell out to GPT-SoVITS venv's whisper (tts-server venv doesn't ship it)."""
    whisper_py = "/opt/GPT-SoVITS/.venv/bin/python"
    if not os.path.exists(whisper_py):
        raise HTTPException(status_code=500, detail=f"Whisper venv not found at {whisper_py}")
    script = (
        "import whisper, json, sys\n"
        "m = whisper.load_model('base')\n"
        f"r = m.transcribe({wav_path!r}, language='en', verbose=False)\n"
        "sys.stdout.write(json.dumps({'text': r.get('text','').strip()}))\n"
    )
    try:
        proc = subprocess.run([whisper_py, "-c", script], capture_output=True, text=True, timeout=180, check=True)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"Whisper failed: {(e.stderr or '')[-300:]}")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Whisper timed out")
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1]).get("text", "").strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not parse whisper output: {e}")


@app.put("/admin/voices/{engine}/{voice_id}")
async def upsert_engine_voice(
    engine: str,
    voice_id: str,
    audio: Optional[UploadFile] = File(None),
    metadata: Optional[str] = Form(None),
    x_admin_token: Optional[str] = Header(None),
):
    """Create or replace a Fish/GSV voice by uploading a reference clip.

    Either `audio` (file) or `metadata` (JSON) — or both — may be present:
      - audio only: replaces reference.wav, re-transcribes for ref_text.
        For Fish, no trim. For GSV, trims to 8 s + resamples to 32 kHz mono
        (GSV's required range).
      - metadata only: edits name / gender / group / ref_text without
        touching the audio. Useful to tweak the prompt text after upload.
      - both: full upsert.
    """
    _check_admin(x_admin_token)
    dir_id, base = await _ensure_engine_dir(engine, voice_id)
    os.makedirs(base, exist_ok=True)
    ref_path = os.path.join(base, "reference.wav")
    meta_path = os.path.join(base, "metadata.json")
    existing_meta = {}
    if os.path.exists(meta_path):
        try: existing_meta = json.loads(open(meta_path).read())
        except Exception: pass
    user_meta = {}
    if metadata:
        try: user_meta = json.loads(metadata)
        except Exception: raise HTTPException(status_code=400, detail="metadata must be valid JSON")
        if not isinstance(user_meta, dict):
            raise HTTPException(status_code=400, detail="metadata must be an object")
    new_audio_written = False
    if audio is not None:
        audio_bytes = await audio.read()
        if len(audio_bytes) < 1024:
            raise HTTPException(status_code=400, detail="Audio too small (<1 KB)")
        # Always write the raw upload; for GSV trim+resample after
        with open(ref_path, "wb") as f: f.write(audio_bytes)
        if engine == "gptsovits":
            tmp = ref_path + ".tmp.wav"
            try:
                subprocess.run([
                    "ffmpeg", "-y", "-nostdin", "-loglevel", "error",
                    "-i", ref_path, "-t", "8", "-ar", "32000", "-ac", "1", tmp,
                ], check=True, timeout=60)
                os.replace(tmp, ref_path)
            except subprocess.CalledProcessError as e:
                raise HTTPException(status_code=500, detail=f"ffmpeg trim failed for GSV: {e}")
        new_audio_written = True
    # Re-transcribe if (a) audio was changed AND ref_text not provided, or
    # (b) explicit user_meta.regenerate_ref_text=true
    if (new_audio_written and "ref_text" not in user_meta) or user_meta.get("regenerate_ref_text"):
        if not os.path.exists(ref_path):
            raise HTTPException(status_code=400, detail="No reference.wav present and none uploaded")
        user_meta["ref_text"] = _whisper_transcribe(ref_path)
    elif "ref_text" not in user_meta and "ref_text" not in existing_meta:
        if os.path.exists(ref_path):
            user_meta["ref_text"] = _whisper_transcribe(ref_path)
    user_meta.pop("regenerate_ref_text", None)
    merged = {**existing_meta, **user_meta}
    # Default sane fields
    merged.setdefault("name", dir_id.replace("_", " ").title() + (" (Fish)" if engine == "fish" else " (GSV)"))
    merged.setdefault("gender", "unknown")
    merged.setdefault("group", "Celebrity")
    merged.setdefault("language", "en")
    merged["updated_at"] = int(time.time())
    if "ref_text" not in merged:
        raise HTTPException(status_code=400, detail="ref_text is required (upload audio or supply metadata.ref_text)")
    with open(meta_path, "w") as f:
        json.dump(merged, f, indent=2)
    _engine_invalidate(engine)
    prefix = "fish_" if engine == "fish" else "gsv_"
    return {"ok": True, "voice_id": prefix + dir_id, "ref_text": merged["ref_text"], "name": merged["name"]}


@app.delete("/admin/voices/{engine}/{voice_id}")
def delete_engine_voice(engine: str, voice_id: str, x_admin_token: Optional[str] = Header(None)):
    """Remove a non-Chatterbox/non-RVC voice by engine + dir name. Only
    blows away the voice dir under models/<engine>/<id>/ — no effect on
    other engines' copies of the same celebrity."""
    _check_admin(x_admin_token)
    import shutil as _shutil
    if engine not in ("gptsovits", "fish"):
        raise HTTPException(status_code=400, detail="Unsupported engine")
    dir_id = _normalize_voice_dir_id(voice_id)
    base = os.path.join(os.path.dirname(__file__), "models", engine, dir_id)
    if not os.path.isdir(base):
        raise HTTPException(status_code=404, detail=f"{engine} voice not found: {voice_id}")
    _shutil.rmtree(base)
    if engine == "gptsovits":
        gptsovits_engine._voices_cache = None
    elif engine == "fish":
        fish_engine.invalidate_cache()
    return {"ok": True, "engine": engine, "voice_id": voice_id, "deleted": True}


@app.post("/admin/voices/fish/clone-from-chatterbox/{voice_id}")
def clone_fish_from_chatterbox(voice_id: str):
    """Create a fish_<voice> by reusing the Chatterbox reference clip
    (no trim — Fish handles 5–30 s refs). Whisper-transcribes for
    ref_text. Drops the engine cache so /voices picks it up."""
    import os as _os, shutil as _shutil, subprocess as _sp
    cb_id = voice_id.replace("cb_", "", 1)
    cb_dir = _os.path.join(chatterbox_engine.get_models_dir(), cb_id)
    cb_ref = _os.path.join(cb_dir, "reference.wav")
    cb_meta_path = _os.path.join(cb_dir, "metadata.json")
    if not _os.path.exists(cb_ref):
        raise HTTPException(status_code=404, detail=f"Chatterbox reference not found for {voice_id}")
    cb_meta = {}
    if _os.path.exists(cb_meta_path):
        try: cb_meta = json.loads(open(cb_meta_path).read())
        except Exception: pass
    fish_dir = _os.path.join(_os.path.dirname(__file__), "models", "fish", cb_id)
    _os.makedirs(fish_dir, exist_ok=True)
    fish_ref = _os.path.join(fish_dir, "reference.wav")
    _shutil.copy(cb_ref, fish_ref)
    # Transcribe via GPT-SoVITS venv's whisper (same pattern as GSV clone).
    whisper_py = "/opt/GPT-SoVITS/.venv/bin/python"
    if not _os.path.exists(whisper_py):
        raise HTTPException(status_code=500, detail=f"Whisper venv not found at {whisper_py}")
    script = (
        "import whisper, json, sys\n"
        "m = whisper.load_model('base')\n"
        f"r = m.transcribe({fish_ref!r}, language='en', verbose=False)\n"
        "sys.stdout.write(json.dumps({'text': r.get('text','').strip()}))\n"
    )
    try:
        proc = _sp.run([whisper_py, "-c", script], capture_output=True, text=True, timeout=180, check=True)
    except _sp.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"Whisper transcription failed: {(e.stderr or '')[-300:]}")
    except _sp.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Whisper transcription timed out")
    try:
        ref_text = json.loads(proc.stdout.strip().splitlines()[-1]).get("text", "").strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not parse whisper output: {e}")
    if not ref_text:
        raise HTTPException(status_code=500, detail="Whisper returned empty transcription")
    meta = {
        "name": cb_meta.get("name", cb_id.replace("_", " ").title()) + " (Fish)",
        "gender": cb_meta.get("gender", "unknown"),
        "group": cb_meta.get("group", "Celebrity"),
        "ref_text": ref_text,
        "language": "en",
        "cloned_from": f"cb_{cb_id}",
        "cloned_at": int(time.time()),
    }
    with open(_os.path.join(fish_dir, "metadata.json"), "w") as f:
        json.dump(meta, f, indent=2)
    fish_engine.invalidate_cache()
    return {"ok": True, "voice_id": f"fish_{cb_id}", "ref_text": ref_text, "ref_path": fish_ref}


@app.post("/admin/voices/gsv/clone-from-chatterbox/{voice_id}")
def clone_gsv_from_chatterbox(voice_id: str, req: CloneToGsvRequest = CloneToGsvRequest()):
    import os as _os, shutil as _shutil, json as _json
    cb_id = voice_id.replace("cb_", "", 1)
    cb_dir = _os.path.join(chatterbox_engine.get_models_dir(), cb_id)
    cb_ref = _os.path.join(cb_dir, "reference.wav")
    cb_meta_path = _os.path.join(cb_dir, "metadata.json")
    if not _os.path.exists(cb_ref):
        raise HTTPException(status_code=404, detail=f"Chatterbox reference not found for {voice_id}")
    cb_meta = {}
    if _os.path.exists(cb_meta_path):
        try: cb_meta = _json.loads(open(cb_meta_path).read())
        except Exception: pass

    gsv_models_dir = _os.path.join(_os.path.dirname(__file__), "models", "gptsovits")
    gsv_dir = _os.path.join(gsv_models_dir, cb_id)
    _os.makedirs(gsv_dir, exist_ok=True)
    gsv_ref = _os.path.join(gsv_dir, "reference.wav")

    # Trim with ffmpeg: start=req.trim_start_sec, length=req.trim_length_sec.
    # Also force 32 kHz mono to match GSV defaults.
    length = max(3.0, min(10.0, float(req.trim_length_sec or 8.0)))
    start = max(0.0, float(req.trim_start_sec or 0.0))
    try:
        subprocess.run([
            "ffmpeg", "-y", "-nostdin", "-loglevel", "error",
            "-ss", str(start), "-i", cb_ref, "-t", str(length),
            "-ar", "32000", "-ac", "1", gsv_ref,
        ], check=True, timeout=60)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"ffmpeg trim failed: {e}")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="ffmpeg trim timed out")

    # Transcribe via the GPT-SoVITS venv's whisper (tts-server's own venv
    # doesn't ship whisper to keep it lean — shell out instead).
    whisper_py = "/opt/GPT-SoVITS/.venv/bin/python"
    if not _os.path.exists(whisper_py):
        raise HTTPException(status_code=500, detail=f"Whisper venv not found at {whisper_py}")
    script = (
        "import whisper, json, sys\n"
        "m = whisper.load_model('base')\n"
        f"r = m.transcribe({gsv_ref!r}, language='en', verbose=False)\n"
        "sys.stdout.write(json.dumps({'text': r.get('text','').strip()}))\n"
    )
    try:
        proc = subprocess.run(
            [whisper_py, "-c", script],
            capture_output=True, text=True, timeout=180, check=True,
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"Whisper transcription failed: {e.stderr[-300:] if e.stderr else 'no stderr'}")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Whisper transcription timed out (180 s)")
    try:
        payload = _json.loads(proc.stdout.strip().splitlines()[-1])
        ref_text = payload.get("text", "").strip()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not parse whisper output: {e}")
    if not ref_text:
        raise HTTPException(status_code=500, detail="Whisper returned empty transcription")

    meta = {
        "name": cb_meta.get("name", cb_id.replace("_", " ").title()) + " (GSV)",
        "gender": cb_meta.get("gender", "unknown"),
        "group": cb_meta.get("group", "Celebrity"),
        "ref_text": ref_text,
        "language": "en",
        "cloned_from": f"cb_{cb_id}",
        "cloned_at": int(time.time()),
    }
    with open(_os.path.join(gsv_dir, "metadata.json"), "w") as f:
        _json.dump(meta, f, indent=2)
    # Force voice cache refresh so /voices picks it up immediately
    gptsovits_engine._voices_cache = None
    return {"ok": True, "voice_id": f"gsv_{cb_id}", "ref_text": ref_text, "ref_len_sec": length, "ref_path": gsv_ref}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
def health():
    engines = ["kokoro"]
    if chatterbox_engine.get_voices():
        engines.append("chatterbox")
    if rvc_engine.get_voices():
        engines.append("rvc")
    if gptsovits_engine.get_voices():
        engines.append("gptsovits")
    return {"status": "ok", "engines": engines}


@app.get("/voices", response_model=list[VoiceInfo])
def voices():
    all_voices = list(kokoro_engine.get_voices())
    cb_voices = chatterbox_engine.get_voices()
    all_voices.extend(cb_voices)
    # Only show RVC voices that don't have a Chatterbox equivalent
    # (Chatterbox versions are higher quality; RVC still runs as refinement behind the scenes)
    cb_base_ids = {v["id"].replace("cb_", "") for v in cb_voices}
    for rv in rvc_engine.get_voices():
        if rv["id"].replace("rvc_", "") not in cb_base_ids:
            all_voices.append(rv)
    all_voices.extend(gptsovits_engine.get_voices())
    all_voices.extend(fish_engine.get_voices())
    return all_voices


def _free_gpu_caches():
    """Drop RVC + Chatterbox model caches and call torch.cuda.empty_cache().

    Used after each training-mode synth so the GPU returns to its training
    baseline and the next training step doesn't compete for VRAM.
    """
    try: chatterbox_engine.free_caches()
    except Exception as e: log.warning("chatterbox free_caches post-synth failed: %s", e)
    try: rvc_engine.free_caches()
    except Exception as e: log.warning("rvc free_caches post-synth failed: %s", e)


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    if _TRAINING_MODE:
        # Training is using ~8-10 GB of the 3090. TTS needs to share the
        # remaining ~14 GB without OOM'ing the train loop, so we:
        #   1. Serialize synth calls (only one lazy-load at a time)
        #   2. Free all caches immediately after each synth so training
        #      regains headroom before the next batch
        # Parallel callers queue on the lock; if the queue exceeds
        # _TRAINING_SYNTH_TIMEOUT_SEC we 503 with a clear message.
        acquired = _TRAINING_SYNTH_LOCK.acquire(timeout=_TRAINING_SYNTH_TIMEOUT_SEC)
        if not acquired:
            raise HTTPException(
                status_code=503,
                detail="Training-mode synthesis queue is busy. Try again in a moment.",
            )
        try:
            return _do_synthesize(req)
        finally:
            _free_gpu_caches()
            _TRAINING_SYNTH_LOCK.release()
    return _do_synthesize(req)


def _concat_wavs(wav_parts, pause_ms_list, crossfade_ms=30):
    """Concatenate a list of WAV byte blobs with optional inter-part silence.

    pause_ms_list[i] is the silence to insert AFTER part i (len == len(wav_parts)).
    A short linear crossfade at each join masks ffmpeg-style click artifacts.
    Falls back to plain concat if soundfile/numpy aren't available (shouldn't
    happen — the engines already require them).
    """
    import io as _io
    import soundfile as sf
    import numpy as np

    decoded = []
    sr = None
    for blob in wav_parts:
        data, rate = sf.read(_io.BytesIO(blob), dtype="float32", always_2d=False)
        if sr is None:
            sr = rate
        elif rate != sr:
            # Rare — engines should all return the same rate. Log + skip resample.
            log.warning("concat_wavs: sample-rate mismatch %d vs %d (using first)", rate, sr)
        decoded.append(data)
    if not decoded:
        return b""
    fade_n = max(1, int(sr * crossfade_ms / 1000))
    out = decoded[0]
    for i in range(1, len(decoded)):
        pause_ms = pause_ms_list[i - 1] if i - 1 < len(pause_ms_list) else 0
        if pause_ms > 0:
            gap = np.zeros(int(sr * pause_ms / 1000), dtype="float32")
            out = np.concatenate([out, gap])
        nxt = decoded[i]
        if len(out) >= fade_n and len(nxt) >= fade_n and pause_ms == 0:
            # Linear crossfade at the join
            ramp_down = np.linspace(1.0, 0.0, fade_n, dtype="float32")
            ramp_up = np.linspace(0.0, 1.0, fade_n, dtype="float32")
            tail = out[-fade_n:] * ramp_down
            head = nxt[:fade_n] * ramp_up
            out = np.concatenate([out[:-fade_n], tail + head, nxt[fade_n:]])
        else:
            out = np.concatenate([out, nxt])
    buf = _io.BytesIO()
    sf.write(buf, out, sr, format="WAV")
    return buf.getvalue()


def _synthesize_segmented(req: SynthesizeRequest):
    """Run each segment through Chatterbox with its own ref + preset, stitch."""
    cb_ids = chatterbox_engine.get_voice_ids()
    if req.voice_id not in cb_ids:
        raise HTTPException(status_code=400, detail=f"Segmented synth only supports Chatterbox voices for now (got {req.voice_id})")
    parts = []
    pauses = []
    for seg in req.segments:
        exag, cfg, temp = _resolve_segment_params(seg)
        try:
            wav = chatterbox_engine.synthesize(
                seg.text, req.voice_id,
                exaggeration=exag, cfg_weight=cfg, temperature=temp,
                emotion=seg.emotion, seed=req.seed,
            )
        except FileNotFoundError as e:
            raise HTTPException(status_code=400, detail=str(e))
        parts.append(wav)
        pauses.append(max(0, min(2000, int(seg.pause_ms_after or 0))))
    wav_combined = _concat_wavs(parts, pauses)
    # Optional RVC pass on the stitched output
    rvc_ids = rvc_engine.get_rvc_model_ids()
    rvc_model_id = req.voice_id.replace("cb_", "rvc_", 1)
    skip_rvc = chatterbox_engine.should_skip_rvc(req.voice_id)
    if req.use_rvc and not skip_rvc and rvc_model_id in rvc_ids:
        try:
            wav_combined = rvc_engine.convert(wav_combined, rvc_model_id)
        except Exception as e:
            log.warning("RVC refinement of stitched output failed (keeping raw): %s", e)
    return Response(content=wav_combined, media_type="audio/wav")


def _do_synthesize(req: SynthesizeRequest):
    if req.segments:
        return _synthesize_segmented(req)
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is empty")

    voice_id = req.voice_id
    t0 = time.time()

    cb_ids = chatterbox_engine.get_voice_ids()
    rvc_ids = rvc_engine.get_rvc_model_ids()
    kokoro_ids = kokoro_engine.get_voice_ids()
    gsv_ids = gptsovits_engine.get_voice_ids()
    fish_ids = fish_engine.get_voice_ids()

    # -----------------------------------------------------------------------
    # Route 1: Chatterbox celebrity voice (cb_trump, cb_obama, etc.)
    # Optionally refined through RVC
    # -----------------------------------------------------------------------
    if voice_id in cb_ids:
        log.info("synthesize [chatterbox] voice=%s text_len=%d text_preview=%.60s",
                 voice_id, len(text), text)

        try:
            wav_bytes = chatterbox_engine.synthesize(
                text, voice_id,
                exaggeration=req.exaggeration,
                cfg_weight=(req.cfg_weight if req.cfg_weight is not None else 0.5),
                temperature=(req.temperature if req.temperature is not None else 0.8),
                seed=req.seed,
            )
        except Exception as e:
            log.error("Chatterbox synthesis failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Chatterbox synthesis failed: {e}")

        t_tts = time.time() - t0
        log.info("Chatterbox done in %.2fs, %d bytes", t_tts, len(wav_bytes))

        # Optional RVC refinement: check if matching RVC model exists
        # cb_trump -> rvc_trump (skip for voices that sound worse with RVC, e.g. cartoons)
        rvc_model_id = voice_id.replace("cb_", "rvc_", 1)
        skip_rvc = chatterbox_engine.should_skip_rvc(voice_id)
        if req.use_rvc and not skip_rvc and rvc_model_id in rvc_ids:
            t1 = time.time()
            try:
                wav_bytes = rvc_engine.convert(wav_bytes, rvc_model_id)
                t_rvc = time.time() - t1
                log.info("RVC refinement done in %.2fs, %d bytes", t_rvc, len(wav_bytes))
            except Exception as e:
                log.warning("RVC refinement failed (using Chatterbox output): %s", e)
                # Non-fatal — Chatterbox output is still good without RVC

    # -----------------------------------------------------------------------
    # Route 2: RVC-only voice (rvc_trump, etc.) — legacy Kokoro base
    # -----------------------------------------------------------------------
    elif voice_id in rvc_ids:
        rvc_model_id = voice_id
        base_voice = rvc_engine.get_base_voice(voice_id) or "am_adam"

        log.info("synthesize [kokoro+rvc] voice=%s base=%s text_len=%d text_preview=%.60s",
                 voice_id, base_voice, len(text), text)

        try:
            wav_bytes = kokoro_engine.synthesize(text, base_voice)
        except Exception as e:
            log.error("Kokoro synthesis failed: %s", e)
            raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {e}")

        t_tts = time.time() - t0
        log.info("Kokoro done in %.2fs, %d bytes", t_tts, len(wav_bytes))

        t1 = time.time()
        try:
            wav_bytes = rvc_engine.convert(wav_bytes, rvc_model_id)
        except Exception as e:
            log.error("RVC conversion failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Voice conversion failed: {e}")
        t_rvc = time.time() - t1
        log.info("RVC done in %.2fs, %d bytes", t_rvc, len(wav_bytes))

    # -----------------------------------------------------------------------
    # Route 3: GPT-SoVITS voice (gsv_*, external API server)
    # -----------------------------------------------------------------------
    elif voice_id in gsv_ids:
        log.info("synthesize [gptsovits] voice=%s text_len=%d text_preview=%.60s",
                 voice_id, len(text), text)

        try:
            wav_bytes = gptsovits_engine.synthesize(text, voice_id)
        except Exception as e:
            log.error("GPT-SoVITS synthesis failed: %s", e)
            raise HTTPException(status_code=500, detail=f"GPT-SoVITS synthesis failed: {e}")

        t_tts = time.time() - t0
        log.info("GPT-SoVITS done in %.2fs, %d bytes", t_tts, len(wav_bytes))

    # -----------------------------------------------------------------------
    # Route 3b: Fish-Speech v2 (fish_*) — openaudio-s1-mini, native inline
    # emotion tags, runs out-of-process (fish-speech.service on :8881).
    # -----------------------------------------------------------------------
    elif voice_id in fish_ids:
        log.info("synthesize [fish] voice=%s text_len=%d text_preview=%.60s",
                 voice_id, len(text), text)
        try:
            wav_bytes = fish_engine.synthesize(text, voice_id)
        except Exception as e:
            log.error("Fish synthesis failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Fish synthesis failed: {e}")
        t_tts = time.time() - t0
        log.info("Fish done in %.2fs, %d bytes", t_tts, len(wav_bytes))

    # -----------------------------------------------------------------------
    # Route 4: Plain Kokoro voice (af_heart, am_adam, etc.)
    # -----------------------------------------------------------------------
    elif voice_id in kokoro_ids:
        log.info("synthesize [kokoro] voice=%s text_len=%d text_preview=%.60s",
                 voice_id, len(text), text)

        try:
            wav_bytes = kokoro_engine.synthesize(text, voice_id)
        except Exception as e:
            log.error("Kokoro synthesis failed: %s", e)
            raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {e}")

        t_tts = time.time() - t0
        log.info("Kokoro done in %.2fs, %d bytes", t_tts, len(wav_bytes))

    else:
        raise HTTPException(status_code=400, detail=f"Unknown voice_id: {voice_id}")

    elapsed = time.time() - t0
    log.info("synthesize total %.2fs, %d bytes", elapsed, len(wav_bytes))

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"X-Synthesis-Time": f"{elapsed:.3f}"},
    )


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Admin endpoints (Chatterbox voice management)
# ---------------------------------------------------------------------------

VOICE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,31}$")
ADMIN_TOKEN = os.environ.get("TTS_ADMIN_TOKEN", "").strip()


def _check_admin(token: Optional[str]):
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="TTS_ADMIN_TOKEN not configured")
    if not token or token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid admin token")


def _normalize_voice_dir_id(raw_id: str) -> str:
    """Strip cb_ prefix if present, validate format. Returns the on-disk dir name."""
    cleaned = raw_id[3:] if raw_id.startswith("cb_") else raw_id
    if not VOICE_ID_RE.match(cleaned):
        raise HTTPException(status_code=400, detail=f"Invalid voice id: {raw_id!r}")
    return cleaned


@app.put("/voices/chatterbox/{voice_id}")
async def upload_chatterbox_voice(
    voice_id: str,
    reference: UploadFile = File(...),
    metadata: str = Form(...),
    x_admin_token: Optional[str] = Header(None),
):
    """Create or replace a Chatterbox voice. Multipart: reference WAV + metadata JSON."""
    _check_admin(x_admin_token)
    dir_id = _normalize_voice_dir_id(voice_id)

    try:
        meta = json.loads(metadata)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="metadata is not valid JSON")
    if not isinstance(meta, dict):
        raise HTTPException(status_code=400, detail="metadata must be a JSON object")

    clean_meta = {
        "name": str(meta.get("name", dir_id.replace("_", " ").title())).strip()[:80] or dir_id,
        "gender": meta.get("gender", "unknown") if meta.get("gender") in ("male", "female", "unknown") else "unknown",
        "group": str(meta.get("group", "Celebrity")).strip()[:40] or "Celebrity",
        "skip_rvc": bool(meta.get("skip_rvc", False)),
    }
    # Optional default expression (Chatterbox exaggeration 0.25–2.0).
    try:
        de = float(meta.get("default_exaggeration"))
        if 0.25 <= de <= 2.0:
            clean_meta["default_exaggeration"] = round(de, 2)
    except (TypeError, ValueError):
        pass
    # Optional source provenance: how this reference clip was produced.
    src_kind = meta.get("source_kind")
    if src_kind in ("youtube", "upload"):
        clean_meta["source_kind"] = src_kind
        if src_kind == "youtube" and isinstance(meta.get("source_url"), str):
            clean_meta["source_url"] = meta["source_url"][:500]
        if src_kind == "upload" and isinstance(meta.get("source_filename"), str):
            clean_meta["source_filename"] = meta["source_filename"][:200]
        for key in ("source_start", "source_end"):
            try:
                v = float(meta.get(key))
                if v >= 0:
                    clean_meta[key] = round(v, 2)
            except (TypeError, ValueError):
                pass
    clean_meta["updated_at"] = int(time.time())

    audio_bytes = await reference.read()
    if len(audio_bytes) < 1024:
        raise HTTPException(status_code=400, detail="Reference audio is empty or too small")
    if len(audio_bytes) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Reference audio exceeds 50MB")

    voice_dir = os.path.join(chatterbox_engine.get_models_dir(), dir_id)
    os.makedirs(voice_dir, exist_ok=True)

    ref_tmp = os.path.join(voice_dir, "reference.wav.tmp")
    meta_tmp = os.path.join(voice_dir, "metadata.json.tmp")
    try:
        with open(ref_tmp, "wb") as f:
            f.write(audio_bytes)
        with open(meta_tmp, "w") as f:
            json.dump(clean_meta, f, indent=2)
        os.replace(ref_tmp, os.path.join(voice_dir, "reference.wav"))
        os.replace(meta_tmp, os.path.join(voice_dir, "metadata.json"))
    finally:
        for p in (ref_tmp, meta_tmp):
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass

    chatterbox_engine.invalidate_voice(f"cb_{dir_id}")
    log.info("Chatterbox voice upserted: %s (%d bytes)", dir_id, len(audio_bytes))

    return {
        "id": f"cb_{dir_id}",
        "name": clean_meta["name"],
        "engine": "chatterbox",
        "gender": clean_meta["gender"],
        "language": "en-us",
        "group": clean_meta["group"],
    }


@app.put("/voices/chatterbox/{voice_id}/refs/{emotion}")
async def upload_chatterbox_emotion_ref(
    voice_id: str,
    emotion: str,
    audio: UploadFile = File(...),
    x_admin_token: Optional[str] = Header(None),
):
    """Upload a per-emotion reference clip for a Chatterbox voice.

    Stored at models/chatterbox/<voice>/refs/<emotion>.wav alongside the
    main reference.wav. The synth path picks this file when a segment's
    emotion matches; falls back to neutral / legacy reference.wav otherwise.

    Valid emotions: soft, neutral, excited, yell, angry, sad, happy.
    """
    _check_admin(x_admin_token)
    emo = emotion.lower().strip()
    if emo not in chatterbox_engine.EMOTION_REFS:
        raise HTTPException(status_code=400, detail=f"Unknown emotion '{emo}'. Valid: {', '.join(chatterbox_engine.EMOTION_REFS)}")
    dir_id = _normalize_voice_dir_id(voice_id)
    voice_dir = os.path.join(chatterbox_engine.get_models_dir(), dir_id)
    if not os.path.isdir(voice_dir):
        raise HTTPException(status_code=404, detail=f"Voice not found: {voice_id}")
    refs_dir = os.path.join(voice_dir, "refs")
    os.makedirs(refs_dir, exist_ok=True)
    audio_bytes = await audio.read()
    if len(audio_bytes) < 1024:
        raise HTTPException(status_code=400, detail="Audio too small (<1 KB)")
    tmp_path = os.path.join(refs_dir, f"{emo}.wav.tmp")
    final_path = os.path.join(refs_dir, f"{emo}.wav")
    try:
        with open(tmp_path, "wb") as f:
            f.write(audio_bytes)
        os.replace(tmp_path, final_path)
    finally:
        if os.path.exists(tmp_path):
            try: os.remove(tmp_path)
            except OSError: pass
    # Drop cached conditionals for this (voice, emotion) so next synth
    # uses the new clip.
    key = (f"cb_{dir_id}", emo)
    chatterbox_engine._conditionals.pop(key, None)
    chatterbox_engine._voices_cache = None  # force /voices refresh
    log.info("Chatterbox emotion-ref uploaded: %s [%s] (%d bytes)", dir_id, emo, len(audio_bytes))
    return {"ok": True, "voice_id": f"cb_{dir_id}", "emotion": emo, "bytes": len(audio_bytes)}


@app.post("/admin/voices/chatterbox/{voice_id}/auto-emotion-refs")
def auto_select_emotion_refs(voice_id: str, x_admin_token: Optional[str] = Header(None), overwrite: bool = True, chunks_dir: Optional[str] = None):
    """Run select_emotion_refs.py over the voice's dataset archive to populate
    refs/{soft,neutral,excited,yell,angry,sad,happy}.wav.

    chunks_dir defaults to models/datasets/<voice>/chunks/ (produced by the
    RVC training pipeline's retention step). Requires the voice's dataset
    to have been trained via the Phase 10 RVC pipeline at some point.
    """
    _check_admin(x_admin_token)
    dir_id = _normalize_voice_dir_id(voice_id)
    voice_dir = os.path.join(chatterbox_engine.get_models_dir(), dir_id)
    if not os.path.isdir(voice_dir):
        raise HTTPException(status_code=404, detail=f"Voice not found: {voice_id}")
    if chunks_dir is None:
        default_chunks = os.path.join(os.path.dirname(__file__), "models", "datasets", dir_id, "chunks")
        if not os.path.isdir(default_chunks):
            raise HTTPException(
                status_code=404,
                detail=f"No dataset archive found at {default_chunks}. "
                       f"Voice must have been trained via the RVC pipeline first "
                       f"(Phase 6 archives chunks to models/datasets/<voice>/chunks/)."
            )
        chunks_dir = default_chunks
    tool = os.path.join(os.path.dirname(__file__), "tools", "select_emotion_refs.py")
    cb_dir = chatterbox_engine.get_models_dir()
    py = "/opt/GPT-SoVITS/.venv/bin/python"
    try:
        args = [py, tool, "--voice-id", dir_id, "--chunks-dir", chunks_dir, "--cb-dir", cb_dir]
        if overwrite: args.append("--overwrite")
        proc = subprocess.run(args, capture_output=True, text=True, timeout=600, check=True)
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "")[-1500:]
        stdout = (e.stdout or "")[-800:]
        raise HTTPException(status_code=500, detail=f"emotion-ref selection failed: {stderr or stdout or 'no output'}")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="emotion-ref selection timed out (600 s)")
    try:
        report = json.loads(proc.stdout.strip().split("\n")[-1]) if "{" in proc.stdout else {}
    except Exception:
        # fall back: find the last JSON-looking blob
        import re as _re
        m = _re.search(r"\{[\s\S]*\}\s*$", proc.stdout)
        report = json.loads(m.group(0)) if m else {"raw": proc.stdout[-500:]}
    # Drop caches so /voices + /synthesize see the new refs
    for key in list(chatterbox_engine._conditionals.keys()):
        if key[0] == f"cb_{dir_id}":
            chatterbox_engine._conditionals.pop(key, None)
    chatterbox_engine._voices_cache = None
    return report


@app.delete("/voices/chatterbox/{voice_id}/refs/{emotion}")
def delete_chatterbox_emotion_ref(
    voice_id: str,
    emotion: str,
    x_admin_token: Optional[str] = Header(None),
):
    _check_admin(x_admin_token)
    emo = emotion.lower().strip()
    dir_id = _normalize_voice_dir_id(voice_id)
    refs_path = os.path.join(chatterbox_engine.get_models_dir(), dir_id, "refs", f"{emo}.wav")
    if os.path.exists(refs_path):
        os.remove(refs_path)
        key = (f"cb_{dir_id}", emo)
        chatterbox_engine._conditionals.pop(key, None)
        chatterbox_engine._voices_cache = None
        return {"ok": True, "deleted": True}
    return {"ok": True, "deleted": False}


class ChatterboxMetadataPatch(BaseModel):
    name: Optional[str] = None
    gender: Optional[str] = None
    group: Optional[str] = None
    skip_rvc: Optional[bool] = None
    default_exaggeration: Optional[float] = Field(None, ge=0.25, le=2.0)


@app.patch("/voices/chatterbox/{voice_id}/metadata")
def patch_chatterbox_metadata(
    voice_id: str,
    patch: ChatterboxMetadataPatch,
    x_admin_token: Optional[str] = Header(None),
):
    """Update metadata.json fields without touching reference.wav."""
    _check_admin(x_admin_token)
    dir_id = _normalize_voice_dir_id(voice_id)
    voice_dir = os.path.join(chatterbox_engine.get_models_dir(), dir_id)
    meta_path = os.path.join(voice_dir, "metadata.json")
    if not os.path.isdir(voice_dir):
        raise HTTPException(status_code=404, detail=f"Voice not found: {dir_id}")

    existing = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path) as f:
                existing = json.load(f)
        except Exception:
            existing = {}
    if not isinstance(existing, dict):
        existing = {}

    if patch.name is not None:
        existing["name"] = str(patch.name).strip()[:80] or dir_id
    if patch.gender is not None and patch.gender in ("male", "female", "unknown"):
        existing["gender"] = patch.gender
    if patch.group is not None:
        existing["group"] = str(patch.group).strip()[:40] or "Celebrity"
    if patch.skip_rvc is not None:
        existing["skip_rvc"] = bool(patch.skip_rvc)
    if patch.default_exaggeration is not None:
        existing["default_exaggeration"] = round(float(patch.default_exaggeration), 2)
    existing["updated_at"] = int(time.time())

    tmp = meta_path + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(existing, f, indent=2)
        os.replace(tmp, meta_path)
    finally:
        if os.path.exists(tmp):
            try: os.remove(tmp)
            except OSError: pass

    chatterbox_engine.invalidate_voice(f"cb_{dir_id}")
    return {"ok": True, "metadata": existing}


@app.delete("/voices/chatterbox/{voice_id}")
def delete_chatterbox_voice(voice_id: str, x_admin_token: Optional[str] = Header(None)):
    _check_admin(x_admin_token)
    dir_id = _normalize_voice_dir_id(voice_id)
    voice_dir = os.path.join(chatterbox_engine.get_models_dir(), dir_id)
    if not os.path.isdir(voice_dir):
        raise HTTPException(status_code=404, detail=f"Voice not found: {dir_id}")
    shutil.rmtree(voice_dir)
    chatterbox_engine.invalidate_voice(f"cb_{dir_id}")
    log.info("Chatterbox voice deleted: %s", dir_id)
    return {"deleted": f"cb_{dir_id}"}


# ---------------------------------------------------------------------------
# RVC voice metadata (manifest entry) editing
# ---------------------------------------------------------------------------

RVC_MODELS_DIR = os.path.join(os.path.dirname(__file__), "models", "rvc")
RVC_MANIFEST_PATH = os.path.join(RVC_MODELS_DIR, "manifest.json")


def _load_rvc_manifest() -> list:
    if not os.path.exists(RVC_MANIFEST_PATH):
        return []
    with open(RVC_MANIFEST_PATH) as f:
        data = json.load(f)
    return data if isinstance(data, list) else []


def _save_rvc_manifest(entries: list):
    tmp = RVC_MANIFEST_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(entries, f, indent=2)
    os.replace(tmp, RVC_MANIFEST_PATH)


class RvcMetadataPatch(BaseModel):
    name: Optional[str] = None
    gender: Optional[str] = None
    group: Optional[str] = None
    transpose: Optional[int] = Field(None, ge=-24, le=24)
    index_rate: Optional[float] = Field(None, ge=0.0, le=1.0)
    protect: Optional[float] = Field(None, ge=0.0, le=0.5)
    base_voice: Optional[str] = None


@app.patch("/voices/rvc/{voice_id}")
def patch_rvc_voice(
    voice_id: str,
    patch: RvcMetadataPatch,
    x_admin_token: Optional[str] = Header(None),
):
    """Update an RVC voice's manifest entry. Use for rename/regroup/pitch tuning."""
    _check_admin(x_admin_token)
    dir_id = _normalize_voice_dir_id(voice_id)

    entries = _load_rvc_manifest()
    found = None
    for e in entries:
        if e.get("id") == dir_id:
            found = e
            break
    if not found:
        raise HTTPException(status_code=404, detail=f"Voice not in manifest: {dir_id}")

    if patch.name is not None:
        found["name"] = str(patch.name).strip()[:80] or dir_id
    if patch.gender is not None and patch.gender in ("male", "female", "unknown"):
        found["gender"] = patch.gender
    if patch.group is not None:
        found["group"] = str(patch.group).strip()[:40] or "Celebrity"
    if patch.transpose is not None:
        found["transpose"] = int(patch.transpose)
    if patch.index_rate is not None:
        found["index_rate"] = round(float(patch.index_rate), 3)
    if patch.protect is not None:
        found["protect"] = round(float(patch.protect), 3)
    if patch.base_voice is not None:
        found["base_voice"] = str(patch.base_voice).strip()[:40]

    _save_rvc_manifest(entries)
    # RVC voices re-read manifest on next call; no engine cache to invalidate here,
    # but invalidating Chatterbox in case the voice happens to be paired forces
    # the /voices endpoint to reflect changes immediately.
    chatterbox_engine.invalidate_voice(f"cb_{dir_id}")
    log.info("RVC voice metadata patched: %s (%s)", dir_id, patch.model_dump(exclude_unset=True))
    return {"ok": True, "entry": found}


@app.delete("/voices/rvc/{voice_id}")
def delete_rvc_voice(voice_id: str, x_admin_token: Optional[str] = Header(None)):
    """Remove an RVC voice: delete model files + drop manifest entry.

    Does NOT touch the paired cb_<voice_id> Chatterbox voice — those must be
    deleted separately. After this, the Chatterbox voice (if any) continues
    to work but any attempt to use RVC refinement on it will silently skip.
    """
    _check_admin(x_admin_token)
    dir_id = _normalize_voice_dir_id(voice_id)

    entries = _load_rvc_manifest()
    before = len(entries)
    entries = [e for e in entries if e.get("id") != dir_id]
    if len(entries) == before:
        raise HTTPException(status_code=404, detail=f"Voice not in manifest: {dir_id}")
    _save_rvc_manifest(entries)

    voice_dir = os.path.join(RVC_MODELS_DIR, dir_id)
    if os.path.isdir(voice_dir):
        shutil.rmtree(voice_dir)

    chatterbox_engine.invalidate_voice(f"cb_{dir_id}")
    log.info("RVC voice deleted: %s", dir_id)
    return {"deleted": f"rvc_{dir_id}"}


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8880"))
    uvicorn.run(app, host=host, port=port)
