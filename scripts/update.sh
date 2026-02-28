#!/usr/bin/env bash
# Run inside the container (e.g. from LXC console).
# Updates app code only; keeps .env and sounds/ intact.
set -e
APP_DIR="${APP_DIR:-/opt/discord-soundboard}"
cd "$APP_DIR"
echo "[*] Pulling latest code..."
git pull
echo "[*] Installing dependencies..."
npm install
echo "[*] Restarting service..."
systemctl restart discord-soundboard
echo "[+] Update done. Your .env and sounds/ were not changed."
