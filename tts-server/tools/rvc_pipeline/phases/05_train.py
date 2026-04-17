#!/usr/bin/env python3
"""Phase 5: Applio preprocess → extract → train → index.

Stops the TTS server first to free GPU memory (the loaded Chatterbox+RVC
models eat ~22 GB of the 24 GB on the 3090). Restarts after training.

Symlinks <job_dir>/chunks → /opt/Applio/datasets/<voice_id>/ before running
Applio so the dataset path matches what Applio expects.

Streams Applio's per-epoch log lines back as JSON status events so the
orchestrator can show live training progress.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from _status import phase_run, load_input, emit


PHASE = "train"
APPLIO_DIR = Path("/opt/Applio")
APPLIO_PY = APPLIO_DIR / ".venv" / "bin" / "python"
APPLIO_DATASETS = APPLIO_DIR / "datasets"
APPLIO_LOGS = APPLIO_DIR / "logs"
TTS_UNIT = "tts-server.service"
GSV_UNIT = "gptsovits.service"


def stop_tts(run):
    run.progress(action="stopping_tts_for_gpu_memory")
    subprocess.run(["systemctl", "stop", TTS_UNIT], check=False)
    subprocess.run(["systemctl", "stop", GSV_UNIT], check=False)
    time.sleep(3)


def start_tts(run):
    run.progress(action="restarting_tts")
    subprocess.run(["systemctl", "start", TTS_UNIT], check=False)
    subprocess.run(["systemctl", "start", GSV_UNIT], check=False)


def run_applio(args, log_path: Path):
    """Run an Applio CLI command, tee stdout/stderr to log_path, return exit code."""
    with log_path.open("a") as logf:
        logf.write(f"\n\n=== {' '.join(str(a) for a in args)} ===\n")
        proc = subprocess.Popen(args, stdout=logf, stderr=subprocess.STDOUT, cwd=str(APPLIO_DIR))
        return proc.wait()


def tail_train_log(log_path: Path, run, total_epochs: int, stop_event):
    """Tail train.log and emit per-epoch progress as it appears."""
    epoch_re = re.compile(r"\| epoch=(\d+) \| step=(\d+).*?lowest_value=([\d.]+).*?smoothed_loss_gen=([\d.]+)")
    seen_epochs = set()
    last_size = 0
    while not stop_event["stop"]:
        if log_path.exists():
            sz = log_path.stat().st_size
            if sz > last_size:
                with log_path.open() as f:
                    f.seek(last_size)
                    for line in f:
                        m = epoch_re.search(line)
                        if m:
                            epoch = int(m.group(1))
                            if epoch not in seen_epochs:
                                seen_epochs.add(epoch)
                                run.progress(
                                    sub_phase="training",
                                    epoch=epoch,
                                    total_epochs=total_epochs,
                                    lowest_loss=float(m.group(3)),
                                    smoothed_loss_gen=float(m.group(4)),
                                )
                last_size = sz
        time.sleep(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-dir", required=True, type=Path)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--keep-tts-running", action="store_true",
                    help="Don't stop TTS server (only safe if dataset is tiny or you have a second GPU)")
    args = ap.parse_args()

    job_dir = args.job_dir
    with phase_run(PHASE, job_dir, force=args.force) as run:
        if run is None:
            return

        inp = load_input(job_dir)
        voice_id = inp["voice_id"]
        total_epoch = int(inp.get("total_epoch", 200))
        save_every = int(inp.get("save_every_epoch", 25))
        batch_size = int(inp.get("batch_size", 8))
        sample_rate = int(inp.get("sample_rate", 40000))

        chunks_src = job_dir / "chunks"
        wavs = list(chunks_src.glob("*.wav"))
        if not wavs:
            raise RuntimeError(f"No chunks in {chunks_src} — run extract phase first")

        # Symlink chunks into Applio datasets dir (skip if exists and points right)
        ds_link = APPLIO_DATASETS / voice_id
        APPLIO_DATASETS.mkdir(parents=True, exist_ok=True)
        if ds_link.exists() or ds_link.is_symlink():
            if ds_link.is_symlink() and ds_link.resolve() == chunks_src.resolve():
                pass
            else:
                if ds_link.is_dir() and not ds_link.is_symlink():
                    shutil.rmtree(ds_link)
                else:
                    ds_link.unlink()
                ds_link.symlink_to(chunks_src)
        else:
            ds_link.symlink_to(chunks_src)

        # Pre-clean Applio logs dir for this voice (avoid resuming stale failed run)
        logs_dir = APPLIO_LOGS / voice_id
        if logs_dir.exists():
            shutil.rmtree(logs_dir)

        train_log = job_dir / "train.log"
        train_log.write_text("")  # truncate

        if not args.keep_tts_running:
            stop_tts(run)

        try:
            # Phase 5a: preprocess
            run.progress(sub_phase="preprocess")
            rc = run_applio([
                str(APPLIO_PY), "core.py", "preprocess",
                "--model_name", voice_id,
                "--dataset_path", str(ds_link),
                "--sample_rate", str(sample_rate),
                "--cpu_cores", "8",
                "--cut_preprocess", "Automatic",
                "--process_effects", "True",
                "--noise_reduction", "False",
                "--noise_reduction_strength", "0.0",
                "--chunk_len", "3.0",
                "--overlap_len", "0.3",
                "--normalization_mode", "none",
            ], train_log)
            if rc != 0:
                raise RuntimeError(f"Applio preprocess failed (rc={rc}); see {train_log}")

            # Phase 5b: extract
            run.progress(sub_phase="extract")
            rc = run_applio([
                str(APPLIO_PY), "core.py", "extract",
                "--model_name", voice_id,
                "--f0_method", "rmvpe",
                "--cpu_cores", "8",
                "--gpu", "0",
                "--sample_rate", str(sample_rate),
                "--embedder_model", "contentvec",
                "--include_mutes", "2",
            ], train_log)
            if rc != 0:
                raise RuntimeError(f"Applio extract failed (rc={rc})")

            # Phase 5c: train (long-running)
            import threading
            stop_event = {"stop": False}
            tailer = threading.Thread(
                target=tail_train_log,
                args=(train_log, run, total_epoch, stop_event),
                daemon=True,
            )
            tailer.start()

            run.progress(sub_phase="training", epoch=0, total_epochs=total_epoch)
            rc = run_applio([
                str(APPLIO_PY), "core.py", "train",
                "--model_name", voice_id,
                "--vocoder", "HiFi-GAN",
                "--save_every_epoch", str(save_every),
                "--save_only_latest", "False",
                "--save_every_weights", "True",
                "--total_epoch", str(total_epoch),
                "--sample_rate", str(sample_rate),
                "--batch_size", str(batch_size),
                "--gpu", "0",
                "--pretrained", "True",
                "--overtraining_detector", "True",
                "--overtraining_threshold", "50",
                "--cleanup", "True",
                "--cache_data_in_gpu", "True",
                "--index_algorithm", "Auto",
            ], train_log)
            stop_event["stop"] = True
            tailer.join(timeout=5)
            if rc != 0:
                raise RuntimeError(f"Applio train failed (rc={rc}); see {train_log}")

        finally:
            if not args.keep_tts_running:
                start_tts(run)

        # Locate produced .pth (prefer last best_epoch, fall back to highest milestone)
        weights = sorted(logs_dir.glob(f"{voice_id}_*e_*_best_epoch.pth"))
        if not weights:
            weights = sorted(logs_dir.glob(f"{voice_id}_*e_*.pth"))
        if not weights:
            raise RuntimeError(f"No trained .pth found in {logs_dir}")
        index_path = logs_dir / f"{voice_id}.index"
        if not index_path.exists():
            raise RuntimeError(f"No .index found at {index_path}")

        run.done(
            best_pth=str(weights[-1].relative_to(APPLIO_DIR)),
            index=str(index_path.relative_to(APPLIO_DIR)),
            total_epochs=total_epoch,
        )


if __name__ == "__main__":
    main()
