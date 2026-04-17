"""Shared helpers: structured stdout status emission, .done sentinels."""
import json
import os
import sys
import time
from pathlib import Path
from contextlib import contextmanager


def emit(phase: str, status: str, **details):
    """Emit one newline-delimited JSON status event to stdout."""
    msg = {"phase": phase, "status": status}
    if details:
        msg["details"] = details
    print(json.dumps(msg), flush=True)


def done_path(job_dir: Path, phase: str) -> Path:
    return job_dir / "state" / f"{phase}.done"


def is_done(job_dir: Path, phase: str) -> bool:
    return done_path(job_dir, phase).exists()


def mark_done(job_dir: Path, phase: str, **details):
    p = done_path(job_dir, phase)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {"completed_at": time.time(), **details}
    p.write_text(json.dumps(payload, indent=2))


@contextmanager
def phase_run(phase: str, job_dir: Path, force: bool = False):
    """Context manager for a phase. Yields if work should run; skips otherwise.

    Usage:
        with phase_run("download", job_dir, force=args.force) as run:
            if not run:
                return
            # do work
            run.done(files=N, duration_sec=D)
    """
    if is_done(job_dir, phase) and not force:
        emit(phase, "skipped", reason="already_done")
        yield None
        return

    started = time.time()
    emit(phase, "starting")

    class Runner:
        def done(self, **details):
            details["duration_sec"] = round(time.time() - started, 2)
            mark_done(job_dir, phase, **details)
            emit(phase, "complete", **details)

        def progress(self, **details):
            emit(phase, "progress", **details)

    runner = Runner()
    try:
        yield runner
    except Exception as e:
        emit(phase, "error", message=str(e), exception=type(e).__name__)
        raise


def load_input(job_dir: Path) -> dict:
    p = job_dir / "input.json"
    if not p.exists():
        raise FileNotFoundError(f"Missing {p} — orchestrator must write input.json before phases run")
    return json.loads(p.read_text())
