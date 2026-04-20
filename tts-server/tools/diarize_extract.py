#!/usr/bin/env python3
"""Speaker diarization + dominant-speaker extraction for one audio file.

Takes an audio clip that contains ≥2 speakers (interview, podcast, debate)
and writes out a new wav containing only the dominant speaker's segments,
concatenated with short crossfades.

Approach:
  1. Resample to 16 kHz mono (resemblyzer's native rate)
  2. Slide a 1.5 s window across with 0.5 s hop, producing per-frame
     d-vector embeddings via resemblyzer.VoiceEncoder
  3. KMeans n=2 on those embeddings (2 speakers is the common case;
     for 3+ speakers the dominant cluster still wins)
  4. Pick the cluster with the most total frame time — that's the
     "dominant" speaker. Snap cluster labels to contiguous runs.
  5. ffmpeg-concat the dominant-speaker runs with 30 ms crossfades, write
     target wav at the caller's requested sample rate.

Must run in the GPT-SoVITS venv (/opt/GPT-SoVITS/.venv/bin/python) — that's
where resemblyzer is installed. tts-server subprocess-invokes this script.

Usage:
  /opt/GPT-SoVITS/.venv/bin/python diarize_extract.py \
      --input /tmp/source.wav --output /tmp/target.wav --target-sr 24000
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np


def _emit(evt, **kw):
    print(json.dumps({"ts": int(time.time()), "event": evt, **kw}), flush=True)


def _resample_to_16k_mono(in_path, out_path):
    subprocess.run([
        "ffmpeg", "-y", "-nostdin", "-loglevel", "error",
        "-i", in_path, "-ar", "16000", "-ac", "1", out_path,
    ], check=True, timeout=120)


def _merge_short_gaps(segments, min_gap_ms=200):
    """Fold segments separated by <min_gap_ms back into a single run."""
    if not segments: return segments
    merged = [segments[0]]
    for s in segments[1:]:
        if s[0] - merged[-1][1] <= min_gap_ms / 1000.0:
            merged[-1] = (merged[-1][0], s[1])
        else:
            merged.append(s)
    return merged


def diarize(in_path: str, out_path: str, target_sr: int = 24000):
    from resemblyzer import VoiceEncoder, preprocess_wav
    from sklearn.cluster import KMeans
    import soundfile as sf

    t0 = time.time()
    # resemblyzer's preprocess_wav normalizes + VAD-trims already
    wav = preprocess_wav(Path(in_path))
    if wav.shape[0] < 16000 * 2:  # under 2 s of speech after VAD
        raise RuntimeError("Too little speech after VAD (need ≥2 s)")

    encoder = VoiceEncoder(device="cpu")  # GPU would be ~2x faster but shares VRAM
    # Continuous embedding track: returns (rate, embeds, wav_splits)
    rate = 16  # partials per second (resemblyzer default)
    _mean_emb, embeds, wav_splits = encoder.embed_utterance(
        wav, return_partials=True, rate=rate,
    )
    if embeds.shape[0] < 4:
        raise RuntimeError("Too few embedding frames — clip is too short or too monotone")

    # KMeans with n=2. For 3+ speaker clips the dominant cluster still
    # separates cleanly — we don't need to identify every speaker, just
    # find the biggest one.
    k = 2 if embeds.shape[0] >= 8 else 1
    if k == 1:
        labels = np.zeros(embeds.shape[0], dtype=int)
    else:
        km = KMeans(n_clusters=k, n_init=10, random_state=42).fit(embeds)
        labels = km.labels_

    # Per-cluster total frame count → dominant label
    counts = np.bincount(labels)
    dominant = int(np.argmax(counts))
    _emit("diarize_clusters", sizes={str(i): int(c) for i, c in enumerate(counts)},
          dominant=dominant, frames=int(embeds.shape[0]))

    # Convert frame indices → seconds using wav_splits (which are slices
    # into the preprocessed 16 kHz signal). 1 frame ≈ 1/rate seconds of
    # centered window, but wav_splits gives us exact bounds.
    segs = []
    for i, sp in enumerate(wav_splits):
        if labels[i] != dominant: continue
        start_s = sp.start / 16000.0
        end_s = sp.stop / 16000.0
        segs.append((start_s, end_s))
    segs = _merge_short_gaps(segs, min_gap_ms=250)
    total_target = sum(e - s for s, e in segs)
    if total_target < 0.5:
        raise RuntimeError("Dominant speaker produced <0.5 s of audio; clip may be too short or embeddings noisy")
    _emit("diarize_segments", count=len(segs), total_sec=round(total_target, 2))

    # Use soundfile to write only the dominant-speaker samples, crossfaded.
    # Read from the preprocessed wav (16 kHz mono) so frame math lines up.
    crossfade_ms = 30
    fade_n = int(16000 * crossfade_ms / 1000.0)
    parts = []
    for s, e in segs:
        i0 = max(0, int(s * 16000))
        i1 = min(wav.shape[0], int(e * 16000))
        if i1 > i0:
            parts.append(wav[i0:i1].astype(np.float32))
    if not parts: raise RuntimeError("No dominant-speaker samples after slicing")
    if len(parts) == 1:
        out = parts[0]
    else:
        out = parts[0]
        for nxt in parts[1:]:
            if out.shape[0] >= fade_n and nxt.shape[0] >= fade_n:
                ramp_down = np.linspace(1.0, 0.0, fade_n, dtype=np.float32)
                ramp_up = np.linspace(0.0, 1.0, fade_n, dtype=np.float32)
                tail = out[-fade_n:] * ramp_down
                head = nxt[:fade_n] * ramp_up
                out = np.concatenate([out[:-fade_n], tail + head, nxt[fade_n:]])
            else:
                out = np.concatenate([out, nxt])
    # Peak-normalize so the result isn't quieter than the input
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 0 and peak < 0.85:
        out = np.clip(out * (0.95 / peak), -1.0, 1.0).astype(np.float32)

    # Write at 16 kHz first, then ffmpeg-resample to target
    tmp16 = out_path + ".16k.wav"
    sf.write(tmp16, out, 16000, subtype="PCM_16")
    if target_sr != 16000:
        subprocess.run([
            "ffmpeg", "-y", "-nostdin", "-loglevel", "error",
            "-i", tmp16, "-ar", str(target_sr), "-ac", "1", out_path,
        ], check=True, timeout=60)
        try: os.remove(tmp16)
        except Exception: pass
    else:
        os.replace(tmp16, out_path)

    return {
        "duration_sec": round(total_target, 2),
        "cluster_sizes": {str(i): int(c) for i, c in enumerate(counts)},
        "dominant_cluster": dominant,
        "num_clusters": k,
        "elapsed_sec": round(time.time() - t0, 2),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--target-sr", type=int, default=24000)
    args = ap.parse_args()
    if not os.path.exists(args.input):
        print(f"ERROR: input not found: {args.input}", file=sys.stderr)
        sys.exit(2)
    try:
        result = diarize(args.input, args.output, target_sr=args.target_sr)
        _emit("done", **result)
    except Exception as e:
        _emit("error", message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
