#!/usr/bin/env python3
"""Phase 2: Whisper-transcribe each raw WAV.

Outputs <job_dir>/transcripts/<basename>.json with segments[start, end, text].
Uses the Whisper install in the GPT-SoVITS venv (already on CT 110). The
model name is configurable via input.json's `whisper_model` (default "base").
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from _status import phase_run, load_input, emit


PHASE = "transcribe"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-dir", required=True, type=Path)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    job_dir = args.job_dir
    with phase_run(PHASE, job_dir, force=args.force) as run:
        if run is None:
            return

        inp = load_input(job_dir)
        whisper_model = inp.get("whisper_model", "base")

        raw_dir = job_dir / "raw"
        out_dir = job_dir / "transcripts"
        out_dir.mkdir(parents=True, exist_ok=True)

        wavs = sorted(raw_dir.glob("*.wav"))
        if not wavs:
            raise RuntimeError(f"No WAVs in {raw_dir} — run download phase first")

        import whisper  # type: ignore
        model = whisper.load_model(whisper_model)

        total_segments = 0
        for i, wav in enumerate(wavs, start=1):
            out = out_dir / (wav.stem + ".json")
            if out.exists() and not args.force:
                continue
            run.progress(current=i, total=len(wavs), file=wav.name)
            r = model.transcribe(str(wav), verbose=False)
            segs = [
                {"start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"].strip()}
                for s in r["segments"]
            ]
            out.write_text(json.dumps(segs, indent=2))
            total_segments += len(segs)

        run.done(files=len(wavs), total_segments=total_segments, model=whisper_model)


if __name__ == "__main__":
    main()
