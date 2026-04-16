"""TTS Service -- FastAPI app exposing Kokoro + Chatterbox + RVC for the Discord soundboard."""

import os
import time
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts-server")

app = FastAPI(title="TTS Service", version="2.0.0")

# ---------------------------------------------------------------------------
# Engine loading (lazy -- first request triggers model load)
# ---------------------------------------------------------------------------

from engines import kokoro_engine, rvc_engine, chatterbox_engine  # noqa: E402


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice_id: str = Field(..., min_length=1)
    rvc_model_id: Optional[str] = None
    use_rvc: bool = True  # When True, pipe Chatterbox output through RVC if available


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

    # -----------------------------------------------------------------------
    # Route 1: Chatterbox celebrity voice (cb_trump, cb_obama, etc.)
    # Optionally refined through RVC
    # -----------------------------------------------------------------------
    if voice_id in cb_ids:
        log.info("synthesize [chatterbox] voice=%s text_len=%d text_preview=%.60s",
                 voice_id, len(text), text)

        try:
            wav_bytes = chatterbox_engine.synthesize(text, voice_id)
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
    # Route 3: Plain Kokoro voice (af_heart, am_adam, etc.)
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

if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8880"))
    uvicorn.run(app, host=host, port=port)
