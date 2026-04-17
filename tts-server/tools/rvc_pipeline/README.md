# RVC Voice Training Pipeline

Six independent phase scripts that build a custom RVC v2 voice model end-to-end. Each script is **idempotent** (safe to re-run; skips work via `state/<phase>.done` sentinels) and emits **newline-delimited JSON status** to stdout for the orchestrator to parse.

The pipeline is invoked by Claude Code in headless mode (see `~/.claude/agents/voice-trainer.md`). The agent decides which YouTube clips to feed in, runs each phase in sequence, validates outputs, and reports back to the soundboard backend.

## Job directory layout

```
/tmp/voice-train/jobs/<job_id>/
├── input.json           # voice_id, name, group, gender, urls[], training params
├── state/               # .done sentinels for resume
├── raw/                 # downloaded WAVs from yt-dlp
├── transcripts/         # per-clip Whisper JSON
├── chunks/              # speaker-clustered target-only segments (40 kHz mono PCM16)
├── benchmark/           # A/B audio (Chatterbox-only vs Chatterbox+RVC) for user evaluation
└── status.json          # phase log + token usage + final result
```

## Phases

| # | Script | Input | Output | ~Time |
|---|---|---|---|---|
| 1 | `phases/01_download.py` | URLs from input.json | `raw/*.wav` | 1–3 min per clip |
| 2 | `phases/02_transcribe.py` | `raw/*.wav` | `transcripts/*.json` | ~30s per clip on CPU |
| 3 | `phases/03_cluster.py` | raw + transcripts + voice_id markers | `cluster_results.json` | ~5s per clip on GPU |
| 4 | `phases/04_extract.py` | cluster results + raw | `chunks/*.wav` | ~1 min total |
| 5 | `phases/05_train.py` | `chunks/` + voice_id | trained .pth + .index | 50–80 min on RTX 3090 |
| 6 | `phases/06_deploy.py` | trained model + voice metadata | deployed to manifest, A/B benchmarks | ~30 sec |

## Invocation

Each script:
```
python phases/0X_NAME.py --job-dir /tmp/voice-train/jobs/<job_id>
```

Common flags:
- `--force` — re-run even if `.done` exists
- `--quiet` — suppress JSON status emission (useful for ad-hoc testing)

## Status JSON format

Each line on stdout is one event:
```
{"phase": "download", "status": "starting", "details": {"urls_count": 7}}
{"phase": "download", "status": "progress", "details": {"completed": 3, "total": 7, "current_title": "..."}}
{"phase": "download", "status": "complete", "details": {"output_dir": "raw/", "duration_sec": 1234, "files_kept": 7, "files_skipped": 0}}
{"phase": "<name>", "status": "error", "details": {"message": "...", "exception": "..."}}
```

Status types: `starting`, `progress`, `complete`, `error`, `skipped` (when .done sentinel found).

## Resumability

Each script writes `state/<phase>.done` JSON when complete:
```
{"completed_at": "...", "duration_sec": ...}
```

On re-run, presence of `.done` makes the script emit `{"status": "skipped"}` and exit 0. Use `--force` to override.

This lets Claude resume any failed pipeline by re-invoking from the failed phase forward — earlier phases skip immediately.

## Sandboxing

Pipeline scripts only touch:
- `/tmp/voice-train/` (job dirs)
- `/opt/Applio/datasets/<voice_id>/` and `/opt/Applio/logs/<voice_id>/` (training)
- `/opt/discord-soundboard/tts-server/models/rvc/<voice_id>/` (deploy)

Network access required: yt-dlp (YouTube), HuggingFace mirror (model downloads if not cached).
