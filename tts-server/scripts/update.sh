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
echo "[*] Restarting TTS service..."
systemctl restart tts-server
echo "[+] TTS update done. Models in ${TTS_DIR}/models/ were not changed."
