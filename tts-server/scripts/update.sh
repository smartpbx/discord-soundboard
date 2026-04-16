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
echo "[*] Installing base Python dependencies..."
$PIP install -r "${TTS_DIR}/requirements.txt"

# RVC deps: fairseq and infer-rvc-python have broken dependency metadata
# (omegaconf<2.1 uses invalid PyYAML>=5.1.* specifier that loops pip forever).
# Install with --no-deps then add the actual runtime deps manually.
echo "[*] Installing RVC dependencies (--no-deps to avoid fairseq resolver loop)..."
$PIP install --no-deps infer-rvc-python 2>/dev/null || true
$PIP install --no-deps fairseq 2>/dev/null || true
$PIP install torchcrepe pyworld faiss-cpu omegaconf hydra-core sacrebleu bitarray torchaudio 2>/dev/null || true

echo "[*] Restarting TTS service..."
systemctl restart tts-server
echo "[+] TTS update done. Models in ${TTS_DIR}/models/ were not changed."
