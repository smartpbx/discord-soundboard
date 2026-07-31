#!/usr/bin/env bash
# Run inside the TTS server container.
# Updates code and Python deps; keeps models intact.
set -e
APP_DIR="${APP_DIR:-/opt/discord-soundboard}"
TTS_DIR="${APP_DIR}/tts-server"
PIP="${TTS_DIR}/.venv/bin/pip"
FISH_DIR="${FISH_DIR:-/opt/fish-speech}"
FISH_PATCH="${TTS_DIR}/tools/fish-speech-low-memory.patch"
cd "$APP_DIR"
echo "[*] Pulling latest code..."
git pull --ff-only
echo "[*] Installing Python dependencies..."
# This server intentionally carries newer CUDA/PyTorch packages than
# chatterbox-tts declares. A full resolver pass tries to downgrade the entire
# working GPU stack on every deploy. Direct requirements are already provisioned
# by setup.sh, so routine updates must not re-resolve transitive GPU packages.
$PIP install --no-deps -r "${TTS_DIR}/requirements.txt"
if [[ -d "$FISH_DIR/.git" && -f "$FISH_PATCH" ]]; then
  echo "[*] Ensuring Fish-Speech low-memory loader patch is installed..."
  if git -C "$FISH_DIR" apply --unidiff-zero --check "$FISH_PATCH"; then
    git -C "$FISH_DIR" apply --unidiff-zero "$FISH_PATCH"
  elif git -C "$FISH_DIR" apply --unidiff-zero --reverse --check "$FISH_PATCH"; then
    echo "[=] Fish-Speech low-memory loader patch is already installed."
  else
    echo "[!] Fish-Speech source does not match the tested patch; refusing an unsafe partial update." >&2
    exit 1
  fi
  install -m 0644 "${TTS_DIR}/tools/fish-speech.service" /etc/systemd/system/fish-speech.service
  systemctl daemon-reload
fi
echo "[*] Restarting TTS service..."
systemctl restart tts-server
echo "[+] TTS update done. Models in ${TTS_DIR}/models/ were not changed."
