#!/usr/bin/env bash
# Discord Soundboard - container-side install script
# Runs inside the LXC. Called by install-discord-soundboard.sh on the host.
# Expects: APP_DIR, GIT_URL (and optionally SESSION_SECRET) in environment.
# Standalone: no code from community-scripts/ProxmoxVE.

set -e

APP_DIR="${APP_DIR:-/opt/discord-soundboard}"
GIT_URL="${GIT_URL:-https://github.com/smartpbx/discord-soundboard.git}"

# Disable wait-online so container boots faster (community-scripts pattern)
systemctl disable -q --now systemd-networkd-wait-online.service 2>/dev/null || true

echo "[*] Installing dependencies..."
apt-get update -qq
apt-get install -y curl git ffmpeg build-essential python3
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "[*] Cloning app to ${APP_DIR}..."
rm -rf "${APP_DIR}"
git clone "${GIT_URL}" "${APP_DIR}"
chmod +x "${APP_DIR}"/scripts/*.sh 2>/dev/null || true

echo "[*] Installing npm dependencies..."
cd "${APP_DIR}"
npm install

if [[ ! -f "${APP_DIR}/.env" ]]; then
    echo "[*] Creating .env..."
    SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -hex 32 2>/dev/null || echo 'change-me-session-secret')}"
    cat > "${APP_DIR}/.env" << ENVFILE
DISCORD_TOKEN=your_bot_token_here
PORT=3000
SESSION_SECRET=${SESSION_SECRET}
ADMIN_PASSWORD=change_admin_password
USER_PASSWORD=change_user_password
ENVFILE
    echo "[!] Set DISCORD_TOKEN and passwords in ${APP_DIR}/.env"
fi

echo "[*] Installing systemd service..."
cat > /etc/systemd/system/discord-soundboard.service << SVCEOF
[Unit]
Description=Discord Soundboard
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node server.js
Restart=unless-stopped
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable discord-soundboard
systemctl start discord-soundboard

echo "[*] Installing update command and login banner..."
printf '%s\n' '#!/bin/sh' "export APP_DIR=${APP_DIR}" 'exec ${APP_DIR}/scripts/update.sh' > /usr/local/bin/update
chmod +x /usr/local/bin/update
"${APP_DIR}/scripts/install-motd.sh" 2>/dev/null || true

echo "[+] Discord Soundboard installed and running in ${APP_DIR}"
