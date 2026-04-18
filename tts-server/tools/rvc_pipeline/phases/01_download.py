#!/usr/bin/env python3
"""Phase 1: download YouTube audio for each URL in input.json.

Outputs to <job_dir>/raw/<NN>_<sanitized_title>.wav. Skips URLs whose
output file already exists. yt-dlp is invoked as a subprocess.

Downloads run in a small thread pool so a multi-URL job doesn't wait
for each clip to finish before starting the next — YouTube throttles
aggressive parallelism so we cap at MAX_CONCURRENT_DOWNLOADS.
"""
import argparse
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from _status import phase_run, load_input, emit


PHASE = "download"
YT_DLP = "/usr/local/bin/yt-dlp"
MAX_CONCURRENT_DOWNLOADS = 3


def sanitize(title: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9_-]+", "_", title.lower()).strip("_")
    return s[:60] or "clip"


def download_one(url: str, raw_dir: Path, idx: int) -> Path | None:
    out_template = str(raw_dir / f"{idx:02d}_%(title).60s.%(ext)s")
    cmd = [
        YT_DLP, "-q", "--no-playlist", "--no-warnings",
        "-f", "bestaudio",
        "-x", "--audio-format", "wav", "--audio-quality", "0",
        "-o", out_template,
        "--print", "after_move:filepath",
        url,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)
        path_line = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""
        return Path(path_line) if path_line else None
    except subprocess.CalledProcessError as e:
        emit(PHASE, "progress", url=url, error=(e.stderr or e.stdout or "yt-dlp failed").strip()[:300])
        return None
    except subprocess.TimeoutExpired:
        emit(PHASE, "progress", url=url, error="yt-dlp timeout (>5 min)")
        return None


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
        urls = inp.get("urls", [])
        if not urls:
            raise ValueError("input.json has no 'urls' field — orchestrator must populate it")

        raw_dir = job_dir / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)

        downloaded = []
        completed = 0
        total = len(urls)
        run.progress(current=0, total=total)
        with ThreadPoolExecutor(max_workers=min(MAX_CONCURRENT_DOWNLOADS, total)) as ex:
            futures = {ex.submit(download_one, url, raw_dir, i): url for i, url in enumerate(urls, start=1)}
            for fut in as_completed(futures):
                completed += 1
                url = futures[fut]
                try:
                    path = fut.result()
                except Exception as e:
                    emit(PHASE, "progress", url=url, error=str(e)[:300])
                    path = None
                if path and path.exists():
                    downloaded.append(str(path.relative_to(job_dir)))
                run.progress(current=completed, total=total, url=url)

        if not downloaded:
            raise RuntimeError("All downloads failed")

        run.done(files=len(downloaded), urls_count=total, output_dir="raw/")


if __name__ == "__main__":
    main()
