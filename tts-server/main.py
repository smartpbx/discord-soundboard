"""TTS Service -- FastAPI app exposing Kokoro + RVC for the Discord soundboard."""

# Monkey-patch Python's dataclass mutable default detection BEFORE fairseq is imported.
# fairseq 0.12.2 assigns dataclass classes as field defaults (e.g. `common: CommonConfig = CommonConfig`).
# Python 3.11+ rejects this in _process_class(). We patch _process_class to auto-wrap
# mutable defaults with default_factory.
import dataclasses as _dc
if hasattr(_dc, '_process_class'):
    _orig_process = _dc._process_class
    def _patched_process(cls, init, repr, eq, order, unsafe_hash, frozen, match_args, kw_only, slots, weakref_slot):
        # Before processing, fix any mutable class defaults
        for name, val in list(cls.__dict__.items()):
            if isinstance(val, type) and _dc.is_dataclass(val):
                setattr(cls, name, _dc.field(default_factory=val))
        return _orig_process(cls, init, repr, eq, order, unsafe_hash, frozen, match_args, kw_only, slots, weakref_slot)
    _dc._process_class = _patched_process

import os
import time
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tts-server")

app = FastAPI(title="TTS Service", version="1.1.0")

# ---------------------------------------------------------------------------
# Engine loading (lazy -- first request triggers model load)
# ---------------------------------------------------------------------------

from engines import kokoro_engine, rvc_engine  # noqa: E402


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice_id: str = Field(..., min_length=1)
    rvc_model_id: Optional[str] = None


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
    if rvc_engine.get_voices():
        engines.append("rvc")
    return {"status": "ok", "engines": engines}


@app.get("/voices", response_model=list[VoiceInfo])
def voices():
    all_voices = kokoro_engine.get_voices()
    all_voices.extend(rvc_engine.get_voices())
    return all_voices


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is empty")

    voice_id = req.voice_id
    rvc_model_id = req.rvc_model_id

    # If the voice_id itself is an RVC voice, use it for conversion with a default Kokoro base
    rvc_ids = rvc_engine.get_rvc_model_ids()
    if voice_id in rvc_ids:
        rvc_model_id = voice_id
        voice_id = "af_heart"  # Default base voice for RVC

    # Validate base voice
    valid_kokoro = kokoro_engine.get_voice_ids()
    if voice_id not in valid_kokoro:
        raise HTTPException(status_code=400, detail=f"Unknown voice_id: {voice_id}")

    # Validate RVC model if specified
    if rvc_model_id and rvc_model_id not in rvc_ids:
        raise HTTPException(status_code=400, detail=f"Unknown RVC model: {rvc_model_id}")

    log.info("synthesize voice=%s rvc=%s text_len=%d text_preview=%.60s",
             voice_id, rvc_model_id or "none", len(text), text)
    t0 = time.time()

    # Step 1: Generate base audio with Kokoro
    try:
        wav_bytes = kokoro_engine.synthesize(text, voice_id)
    except Exception as e:
        log.error("kokoro synthesis failed: %s", e)
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {e}")

    t_tts = time.time() - t0
    log.info("kokoro done in %.2fs, %d bytes", t_tts, len(wav_bytes))

    # Step 2: Voice conversion with RVC (if requested)
    if rvc_model_id:
        t1 = time.time()
        try:
            wav_bytes = rvc_engine.convert(wav_bytes, rvc_model_id)
        except Exception as e:
            log.error("RVC conversion failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Voice conversion failed: {e}")
        t_rvc = time.time() - t1
        log.info("RVC done in %.2fs, %d bytes", t_rvc, len(wav_bytes))

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
