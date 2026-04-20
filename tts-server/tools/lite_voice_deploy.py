#!/usr/bin/env python3
"""Lite voice deployment for engines that DON'T need RVC training.

For Chatterbox / Fish / GSV, all we need is one clean reference clip + (for
GSV) a Whisper transcript. No multi-phase training, no Applio. This script:

  1. Downloads the source URL with yt-dlp (or reads a local file)
  2. ffmpeg-trims [start, end] and converts to the engine's expected format
  3. Whisper-transcribes the trim for ref_text (Chatterbox + GSV need this;
     Fish uses inline tags so the transcript is metadata-only)
  4. Writes reference.wav + metadata.json into models/<engine>/<voice_id>/
  5. Hits POST /admin/voices/<engine>/<voice_id>/invalidate-cache so
     /voices picks up the new entry without restarting tts-server

Voice-trainer agent invokes this when target_engine is fish/gptsovits/
chatterbox. RVC stays on the existing six-phase pipeline.

Usage:
  ./lite_voice_deploy.py --voice-id theo_von --name "Theo Von" \
      --group Celebrity --gender male --engine fish \
      --source-url https://youtu.be/abc123 --start 30 --end 42

  ./lite_voice_deploy.py --voice-id local_clip --name "Local Clip" \
      --engine gptsovits --source-file /tmp/clip.wav --start 0 --end 8

Emits newline-delimited JSON to stdout so the parent agent can parse milestones.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

MODELS_ROOT = Path("/opt/discord-soundboard/tts-server/models")
WHISPER_PY = "/opt/GPT-SoVITS/.venv/bin/python"
TTS_API = os.environ.get("TTS_API_URL_INTERNAL", "http://localhost:8880")
ENGINE_DIRS = {"chatterbox": "chatterbox", "fish": "fish", "gptsovits": "gptsovits"}


def emit(event, **kw):
    payload = {"ts": int(time.time()), "event": event, **kw}
    print(json.dumps(payload), flush=True)


def run(cmd, **kw):
    """Subprocess.run with sane defaults; raises with truncated stderr on fail."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=True, **kw)
    except subprocess.CalledProcessError as e:
        tail = (e.stderr or e.stdout or "")[-400:]
        raise RuntimeError(f"{cmd[0]} failed (exit {e.returncode}): {tail}") from e


def fetch_source(args, work_dir):
    """Download or copy the source media to <work_dir>/source.<ext>."""
    if args.source_file:
        src = Path(args.source_file).expanduser().resolve()
        if not src.exists():
            raise RuntimeError(f"--source-file not found: {src}")
        dest = work_dir / ("source" + src.suffix)
        shutil.copy2(src, dest)
        emit("source_local", path=str(dest), bytes=dest.stat().st_size)
        return dest
    if not args.source_url:
        raise RuntimeError("Either --source-url or --source-file required")
    out_template = str(work_dir / "source.%(ext)s")
    emit("source_download_start", url=args.source_url)
    run([
        "yt-dlp", "--quiet", "--no-warnings",
        "-f", "bestaudio/best",
        "-o", out_template,
        "--no-playlist",
        args.source_url,
    ], timeout=600)
    matches = list(work_dir.glob("source.*"))
    if not matches:
        raise RuntimeError("yt-dlp finished but no source file appeared")
    src = matches[0]
    emit("source_download_done", path=str(src), bytes=src.stat().st_size)
    return src


def trim_for_engine(src, start, end, engine, out_path):
    """ffmpeg-trim [start,end] and resample/format for the target engine.

    Chatterbox + Fish: 24 kHz mono WAV (engine-friendly).
    GSV: 32 kHz mono WAV, max 8 s clip (per gptsovits engine constraints).
    """
    duration = max(0.5, end - start)
    if engine == "gptsovits":
        # GSV's reference must be ≤10 s and 32 kHz mono.
        duration = min(duration, 8.0)
        ar = "32000"
    else:
        ar = "24000"
    cmd = [
        "ffmpeg", "-y", "-nostdin", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-i", str(src),
        "-t", f"{duration:.3f}",
        "-ar", ar, "-ac", "1",
        str(out_path),
    ]
    run(cmd, timeout=120)
    if not out_path.exists() or out_path.stat().st_size < 1024:
        raise RuntimeError(f"ffmpeg trim produced unusable output at {out_path}")
    emit("trim_done", path=str(out_path), bytes=out_path.stat().st_size, duration=round(duration, 2), sample_rate=int(ar))


def whisper_transcribe(wav_path):
    """Shell out to GPT-SoVITS venv's whisper for ref_text."""
    if not Path(WHISPER_PY).exists():
        raise RuntimeError(f"Whisper venv not found at {WHISPER_PY}")
    script = (
        "import whisper, json, sys\n"
        "m = whisper.load_model('base')\n"
        f"r = m.transcribe({str(wav_path)!r}, language='en', verbose=False)\n"
        "sys.stdout.write(json.dumps({'text': r.get('text','').strip()}))\n"
    )
    proc = run([WHISPER_PY, "-c", script], timeout=300)
    try:
        return json.loads(proc.stdout)["text"]
    except Exception as e:
        raise RuntimeError(f"Whisper output unparseable: {e}; raw: {proc.stdout[:200]}")


def invalidate_cache(engine):
    """Tell tts-server to drop its in-process voice cache for this engine."""
    try:
        import urllib.request
        req = urllib.request.Request(
            f"{TTS_API}/admin/voices/{engine}/_cache-bust",
            method="POST",
            headers={"X-Admin-Token": os.environ.get("ADMIN_TOKEN", "")},
        )
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as e:
        emit("cache_invalidate_warning", engine=engine, error=str(e))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice-id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--group", default="Celebrity", choices=["Celebrity", "Cartoon", "Gaming", "Other"])
    ap.add_argument("--gender", default="male", choices=["male", "female", "unknown"])
    ap.add_argument("--engine", required=True, choices=list(ENGINE_DIRS.keys()))
    ap.add_argument("--source-url", help="YouTube/etc URL — passed to yt-dlp")
    ap.add_argument("--source-file", help="Local audio file (alternative to --source-url)")
    ap.add_argument("--start", type=float, default=0.0, help="Trim start (sec)")
    ap.add_argument("--end", type=float, default=15.0, help="Trim end (sec)")
    ap.add_argument("--ref-text", help="Override Whisper transcript (rare)")
    ap.add_argument("--language", default="en")
    ap.add_argument("--default-exaggeration", type=float, default=None,
                    help="Chatterbox only — initial expression slider value (0.25–2.0)")
    ap.add_argument("--isolate-vocals", action="store_true",
                    help="Run demucs vocal isolation on the trimmed clip before deploying. Adds ~25s CPU time; useful when source has background music/noise.")
    args = ap.parse_args()

    if args.end <= args.start:
        emit("error", message="--end must be greater than --start")
        sys.exit(2)
    if not args.source_url and not args.source_file:
        emit("error", message="provide --source-url or --source-file")
        sys.exit(2)

    voice_id = args.voice_id.strip().lower()
    engine_dir = MODELS_ROOT / ENGINE_DIRS[args.engine] / voice_id
    engine_dir.mkdir(parents=True, exist_ok=True)
    work_dir = Path(f"/tmp/lite_voice_{voice_id}_{int(time.time())}")
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        emit("start", voice_id=voice_id, engine=args.engine, dest=str(engine_dir))
        src = fetch_source(args, work_dir)

        ref_path = engine_dir / "reference.wav"
        trim_for_engine(src, args.start, args.end, args.engine, ref_path)

        if args.isolate_vocals:
            emit("isolate_start")
            iso_out = work_dir / "vocals.wav"
            try:
                import importlib.util as _iu
                tool = Path(__file__).parent / "isolate_vocals.py"
                spec = _iu.spec_from_file_location("isolate_vocals", tool)
                mod = _iu.module_from_spec(spec)
                spec.loader.exec_module(mod)
                target_sr = 32000 if args.engine == "gptsovits" else 24000
                iso_meta = mod.isolate(str(ref_path), str(iso_out), device="cpu", target_sr=target_sr)
                shutil.move(str(iso_out), str(ref_path))
                emit("isolate_done", elapsed_sec=iso_meta["elapsed_sec"], peak_pre_gain=iso_meta["peak_pre_gain"])
            except Exception as e:
                emit("isolate_warning", message=str(e))  # non-fatal — keep raw clip

        ref_text = args.ref_text.strip() if args.ref_text else None
        if not ref_text:
            emit("transcribe_start")
            ref_text = whisper_transcribe(ref_path)
            emit("transcribe_done", chars=len(ref_text), preview=ref_text[:120])

        if not ref_text:
            raise RuntimeError("Whisper produced empty transcript and no --ref-text override")

        meta_path = engine_dir / "metadata.json"
        existing = {}
        if meta_path.exists():
            try: existing = json.loads(meta_path.read_text())
            except Exception: pass
        meta = {**existing}
        meta.update({
            "name": args.name,
            "gender": args.gender,
            "group": args.group,
            "language": args.language,
            "ref_text": ref_text,
            "updated_at": int(time.time()),
        })
        if args.source_url:
            meta["source_kind"] = "youtube"
            meta["source_url"] = args.source_url
        elif args.source_file:
            meta["source_kind"] = "upload"
            meta["source_filename"] = Path(args.source_file).name
        meta["source_start"] = float(args.start)
        meta["source_end"] = float(args.end)
        if args.engine == "chatterbox" and args.default_exaggeration is not None:
            meta["default_exaggeration"] = float(args.default_exaggeration)
        meta_path.write_text(json.dumps(meta, indent=2))
        emit("metadata_written", path=str(meta_path))

        invalidate_cache(args.engine)
        prefix = {"fish": "fish_", "gptsovits": "gsv_", "chatterbox": "cb_"}[args.engine]
        emit("done", voice_id=prefix + voice_id, ref_text_preview=ref_text[:120])
    except Exception as e:
        emit("error", message=str(e))
        sys.exit(1)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
