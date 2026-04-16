"""TTS Service -- FastAPI app exposing Kokoro (and future engines) for the Discord soundboard."""

import os
import time
import logging

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts-server")

app = FastAPI(title="TTS Service", version="1.0.0")

# ---------------------------------------------------------------------------
# Engine loading (lazy -- first request triggers model load)
# ---------------------------------------------------------------------------

from engines import kokoro_engine  # noqa: E402


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice_id: str = Field(..., min_length=1)


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
    return {"status": "ok", "engines": ["kokoro"]}


@app.get("/voices", response_model=list[VoiceInfo])
def voices():
    return kokoro_engine.get_voices()


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is empty")

    voice_id = req.voice_id
    valid_ids = kokoro_engine.get_voice_ids()
    if voice_id not in valid_ids:
        raise HTTPException(status_code=400, detail=f"Unknown voice_id: {voice_id}")

    log.info("synthesize voice=%s text_len=%d text_preview=%.60s", voice_id, len(text), text)
    t0 = time.time()

    try:
        wav_bytes = kokoro_engine.synthesize(text, voice_id)
    except Exception as e:
        log.error("synthesis failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {e}")

    elapsed = time.time() - t0
    log.info("synthesize done in %.2fs, %d bytes", elapsed, len(wav_bytes))

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
