#!/usr/bin/env python3
"""Phase 6: deploy trained model, auto-create Chatterbox pair, generate A/B audio.

Steps:
  1. Back up existing rvc/<voice_id>/ if present (to rvc/<voice_id>.bak/).
  2. Copy trained .pth + .index from Applio's logs dir to TTS models/rvc/<voice_id>/.
  3. Add or update entry in models/rvc/manifest.json.
  4. Restart TTS server so new RVC model is picked up.
  5. If no cb_<voice_id> Chatterbox voice exists yet, auto-create one by:
     - Picking a 6-12s chunk from the training dataset (speaker-clustered,
       so it's pure target speech)
     - Resampling to 24 kHz mono (Chatterbox reference format)
     - PUT-ing it to TTS server /voices/chatterbox/{id} with metadata
  6. Synthesize 4 benchmark phrases twice each (Chatterbox-only vs Chatterbox+RVC)
     and write to <job_dir>/benchmark/.

The Chatterbox metadata's `skip_rvc` starts as **false** (RVC active) so the
new trained model kicks in immediately on the first listen. Deploy remains
reversible — the human can flip `skip_rvc=true` or delete either pairing.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from _status import phase_run, load_input, emit


PHASE = "deploy"
APPLIO_DIR = Path("/opt/Applio")
TTS_RVC_DIR = Path("/opt/discord-soundboard/tts-server/models/rvc")
TTS_CB_DIR = Path("/opt/discord-soundboard/tts-server/models/chatterbox")
TTS_URL = "http://localhost:8880"


def read_tts_admin_token() -> str:
    env_path = Path("/opt/discord-soundboard/tts-server/.env")
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("TTS_ADMIN_TOKEN="):
                return line.split("=", 1)[1].strip()
    return os.environ.get("TTS_ADMIN_TOKEN", "").strip()


def pick_reference_chunk(chunks_dir: Path, target_min: float = 6.0, target_max: float = 12.0) -> Path | None:
    """Pick a single clean chunk to use as the Chatterbox reference clip.

    Preference order:
      1. Chunks in the target_min..target_max duration range (Chatterbox sweet spot)
      2. Longest chunk under target_max if nothing fits exactly
      3. First chunk if no durations can be probed
    """
    candidates = []
    for f in sorted(chunks_dir.glob("*.wav")):
        try:
            d = float(subprocess.check_output(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", str(f)],
                text=True, timeout=10,
            ).strip())
            candidates.append((d, f))
        except Exception:
            continue
    if not candidates:
        wavs = list(chunks_dir.glob("*.wav"))
        return wavs[0] if wavs else None
    in_range = [c for c in candidates if target_min <= c[0] <= target_max]
    if in_range:
        in_range.sort(key=lambda x: abs(x[0] - 10.0))
        return in_range[0][1]
    under = [c for c in candidates if c[0] <= target_max]
    if under:
        under.sort(reverse=True)
        return under[0][1]
    return min(candidates, key=lambda x: x[0])[1]


def upload_chatterbox_voice(voice_id: str, ref_wav: Path, metadata: dict) -> dict:
    """PUT a Chatterbox voice to the TTS server. Resamples ref_wav to 24 kHz mono."""
    token = read_tts_admin_token()
    if not token:
        raise RuntimeError("TTS_ADMIN_TOKEN not configured — cannot auto-create Chatterbox voice")

    # Resample to 24 kHz mono (Chatterbox reference format)
    resampled = ref_wav.parent / (ref_wav.stem + ".24k.wav")
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(ref_wav), "-ac", "1", "-ar", "24000",
        "-c:a", "pcm_s16le", str(resampled),
    ], check=True)

    import email.generator
    import email.mime.multipart
    import email.mime.application
    import email.mime.text
    import mimetypes

    # Build multipart/form-data by hand so we don't depend on requests.
    boundary = "----rvcpipeline" + str(int(time.time()))
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"reference\"; filename=\"{ref_wav.name}\"\r\nContent-Type: audio/wav\r\n\r\n".encode())
    parts.append(resampled.read_bytes())
    parts.append(f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(metadata)}\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(
        f"{TTS_URL}/voices/chatterbox/{voice_id}",
        data=body, method="PUT",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "X-Admin-Token": token,
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

BENCHMARK_PHRASES = [
    "Hello, this is a test of the new voice model.",
    "Wubba lubba dub dub! Just kidding.",
    "OOOH YEAH! The cream of the crop has arrived!",
    "I think this voice is going to work out great.",
]


def synth(text: str, voice_id: str, use_rvc: bool, exaggeration: float, out_path: Path) -> bool:
    body = json.dumps({
        "text": text, "voice_id": voice_id, "use_rvc": use_rvc, "exaggeration": exaggeration,
    }).encode()
    req = urllib.request.Request(
        f"{TTS_URL}/synthesize",
        data=body, headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            wav = r.read()
        out_path.write_bytes(wav)
        return True
    except Exception as e:
        emit(PHASE, "progress", phrase=text[:40], rvc=use_rvc, error=str(e))
        return False


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
        voice_id = inp["voice_id"]
        gender = inp.get("gender", "male")
        group = inp.get("group", "Celebrity")
        name = inp.get("name", voice_id.replace("_", " ").title())
        base_voice = inp.get("base_voice", "am_adam")
        default_exaggeration = float(inp.get("default_exaggeration", 0.7))

        # 1. Locate trained artifacts (read from train phase .done)
        train_done = json.loads((job_dir / "state" / "train.done").read_text())
        pth_src = APPLIO_DIR / train_done["best_pth"]
        idx_src = APPLIO_DIR / train_done["index"]
        if not pth_src.exists() or not idx_src.exists():
            raise RuntimeError(f"Trained artifacts missing: {pth_src}, {idx_src}")

        # 2. Back up + install
        dst_dir = TTS_RVC_DIR / voice_id
        if dst_dir.exists():
            bak = TTS_RVC_DIR / f"{voice_id}.bak"
            if bak.exists():
                shutil.rmtree(bak)
            shutil.move(str(dst_dir), str(bak))
            run.progress(action="backed_up_existing", to=str(bak))
        dst_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy(pth_src, dst_dir / "model.pth")
        shutil.copy(idx_src, dst_dir / "model.index")
        run.progress(action="installed_weights", to=str(dst_dir))

        # 3. Update manifest
        manifest_path = TTS_RVC_DIR / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        entry = {
            "id": voice_id,
            "name": name,
            "pth": f"{voice_id}/model.pth",
            "index": f"{voice_id}/model.index",
            "gender": gender,
            "group": group,
            "transpose": 0,
            "index_rate": 0.6,
            "protect": 0.33,
            "base_voice": base_voice,
        }
        # Replace existing or append
        manifest = [e for e in manifest if e.get("id") != voice_id]
        manifest.append(entry)
        manifest_path.write_text(json.dumps(manifest, indent=2))
        run.progress(action="manifest_updated")

        # 4. Restart TTS server to pick up the new RVC model
        subprocess.run(["systemctl", "restart", "tts-server.service"], check=False)
        time.sleep(8)

        # Quick health check
        try:
            with urllib.request.urlopen(f"{TTS_URL}/health", timeout=10) as r:
                json.loads(r.read())
        except Exception as e:
            raise RuntimeError(f"TTS server not responding after restart: {e}")

        # 5. Auto-create cb_<voice_id> Chatterbox voice if missing (so the
        #    pairing is complete and RVC actually runs when synthesizing).
        cb_voice_id = f"cb_{voice_id}"
        cb_dir = TTS_CB_DIR / voice_id
        cb_created = False
        if not cb_dir.exists() or not (cb_dir / "reference.wav").exists():
            chunks_dir = job_dir / "chunks"
            ref_chunk = pick_reference_chunk(chunks_dir)
            if not ref_chunk:
                raise RuntimeError(f"No chunks available to use as Chatterbox reference in {chunks_dir}")
            run.progress(action="auto_creating_chatterbox_pair", ref_chunk=str(ref_chunk.relative_to(job_dir)))

            src_info = {"source_kind": "upload", "source_filename": f"{voice_id}_training_chunk:{ref_chunk.name}"}
            # If we know the original YouTube URL for the whole training job, prefer that
            urls = inp.get("urls") or []
            if urls:
                src_info = {"source_kind": "youtube", "source_url": urls[0]}

            cb_meta = {
                "name": name,
                "gender": gender,
                "group": group,
                "skip_rvc": False,
                "default_exaggeration": default_exaggeration,
                **src_info,
            }
            result = upload_chatterbox_voice(voice_id, ref_chunk, cb_meta)
            cb_created = True
            run.progress(action="chatterbox_voice_created", result=result)
            time.sleep(2)  # give engine cache a moment to invalidate

        # 6. Synthesize benchmark audio
        bench_dir = job_dir / "benchmark"
        bench_dir.mkdir(parents=True, exist_ok=True)

        produced = []
        for i, phrase in enumerate(BENCHMARK_PHRASES, start=1):
            for label, use_rvc in [("chatterbox_only", False), ("chatterbox_rvc", True)]:
                out = bench_dir / f"{i:02d}_{label}.wav"
                ok = synth(phrase, cb_voice_id, use_rvc, default_exaggeration, out)
                if ok:
                    produced.append(str(out.relative_to(job_dir)))

        run.done(
            voice_id=voice_id,
            installed_to=str(dst_dir),
            chatterbox_auto_created=cb_created,
            benchmark_files=produced,
            benchmark_dir=str(bench_dir),
            note="skip_rvc starts False so the trained RVC is active; flip via PATCH to disable.",
        )


if __name__ == "__main__":
    main()
