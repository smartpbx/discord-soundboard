#!/usr/bin/env python3
"""Pick per-emotion reference clips for a Chatterbox voice.

Given a directory of target-speaker audio chunks (as produced by the RVC
training pipeline's Phase 3 cluster + Phase 4 extract), compute simple
audio features for each chunk and bucket them into the emotion slots used
by lib/tts-expression.js + tts-server's emotion presets:
  soft / neutral / excited / yell / angry / sad / happy

Heuristics (intentionally unfussy — good enough for a first pass, easy
for operators to override via the superadmin UI):

  - yell:    highest RMS + high pitch variance (shouty)
  - excited: top-quartile RMS + top-quartile pitch mean (energetic, higher)
  - angry:   top-quartile RMS + lower pitch mean (growly)
  - happy:   top-half RMS + high pitch + lower pitch variance (bright, steady)
  - neutral: median RMS, median pitch
  - soft:    bottom-quartile RMS (quiet)
  - sad:     bottom-third RMS + low pitch variance (monotone, quiet)

Each chunk is scored per emotion; the top scorer wins. We prefer chunks in
the 5–12 s range for Chatterbox references (shorter = less prosody
diversity, longer = Chatterbox truncates anyway). If the winning chunk is
>12 s, trim to the loudest 8 s window. If it's <3 s, skip that emotion.

Writes refs/<emotion>.wav under the voice's Chatterbox dir. Returns a
JSON report on stdout for the caller (tts-server admin endpoint) to show
the operator which chunk got picked for each emotion.
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

EMOTIONS = ("soft", "neutral", "excited", "yell", "angry", "sad", "happy")
MIN_CHUNK_SEC = 3.0
MAX_CHUNK_SEC = 12.0
TARGET_LEN_SEC = 8.0


def extract_features(wav_path: Path):
    """Return a dict of scalar features for one wav file, or None if unusable."""
    y, sr = librosa.load(str(wav_path), sr=16000, mono=True)
    duration = len(y) / sr
    if duration < MIN_CHUNK_SEC:
        return None
    # RMS energy (median across frames, in dB)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=256)[0]
    rms_db = 20 * np.log10(np.maximum(rms, 1e-6))
    rms_med = float(np.median(rms_db))
    rms_p90 = float(np.percentile(rms_db, 90))
    # Pitch — yin is fast and reasonably robust. Skip unvoiced frames.
    try:
        f0 = librosa.yin(y, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C6"),
                         sr=sr, frame_length=2048, hop_length=256)
        voiced = f0[(f0 > 50) & np.isfinite(f0)]
        if len(voiced) < 10:
            pitch_mean = 0.0
            pitch_std = 0.0
        else:
            pitch_mean = float(np.median(voiced))
            pitch_std = float(np.std(voiced))
    except Exception:
        pitch_mean = 0.0
        pitch_std = 0.0
    # Spectral centroid (brightness)
    sc = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    sc_med = float(np.median(sc))
    return {
        "path": str(wav_path),
        "duration": duration,
        "rms_med_db": rms_med,
        "rms_p90_db": rms_p90,
        "pitch_mean_hz": pitch_mean,
        "pitch_std_hz": pitch_std,
        "spectral_centroid": sc_med,
    }


def _z(values, target):
    arr = np.asarray(values, dtype=float)
    mu = arr.mean()
    sd = arr.std() + 1e-6
    return (target - mu) / sd


def pick_refs(features):
    """Score each chunk for each emotion; return {emotion: feature_dict}.

    Scores are a weighted sum of z-scored features. Higher is better fit.
    Rationale for weights lives in the file docstring.
    """
    if not features:
        return {}

    rms = [f["rms_p90_db"] for f in features]
    pmean = [f["pitch_mean_hz"] for f in features]
    pstd = [f["pitch_std_hz"] for f in features]
    sc = [f["spectral_centroid"] for f in features]

    chosen = {}
    for emo in EMOTIONS:
        best_idx = 0
        best_score = -float("inf")
        for i, f in enumerate(features):
            zr = _z(rms, f["rms_p90_db"])
            zm = _z(pmean, f["pitch_mean_hz"])
            zs = _z(pstd, f["pitch_std_hz"])
            zc = _z(sc, f["spectral_centroid"])
            if emo == "yell":     s = 1.0 * zr + 0.6 * zs + 0.3 * zc
            elif emo == "excited": s = 0.7 * zr + 0.6 * zm + 0.3 * zc
            elif emo == "angry":   s = 0.7 * zr - 0.4 * zm + 0.2 * zs
            elif emo == "happy":   s = 0.5 * zr + 0.8 * zm - 0.3 * zs
            elif emo == "neutral": s = -abs(zr) - abs(zm) - 0.3 * abs(zs)  # middle-of-road
            elif emo == "soft":    s = -0.9 * zr - 0.1 * zs
            elif emo == "sad":     s = -0.7 * zr - 0.5 * zs - 0.2 * zm
            else: s = 0
            if s > best_score:
                best_score = s
                best_idx = i
        chosen[emo] = {**features[best_idx], "score": best_score}
    return chosen


def trim_to_loudest_window(wav_path: Path, out_path: Path, target_sec: float = TARGET_LEN_SEC):
    """Copy wav to out_path; if longer than MAX_CHUNK_SEC, crop to the
    loudest target_sec window. Resamples to 24 kHz mono, which is what
    Chatterbox's reference loader expects.
    """
    y, sr = librosa.load(str(wav_path), sr=24000, mono=True)
    duration = len(y) / sr
    if duration <= MAX_CHUNK_SEC:
        sf.write(str(out_path), y, sr, format="WAV")
        return duration
    # slide a window; pick the one with highest RMS
    win = int(sr * target_sec)
    hop = int(sr * 0.5)
    best_start = 0
    best_rms = -float("inf")
    for start in range(0, len(y) - win, hop):
        frame_rms = float(np.sqrt(np.mean(y[start:start + win] ** 2) + 1e-12))
        if frame_rms > best_rms:
            best_rms = frame_rms
            best_start = start
    clip = y[best_start:best_start + win]
    sf.write(str(out_path), clip, sr, format="WAV")
    return target_sec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice-id", required=True, help="Chatterbox dir name (without cb_ prefix)")
    ap.add_argument("--chunks-dir", required=True, type=Path, help="Directory of speaker-clustered wav chunks")
    ap.add_argument("--cb-dir", required=True, type=Path, help="Chatterbox models dir (where <voice>/ lives)")
    ap.add_argument("--overwrite", action="store_true", help="Overwrite existing refs")
    args = ap.parse_args()

    if not args.chunks_dir.is_dir():
        print(json.dumps({"error": f"chunks dir not found: {args.chunks_dir}"}))
        sys.exit(1)

    wavs = sorted([p for p in args.chunks_dir.glob("*.wav") if p.is_file()])
    if not wavs:
        print(json.dumps({"error": f"no .wav files in {args.chunks_dir}"}))
        sys.exit(1)

    features = []
    for p in wavs:
        try:
            f = extract_features(p)
            if f: features.append(f)
        except Exception as e:
            # Skip unreadable chunks rather than failing whole run
            print(f"[warn] skipped {p.name}: {e}", file=sys.stderr)

    if not features:
        print(json.dumps({"error": "no usable chunks (all too short or unreadable)"}))
        sys.exit(1)

    chosen = pick_refs(features)
    voice_dir = args.cb_dir / args.voice_id
    refs_dir = voice_dir / "refs"
    refs_dir.mkdir(parents=True, exist_ok=True)

    report = {}
    for emo, f in chosen.items():
        src = Path(f["path"])
        dst = refs_dir / f"{emo}.wav"
        if dst.exists() and not args.overwrite:
            report[emo] = {"skipped_existing": True, "path": str(dst)}
            continue
        trimmed = trim_to_loudest_window(src, dst)
        report[emo] = {
            "chunk": src.name,
            "score": round(float(f["score"]), 3),
            "duration_sec": round(trimmed, 2),
            "rms_p90_db": round(f["rms_p90_db"], 1),
            "pitch_mean_hz": round(f["pitch_mean_hz"], 1),
            "pitch_std_hz": round(f["pitch_std_hz"], 1),
            "path": str(dst),
        }

    print(json.dumps({"ok": True, "voice_id": args.voice_id, "chunks_analyzed": len(features), "refs": report}, indent=2))


if __name__ == "__main__":
    main()
