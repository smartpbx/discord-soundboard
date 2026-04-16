#!/usr/bin/env bash
# Run inside the TTS server container.
# Updates code and Python deps; keeps models intact.
set -e
APP_DIR="${APP_DIR:-/opt/discord-soundboard}"
TTS_DIR="${APP_DIR}/tts-server"
PIP="${TTS_DIR}/.venv/bin/pip"
cd "$APP_DIR"
echo "[*] Pulling latest code..."
git pull
echo "[*] Installing Python dependencies..."
$PIP install -r "${TTS_DIR}/requirements.txt"
# rvc-python has a stale numpy<=1.23.5 pin; install with --no-deps to avoid conflict
$PIP install --no-deps rvc-python 2>/dev/null || true
# Install rvc-python's actual runtime deps (skip the broken numpy pin)
$PIP install fairseq faiss-cpu torchcrepe pyworld av ffmpeg-python 2>/dev/null || true
echo "[*] Restarting TTS service..."
systemctl restart tts-server
echo "[+] TTS update done. Models in ${TTS_DIR}/models/ were not changed."
