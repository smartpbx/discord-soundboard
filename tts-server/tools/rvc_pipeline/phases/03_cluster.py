#!/usr/bin/env python3
"""Phase 3: speaker-cluster each clip with resemblyzer + KMeans.

For each clip, embeds every Whisper segment, KMeans-clusters into 2 speakers,
identifies which cluster is the target speaker (the one with more occurrences
of the target's marker keywords), and records the kept segments.

Outputs <job_dir>/cluster_results.json:
  {
    "clip_name": [
      {"start": float, "end": float, "text": str, "kept": bool},
      ...
    ],
    ...
  }

Falls back to "keep all" for clips with too few segments (< 6) since
clustering is unreliable on short clips.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from _status import phase_run, load_input, emit


PHASE = "cluster"

# Generic markers that often indicate the target speaker (not announcer/host).
# The orchestrator can supply voice-specific markers in input.json.
DEFAULT_MARKERS_BY_PATTERN = ["yeah", "right", "i mean", "you know"]


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
        markers = [m.lower() for m in inp.get("speaker_markers", DEFAULT_MARKERS_BY_PATTERN)]

        raw_dir = job_dir / "raw"
        tx_dir = job_dir / "transcripts"
        wavs = {w.stem: w for w in raw_dir.glob("*.wav")}

        # Lazy imports — heavy
        import numpy as np
        import librosa
        from sklearn.cluster import KMeans
        from resemblyzer import VoiceEncoder, preprocess_wav

        encoder = VoiceEncoder(verbose=False)

        results = {}
        total_kept_sec = 0.0
        for i, tx_path in enumerate(sorted(tx_dir.glob("*.json")), start=1):
            stem = tx_path.stem
            wav = wavs.get(stem)
            if not wav:
                continue
            run.progress(current=i, total=len(wavs), clip=stem)

            segs = [s for s in json.loads(tx_path.read_text()) if s["end"] - s["start"] >= 1.0]
            if len(segs) < 6:
                # Trust the whole clip; cluster too small to be reliable
                kept = list(range(len(segs)))
                cluster_info = {"reason": "too_few_segments", "kept": len(kept), "total": len(segs)}
            else:
                audio, sr = librosa.load(str(wav), sr=16000, mono=True)
                embeds = []
                for s in segs:
                    a = audio[int(s["start"] * sr):int(s["end"] * sr)]
                    if len(a) < int(sr * 0.5):
                        embeds.append(None)
                        continue
                    try:
                        a_pp = preprocess_wav(a, source_sr=sr)
                        if len(a_pp) < 1600:
                            embeds.append(None)
                            continue
                        embeds.append(encoder.embed_utterance(a_pp))
                    except Exception:
                        embeds.append(None)

                valid = [(j, e) for j, e in enumerate(embeds) if e is not None]
                if len(valid) < 4:
                    kept = list(range(len(segs)))
                    cluster_info = {"reason": "too_few_embeddings", "kept": len(kept), "total": len(segs)}
                else:
                    X = np.stack([e for _, e in valid])
                    km = KMeans(n_clusters=2, random_state=0, n_init=10).fit(X)
                    score = {0: 0, 1: 0}
                    for (j, _), label in zip(valid, km.labels_):
                        text = segs[j]["text"].lower()
                        score[label] += sum(1 for m in markers if m in text)
                    target_cluster = max(score, key=score.get)
                    valid_target_indices = {j for (j, _), label in zip(valid, km.labels_) if label == target_cluster}
                    kept = sorted(valid_target_indices)
                    cluster_info = {
                        "scores": {str(k): v for k, v in score.items()},
                        "target_cluster": int(target_cluster),
                        "kept": len(kept),
                        "total": len(segs),
                    }

            results[stem] = {
                "segments": [
                    {**segs[j], "kept": (j in kept) if isinstance(kept, list) else (j in set(kept))}
                    for j in range(len(segs))
                ],
                "cluster_info": cluster_info,
            }
            kept_sec = sum(segs[j]["end"] - segs[j]["start"] for j in kept)
            total_kept_sec += kept_sec
            emit(PHASE, "progress", clip=stem, kept_segments=len(kept), kept_seconds=round(kept_sec, 1), **cluster_info)

        out = job_dir / "cluster_results.json"
        out.write_text(json.dumps(results, indent=2))

        run.done(clips=len(results), total_kept_minutes=round(total_kept_sec / 60, 2), output_file="cluster_results.json")


if __name__ == "__main__":
    main()
