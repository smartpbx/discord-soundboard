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
echo "[*] Ensuring yt-dlp is installed and up to date..."
if command -v pip3 >/dev/null 2>&1; then
    pip3 install --break-system-packages --upgrade yt-dlp 2>/dev/null \
        || pip3 install --upgrade yt-dlp 2>/dev/null \
        || echo "[!] yt-dlp install failed (TTS voice admin YouTube fetch will be unavailable)"
fi
echo "[*] Restarting service..."
systemctl restart discord-soundboard
echo "[+] Update done. Your .env and sounds/ were not changed."
