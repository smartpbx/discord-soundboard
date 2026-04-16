#!/usr/bin/env bash
# TTS Server - container-side install script
# Runs inside the LXC. Called by install-tts-server.sh on the host.
# Expects: APP_DIR, GIT_URL, GPU_TYPE (optional) in environment.

set -e

APP_DIR="${APP_DIR:-/opt/discord-soundboard}"
GIT_URL="${GIT_URL:-https://github.com/smartpbx/discord-soundboard.git}"
GPU_TYPE="${GPU_TYPE:-}"
TTS_DIR="${APP_DIR}/tts-server"

# Disable wait-online
systemctl disable -q --now systemd-networkd-wait-online.service 2>/dev/null || true

echo "[*] Installing system dependencies..."
apt-get update -qq
apt-get install -y curl git python3 python3-venv python3-pip ffmpeg libsndfile1 pciutils

# Install GPU drivers inside the container if GPU was detected
if [[ "$GPU_TYPE" == "nvidia" ]]; then
    echo "[*] Installing NVIDIA userland libraries..."
    # Add NVIDIA container toolkit repo
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg 2>/dev/null || true
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
        sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
        tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null 2>/dev/null || true
    apt-get update -qq 2>/dev/null || true
    apt-get install -y nvidia-container-toolkit 2>/dev/null || echo "[!] nvidia-container-toolkit not available, GPU may still work via device passthrough"
elif [[ "$GPU_TYPE" == "intel" ]]; then
    echo "[*] Installing Intel GPU libraries..."
    apt-get install -y intel-media-va-driver-non-free intel-gpu-tools 2>/dev/null || \
    apt-get install -y intel-media-va-driver 2>/dev/null || \
    echo "[!] Intel GPU libraries not available in repo"
elif [[ "$GPU_TYPE" == "amd" ]]; then
    echo "[*] Installing AMD GPU libraries..."
    apt-get install -y mesa-va-drivers 2>/dev/null || echo "[!] AMD GPU libraries not available"
fi

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
Restart=on-failure
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

echo "[*] Installing login banner..."
cat > /etc/update-motd.d/99-tts-server << 'MOTD'
#!/bin/sh
printf "\033[1;37mTTS Server (Kokoro) LXC Container\033[0m\n"
printf "\033[1;33mProvided by:\033[0m smartpbx \033[1;33m|\033[0m \033[1;32mGitHub:\033[0m https://github.com/smartpbx/discord-soundboard\n"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    printf "\033[1;32mOS:\033[0m %s – Version: %s\n" "${NAME:-Linux}" "${VERSION_ID:-unknown}"
fi
printf "\033[1;33mHostname:\033[0m %s\n" "$(hostname)"
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$ip" ] && printf "\033[1;33mIP Address:\033[0m %s\n" "$ip"
printf "\033[1;33mTTS API:\033[0m http://%s:8880\n" "${ip:-<container-ip>}"
printf "\033[1;33mHealth:\033[0m curl http://%s:8880/health\n" "${ip:-<container-ip>}"
printf "\033[1;33mUpdate:\033[0m update\n"
MOTD
chmod +x /etc/update-motd.d/99-tts-server

echo "[+] TTS server installed and running. API at http://0.0.0.0:8880"
