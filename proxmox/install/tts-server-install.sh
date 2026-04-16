#!/usr/bin/env bash
# TTS Server - container-side install script
# Runs inside the LXC. Called by install-tts-server.sh on the host.
# Expects: APP_DIR, GIT_URL in environment.

set -e

APP_DIR="${APP_DIR:-/opt/discord-soundboard}"
GIT_URL="${GIT_URL:-https://github.com/smartpbx/discord-soundboard.git}"
TTS_DIR="${APP_DIR}/tts-server"

# Disable wait-online
systemctl disable -q --now systemd-networkd-wait-online.service 2>/dev/null || true

echo "[*] Installing system dependencies..."
apt-get update -qq
apt-get install -y curl git python3 python3-venv python3-pip ffmpeg libsndfile1

echo "[*] Cloning app to ${APP_DIR}..."
if [[ -d "${APP_DIR}/.git" ]]; then
    cd "${APP_DIR}" && git pull
else
    git clone "${GIT_URL}" "${APP_DIR}"
fi

echo "[*] Setting up Python virtual environment..."
python3 -m venv "${TTS_DIR}/.venv"
"${TTS_DIR}/.venv/bin/pip" install --upgrade pip
"${TTS_DIR}/.venv/bin/pip" install -r "${TTS_DIR}/requirements.txt"

echo "[*] Creating TTS .env..."
if [[ ! -f "${TTS_DIR}/.env" ]]; then
    cat > "${TTS_DIR}/.env" << ENVFILE
HOST=0.0.0.0
PORT=8880
ENVFILE
fi

echo "[*] Creating models directory..."
mkdir -p "${TTS_DIR}/models/rvc"

echo "[*] Installing systemd service..."
cat > /etc/systemd/system/tts-server.service << SVCEOF
[Unit]
Description=TTS Server (Kokoro)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${TTS_DIR}
EnvironmentFile=${TTS_DIR}/.env
ExecStart=${TTS_DIR}/.venv/bin/python main.py
Restart=unless-stopped
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable tts-server
systemctl start tts-server

echo "[*] Installing update command..."
cat > /usr/local/bin/update << UPDATEEOF
#!/bin/sh
export APP_DIR=${APP_DIR}
exec ${APP_DIR}/tts-server/scripts/update.sh
UPDATEEOF
chmod +x /usr/local/bin/update
chmod +x "${APP_DIR}"/tts-server/scripts/*.sh 2>/dev/null || true

echo "[+] TTS server installed and running. API at http://0.0.0.0:8880"
