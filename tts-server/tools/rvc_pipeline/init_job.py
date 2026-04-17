#!/usr/bin/env python3
"""Bootstrap a new training job directory.

Creates /tmp/voice-train/jobs/<job_id>/input.json with the parameters Claude
provides. Idempotent — re-running with the same job_id updates input.json
without disturbing already-completed phases.

Usage:
  python init_job.py --voice-id macho_man --name "Macho Man Randy Savage" \
      --group Celebrity --gender male \
      --urls https://youtube.com/watch?v=AAA https://youtube.com/watch?v=BBB \
      --speaker-markers cream macho yeah \
      --base-voice am_santa \
      [--total-epoch 200] [--batch-size 8] [--whisper-model base]

Writes job_id to stdout. The orchestrator captures it and uses it for the
remaining phase invocations (--job-dir /tmp/voice-train/jobs/<job_id>).
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path


JOBS_ROOT = Path("/tmp/voice-train/jobs")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice-id", required=True, help="lowercase id like 'macho_man'")
    ap.add_argument("--name", required=True, help="display name like 'Macho Man Randy Savage'")
    ap.add_argument("--group", default="Celebrity", choices=["Celebrity", "Cartoon", "Gaming", "Other"])
    ap.add_argument("--gender", default="male", choices=["male", "female", "unknown"])
    ap.add_argument("--urls", nargs="+", required=True, help="YouTube source URLs")
    ap.add_argument("--speaker-markers", nargs="*", default=[],
                    help="Words that strongly indicate target speaker (used for cluster labeling)")
    ap.add_argument("--base-voice", default="am_adam",
                    help="Kokoro base voice for rvc_<id> standalone (am_adam, am_santa, am_puck, etc.)")
    ap.add_argument("--default-exaggeration", type=float, default=0.7)
    ap.add_argument("--total-epoch", type=int, default=200)
    ap.add_argument("--save-every-epoch", type=int, default=25)
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--sample-rate", type=int, default=40000, choices=[32000, 40000, 48000])
    ap.add_argument("--whisper-model", default="base", choices=["tiny", "base", "small", "medium"])
    ap.add_argument("--job-id", default=None,
                    help="Override auto-generated job id (useful for resuming)")
    args = ap.parse_args()

    if not re.match(r"^[a-z][a-z0-9_]{1,31}$", args.voice_id):
        print(f"ERROR: voice-id must be lowercase letters/digits/underscores (got {args.voice_id})", file=sys.stderr)
        sys.exit(1)

    job_id = args.job_id or f"{args.voice_id}_{int(time.time())}"
    job_dir = JOBS_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "state").mkdir(exist_ok=True)

    input_data = {
        "voice_id": args.voice_id,
        "name": args.name,
        "group": args.group,
        "gender": args.gender,
        "urls": args.urls,
        "speaker_markers": args.speaker_markers,
        "base_voice": args.base_voice,
        "default_exaggeration": args.default_exaggeration,
        "total_epoch": args.total_epoch,
        "save_every_epoch": args.save_every_epoch,
        "batch_size": args.batch_size,
        "sample_rate": args.sample_rate,
        "whisper_model": args.whisper_model,
        "created_at": time.time(),
    }
    (job_dir / "input.json").write_text(json.dumps(input_data, indent=2))
    print(json.dumps({"job_id": job_id, "job_dir": str(job_dir)}))


if __name__ == "__main__":
    main()
