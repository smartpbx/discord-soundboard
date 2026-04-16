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

from engines import kokoro_engine, rvc_engine, chatterbox_engine, gptsovits_engine  # noqa: E402


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice_id: str = Field(..., min_length=1)
    rvc_model_id: Optional[str] = None
    use_rvc: bool = True  # When True, pipe Chatterbox output through RVC if available
    exaggeration: float = Field(0.5, ge=0.25, le=2.0)  # Chatterbox emotion intensity


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
    return all_voices


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is empty")

    voice_id = req.voice_id
    t0 = time.time()

    cb_ids = chatterbox_engine.get_voice_ids()
    rvc_ids = rvc_engine.get_rvc_model_ids()
    kokoro_ids = kokoro_engine.get_voice_ids()
    gsv_ids = gptsovits_engine.get_voice_ids()

    # -----------------------------------------------------------------------
    # Route 1: Chatterbox celebrity voice (cb_trump, cb_obama, etc.)
    # Optionally refined through RVC
    # -----------------------------------------------------------------------
    if voice_id in cb_ids:
        log.info("synthesize [chatterbox] voice=%s text_len=%d text_preview=%.60s",
                 voice_id, len(text), text)

        try:
            wav_bytes = chatterbox_engine.synthesize(text, voice_id, exaggeration=req.exaggeration)
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
# Startup
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8880"))
    uvicorn.run(app, host=host, port=port)
