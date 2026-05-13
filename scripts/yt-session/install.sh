#!/usr/bin/env bash
# Install the YouTube cookie-session stack on CT 109 (or any Debian-based host).
# Idempotent — safe to re-run. Run as root.
#
# What it does:
#   - apt-installs chromium, Xvfb, x11vnc, novnc, websockify, python3-websocket
#   - creates the persistent Chromium profile dir under /opt/discord-soundboard
#   - installs systemd units for: Chromium (Xvfb-hosted), x11vnc, noVNC, keepwarm timer
#   - drops the YTDLP_COOKIES_FROM_BROWSER hint into /opt/discord-soundboard/.env
#     (commented — you opt in after logging into YouTube once via noVNC)
#
# After this runs:
#   1. Open the soundboard superadmin panel
#   2. Click "Open YouTube session" — a Chromium window opens in your browser
#   3. Log into your throwaway Google account on YouTube
#   4. Close the modal; click "Enable cookies for yt-dlp" (uncomments the env var
#      and restarts discord-soundboard)
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Must run as root" >&2
    exit 1
fi

REPO_DIR="${REPO_DIR:-/opt/discord-soundboard}"
PROFILE_DIR="${REPO_DIR}/yt-profile"
SYSTEMD_DIR="/etc/systemd/system"
UNITS_SRC="${REPO_DIR}/scripts/yt-session/systemd"

echo "[1/5] apt install required packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    python3 \
    python3-websocket \
    curl \
    ca-certificates

echo "[2/5] create persistent Chromium profile dir"
mkdir -p "$PROFILE_DIR"
chmod 700 "$PROFILE_DIR"

echo "[3/5] install systemd units"
for unit in yt-chromium.service yt-vnc.service yt-novnc.service yt-keepwarm.service yt-keepwarm.timer; do
    install -m 644 "${UNITS_SRC}/${unit}" "${SYSTEMD_DIR}/${unit}"
done
chmod +x "${REPO_DIR}/scripts/yt-session/bin/keepwarm.sh"
systemctl daemon-reload

echo "[4/5] enable + start services"
systemctl enable --now yt-chromium.service yt-vnc.service yt-novnc.service
systemctl enable --now yt-keepwarm.timer

echo "[5/5] hint YTDLP_COOKIES_FROM_BROWSER in .env (commented)"
ENV_FILE="${REPO_DIR}/.env"
if [ -f "$ENV_FILE" ] && ! grep -q '^#\?\s*YTDLP_COOKIES_FROM_BROWSER' "$ENV_FILE"; then
    {
        echo ""
        echo "# yt-dlp reads cookies from the Chromium profile maintained by yt-chromium.service."
        echo "# Uncomment after you've logged into YouTube once via the superadmin 'YouTube session' panel."
        echo "# YTDLP_COOKIES_FROM_BROWSER=chromium:${PROFILE_DIR}"
    } >> "$ENV_FILE"
fi

cat <<EOF

----------------------------------------------------------------
YouTube cookie-session stack installed.

Status:
  systemctl status yt-chromium yt-vnc yt-novnc yt-keepwarm.timer

Next:
  1. Open the soundboard, log in as superadmin
  2. Settings → YouTube session → Open browser
  3. Log into your throwaway Google account on the YouTube tab
  4. Click "Enable cookies for yt-dlp"

If Chromium fails to start in the LXC, check:
  journalctl -u yt-chromium -n 50
  (most common: needs /dev/shm bumped or apparmor profile)
----------------------------------------------------------------
EOF
