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
# Hard cap per clip. Claude will happily pick a full 2-hour Theo Von
# episode otherwise, which means Whisper-transcribing ~10 hours of audio.
# 10 min × 10 clips = plenty for training; operator can raise via --per-clip-cap-sec.
DEFAULT_PER_CLIP_CAP_SEC = 600
# Global cap across all clips combined. Defensive second layer so an
# operator override with --per-clip-cap-sec 3600 can't still blow up.
DEFAULT_TOTAL_CAP_SEC = 3600


def sanitize(title: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9_-]+", "_", title.lower()).strip("_")
    return s[:60] or "clip"


def download_one(url: str, raw_dir: Path, idx: int, per_clip_cap_sec: int) -> Path | None:
    out_template = str(raw_dir / f"{idx:02d}_%(title).60s.%(ext)s")
    cmd = [
        YT_DLP, "-q", "--no-playlist", "--no-warnings",
        "-f", "bestaudio",
        "-x", "--audio-format", "wav", "--audio-quality", "0",
        "-o", out_template,
        # --download-sections tells yt-dlp to only grab a time range server-side
        # so we never fetch (or transcode) the parts we'll throw away.
        "--download-sections", f"*0-{per_clip_cap_sec}",
        "--force-keyframes-at-cuts",
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
    ap.add_argument("--per-clip-cap-sec", type=int, default=DEFAULT_PER_CLIP_CAP_SEC,
                    help="Trim each source URL to this many seconds via yt-dlp --download-sections. "
                         "Prevents Claude picking a 2-hour podcast and drowning Whisper in raw audio.")
    ap.add_argument("--total-cap-sec", type=int, default=DEFAULT_TOTAL_CAP_SEC,
                    help="Global cap across all clips combined — downloads stop once total raw audio exceeds this.")
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
        run.progress(current=0, total=total, per_clip_cap_sec=args.per_clip_cap_sec, total_cap_sec=args.total_cap_sec)
        with ThreadPoolExecutor(max_workers=min(MAX_CONCURRENT_DOWNLOADS, total)) as ex:
            futures = {ex.submit(download_one, url, raw_dir, i, args.per_clip_cap_sec): url for i, url in enumerate(urls, start=1)}
            total_dur_sec = 0
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
                    # Probe duration; enforce the global budget cap.
                    try:
                        p = subprocess.run(
                            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                             "-of", "default=nw=1:nk=1", str(path)],
                            capture_output=True, text=True, timeout=15, check=True,
                        )
                        total_dur_sec += float((p.stdout or "0").strip() or 0)
                    except Exception:
                        pass
                run.progress(current=completed, total=total, url=url, total_dur_sec=round(total_dur_sec, 1))
                if total_dur_sec >= args.total_cap_sec:
                    emit(PHASE, "progress", total_dur_sec=round(total_dur_sec, 1),
                         warning=f"Global cap {args.total_cap_sec}s reached — skipping any remaining URLs.")
                    # Cancel pending downloads so we don't keep fetching
                    for pending_fut in futures:
                        if not pending_fut.done(): pending_fut.cancel()
                    break

        if not downloaded:
            raise RuntimeError("All downloads failed")

        run.done(files=len(downloaded), urls_count=total, output_dir="raw/",
                 total_dur_sec=round(total_dur_sec, 1),
                 per_clip_cap_sec=args.per_clip_cap_sec)


if __name__ == "__main__":
    main()
