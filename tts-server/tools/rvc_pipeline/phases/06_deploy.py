#!/usr/bin/env python3
"""Phase 6: deploy trained model to TTS server, generate A/B benchmark audio.

Steps:
  1. Back up existing rvc/<voice_id>/ if present (to rvc/<voice_id>.bak/).
  2. Copy trained .pth + .index from Applio's logs dir to TTS models/rvc/<voice_id>/.
  3. Add or update entry in models/rvc/manifest.json.
  4. Synthesize benchmark phrases twice each (Chatterbox-only vs Chatterbox+RVC)
     and write to <job_dir>/benchmark/. Done by HTTP-calling the local TTS server.

The Chatterbox metadata's `skip_rvc` flag is NOT flipped here — the orchestrator
(Claude) does that via the soundboard's PATCH endpoint after the user approves
the benchmark in the UI. This keeps the deploy reversible until the human
signs off.
"""
import argparse
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from _status import phase_run, load_input, emit


PHASE = "deploy"
APPLIO_DIR = Path("/opt/Applio")
TTS_RVC_DIR = Path("/opt/discord-soundboard/tts-server/models/rvc")
TTS_URL = "http://localhost:8880"

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
        import subprocess
        subprocess.run(["systemctl", "restart", "tts-server.service"], check=False)
        time.sleep(8)

        # 5. Synthesize benchmark audio
        bench_dir = job_dir / "benchmark"
        bench_dir.mkdir(parents=True, exist_ok=True)
        cb_voice_id = f"cb_{voice_id}"
        # Quick health check
        try:
            with urllib.request.urlopen(f"{TTS_URL}/health", timeout=10) as r:
                json.loads(r.read())
        except Exception as e:
            raise RuntimeError(f"TTS server not responding after restart: {e}")

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
            benchmark_files=produced,
            note="skip_rvc still True on chatterbox metadata; flip via PATCH after user approval",
        )


if __name__ == "__main__":
    main()
