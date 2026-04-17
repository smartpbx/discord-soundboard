#!/usr/bin/env python3
"""Phase 4: extract clean target-speaker chunks from raw clips.

Reads cluster_results.json, merges consecutive kept segments (gap ≤ 0.6s),
and ffmpeg-extracts each merged run from the source WAV. Output is 40 kHz
mono PCM16 (Applio's expected sample rate for RVC v2 training).

Outputs to <job_dir>/chunks/<NNNN>_<source>_<start>.wav.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from _status import phase_run, load_input, emit


PHASE = "extract"
GAP_TOL_SEC = 0.6
MIN_RUN_SEC = 1.5
TARGET_SR = 40000


def merge_runs(segments, gap_tol=GAP_TOL_SEC):
    runs = []
    for s in segments:
        if not s.get("kept", True):
            continue
        if runs and s["start"] - runs[-1]["end"] <= gap_tol:
            runs[-1]["end"] = s["end"]
        else:
            runs.append({"start": s["start"], "end": s["end"]})
    return runs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-dir", required=True, type=Path)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    job_dir = args.job_dir
    with phase_run(PHASE, job_dir, force=args.force) as run:
        if run is None:
            return

        results = json.loads((job_dir / "cluster_results.json").read_text())
        raw_dir = job_dir / "raw"
        out_dir = job_dir / "chunks"
        out_dir.mkdir(parents=True, exist_ok=True)
        for f in out_dir.glob("*.wav"):
            f.unlink()  # always rebuild from cluster results (lightweight)

        wavs = {w.stem: w for w in raw_dir.glob("*.wav")}

        idx = 0
        total_sec = 0.0
        for stem, info in sorted(results.items()):
            src = wavs.get(stem)
            if not src:
                continue
            runs = merge_runs(info["segments"])
            run.progress(clip=stem, runs=len(runs))
            for r in runs:
                dur = r["end"] - r["start"]
                if dur < MIN_RUN_SEC:
                    continue
                idx += 1
                start_int = int(r["start"])
                dst = out_dir / f"{idx:04d}_{stem}_{start_int}.wav"
                cmd = [
                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-ss", str(r["start"]), "-to", str(r["end"]),
                    "-i", str(src),
                    "-ac", "1", "-ar", str(TARGET_SR),
                    "-c:a", "pcm_s16le", str(dst),
                ]
                subprocess.run(cmd, check=True)
                total_sec += dur

        run.done(chunks=idx, total_minutes=round(total_sec / 60, 2), sample_rate=TARGET_SR)


if __name__ == "__main__":
    main()
