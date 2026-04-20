#!/usr/bin/env python3
"""Vocal isolation wrapper around demucs (htdemucs). Pulls just the vocals
stem from a wav/mp3/m4a, writes a mono 24 kHz wav — the format every engine
wants for reference clips.

Used in two places:
  1. tts-server /admin/util/isolate-vocals endpoint (soundboard calls this
     when the operator ticks "Isolate vocals" on the YouTube/Upload preview).
  2. lite_voice_deploy.py --isolate-vocals (trainer pipeline) before dropping
     reference.wav.

Runs on CPU by default. htdemucs on GPU would be ~4x faster but the 3090
is already contested by Fish+Chatterbox+GSV, and a 60 s clip on CPU still
finishes in ~25 s — fine for interactive use.

Usage:
  ./isolate_vocals.py --input /path/in.wav --output /path/out.wav [--device cpu]
"""
import argparse
import os
import shutil
import sys
import tempfile
import time

import torch
import torchaudio
import soundfile as sf
from demucs.apply import apply_model
from demucs.pretrained import get_model
from demucs.audio import AudioFile


_MODEL_CACHE = None


def _load_model(device="cpu"):
    """Cache htdemucs — loading the weights is ~1 s that adds up across calls."""
    global _MODEL_CACHE
    if _MODEL_CACHE is None:
        m = get_model("htdemucs")
        m.to(device).eval()
        _MODEL_CACHE = (m, device)
    return _MODEL_CACHE[0]


def isolate(input_path: str, output_path: str, device: str = "cpu", target_sr: int = 24000):
    """Separate vocals with htdemucs, mix stems to mono, resample, write WAV."""
    t0 = time.time()
    model = _load_model(device=device)
    # htdemucs wants stereo 44.1 kHz — AudioFile handles the conversion.
    waveform = AudioFile(input_path).read(streams=0, samplerate=model.samplerate, channels=model.audio_channels)
    ref = waveform.mean(0)
    waveform = (waveform - ref.mean()) / ref.std()
    with torch.no_grad():
        sources = apply_model(model, waveform[None], device=device, progress=False, num_workers=0)[0]
    sources = sources * ref.std() + ref.mean()
    # Stems order for htdemucs: drums / bass / other / vocals
    vocals = sources[model.sources.index("vocals")]  # shape [channels, samples]
    # Mono-fy (mean across channels) then resample to target_sr
    vocals_mono = vocals.mean(0, keepdim=True)
    if model.samplerate != target_sr:
        vocals_mono = torchaudio.functional.resample(vocals_mono, model.samplerate, target_sr)
    peak = float(vocals_mono.abs().max()) if vocals_mono.numel() else 0.0
    if peak > 0 and peak < 0.7:
        # Boost quiet vocals so the downstream engines get good input
        gain = min(4.0, 0.95 / peak)
        vocals_mono = (vocals_mono * gain).clamp(-1.0, 1.0)
    # Use soundfile instead of torchaudio.save — newer torchaudio routes WAV
    # writes through torchcodec which isn't installed and would fail here.
    # soundfile needs [samples, channels] layout so transpose then squeeze.
    out_np = vocals_mono.cpu().numpy()
    if out_np.ndim == 2:
        out_np = out_np.T  # [samples, channels]
    sf.write(output_path, out_np, target_sr, subtype="PCM_16")
    return {
        "duration_sec": vocals_mono.shape[-1] / target_sr,
        "elapsed_sec": round(time.time() - t0, 2),
        "device": device,
        "peak_pre_gain": round(peak, 4),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    ap.add_argument("--target-sr", type=int, default=24000)
    args = ap.parse_args()
    if not os.path.exists(args.input):
        print(f"ERROR: input not found: {args.input}", file=sys.stderr)
        sys.exit(2)
    result = isolate(args.input, args.output, device=args.device, target_sr=args.target_sr)
    import json
    print(json.dumps(result))


if __name__ == "__main__":
    main()
