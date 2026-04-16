"""Kokoro TTS engine wrapper. Loads model once at startup, exposes synthesize()."""

import io
import wave
import numpy as np

_pipeline = None
_voices = None


def _get_pipeline():
    global _pipeline
    if _pipeline is None:
        from kokoro import KPipeline
        _pipeline = KPipeline(lang_code="a")  # "a" = American English
    return _pipeline


def get_voices():
    """Return list of available Kokoro voice dicts."""
    global _voices
    if _voices is not None:
        return _voices

    # Kokoro built-in voices with metadata
    raw = [
        ("af_heart", "Heart", "female"),
        ("af_alloy", "Alloy", "female"),
        ("af_aoede", "Aoede", "female"),
        ("af_bella", "Bella", "female"),
        ("af_jessica", "Jessica", "female"),
        ("af_kore", "Kore", "female"),
        ("af_nicole", "Nicole", "female"),
        ("af_nova", "Nova", "female"),
        ("af_river", "River", "female"),
        ("af_sarah", "Sarah", "female"),
        ("af_sky", "Sky", "female"),
        ("am_adam", "Adam", "male"),
        ("am_echo", "Echo", "male"),
        ("am_eric", "Eric", "male"),
        ("am_fenrir", "Fenrir", "male"),
        ("am_liam", "Liam", "male"),
        ("am_michael", "Michael", "male"),
        ("am_onyx", "Onyx", "male"),
        ("am_puck", "Puck", "male"),
        ("am_santa", "Santa", "male"),
    ]
    _voices = [
        {
            "id": vid,
            "name": name,
            "engine": "kokoro",
            "gender": gender,
            "language": "en-us",
            "group": "Built-in",
        }
        for vid, name, gender in raw
    ]
    return _voices


def get_voice_ids():
    """Return set of valid voice IDs."""
    return {v["id"] for v in get_voices()}


def synthesize(text: str, voice_id: str) -> bytes:
    """Generate speech from text. Returns WAV bytes."""
    pipeline = _get_pipeline()

    # Generate audio samples
    samples_list = []
    for result in pipeline(text, voice=voice_id):
        if result.audio is not None:
            samples_list.append(result.audio)

    if not samples_list:
        raise ValueError("Kokoro produced no audio output")

    audio = np.concatenate(samples_list)

    # Convert float32 samples to 16-bit PCM WAV
    audio_int16 = np.clip(audio * 32767, -32768, 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(24000)  # Kokoro outputs 24kHz
        wf.writeframes(audio_int16.tobytes())

    return buf.getvalue()
