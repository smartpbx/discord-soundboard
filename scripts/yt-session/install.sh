#!/usr/bin/env bash
# Install the YouTube cookie-session + PO-token stack on CT 109 (or any
# Debian-based host). Idempotent — safe to re-run. Run as root.
#
# What it does:
#   - apt-installs chromium, Xvfb, x11vnc, novnc, websockify, python3-websocket
#   - creates the persistent Chromium profile dir under /opt/discord-soundboard
#   - installs systemd units for: Chromium (Xvfb-hosted), x11vnc, noVNC, keepwarm timer
#   - clones + builds bgutil-ytdlp-pot-provider server at /opt/bgutil-pot-server,
#     installs the matching pip plugin, runs it as yt-pot-server.service. This
#     handles YouTube's proof-of-origin (PO) token requirement — without it,
#     yt-dlp returns only storyboard formats (no audio) on most videos.
#   - drops the YTDLP_COOKIES_FROM_BROWSER hint into /opt/discord-soundboard/.env
#     (commented — you opt in via the superadmin panel after one-time login.
#     Most public videos do NOT need cookies once PO tokens are in play;
#     cookies are only needed for age-gated / login-only content.)
#
# After this runs:
#   1. Open the soundboard superadmin panel
#   2. Settings → YouTube Cookie Session → Test cookies (should pass even without
#      logging in, because PO-token + no-cookies is enough for public videos)
#   3. If a specific video still fails, click "Open browser", log into a throwaway
#      Google account on YouTube, then click "Enable cookies for yt-dlp"
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Must run as root" >&2
    exit 1
fi

REPO_DIR="${REPO_DIR:-/opt/discord-soundboard}"
PROFILE_DIR="${REPO_DIR}/yt-profile"
SYSTEMD_DIR="/etc/systemd/system"
UNITS_SRC="${REPO_DIR}/scripts/yt-session/systemd"
POT_SERVER_DIR="/opt/bgutil-pot-server"
POT_SERVER_TAG="${POT_SERVER_TAG:-1.3.1}"

echo "[1/8] apt install required packages"
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
    python3-pip \
    curl \
    git \
    unzip \
    ca-certificates

echo "[2/8] create persistent Chromium profile dir"
mkdir -p "$PROFILE_DIR"
chmod 700 "$PROFILE_DIR"

echo "[3/8] install Deno (JS runtime for nsig + yt-dlp-ejs)"
DENO_VERSION="${DENO_VERSION:-2.5.4}"
if ! /usr/local/bin/deno --version 2>/dev/null | head -1 | grep -q "deno ${DENO_VERSION}"; then
    tmp_zip="$(mktemp --suffix=.zip)"
    curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" -o "$tmp_zip"
    unzip -q -o "$tmp_zip" -d /usr/local/bin
    chmod +x /usr/local/bin/deno
    rm -f "$tmp_zip"
fi
/usr/local/bin/deno --version | head -1

echo "[4/8] clone + build bgutil-pot-server (PO-token sidecar)"
if [ ! -d "${POT_SERVER_DIR}/.git" ]; then
    git clone --single-branch --branch "$POT_SERVER_TAG" \
        https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$POT_SERVER_DIR"
else
    git -C "$POT_SERVER_DIR" fetch --tags --quiet
    git -C "$POT_SERVER_DIR" checkout --quiet "$POT_SERVER_TAG"
fi
(
    cd "${POT_SERVER_DIR}/server"
    npm ci --silent
    npx --yes tsc
)

echo "[5/8] install pip plugin (yt-dlp side of PO-token bridge)"
pip3 install --break-system-packages --quiet -U bgutil-ytdlp-pot-provider

echo "[6/8] install systemd units"
for unit in yt-chromium.service yt-vnc.service yt-novnc.service \
            yt-keepwarm.service yt-keepwarm.timer yt-pot-server.service; do
    install -m 644 "${UNITS_SRC}/${unit}" "${SYSTEMD_DIR}/${unit}"
done
chmod +x "${REPO_DIR}/scripts/yt-session/bin/keepwarm.sh"
systemctl daemon-reload

echo "[7/8] enable + start services"
systemctl enable --now yt-pot-server.service
systemctl enable --now yt-chromium.service yt-vnc.service yt-novnc.service
systemctl enable --now yt-keepwarm.timer

echo "[8/8] hint YTDLP_COOKIES_FROM_BROWSER in .env (commented)"
ENV_FILE="${REPO_DIR}/.env"
if [ -f "$ENV_FILE" ] && ! grep -q '^#\?\s*YTDLP_COOKIES_FROM_BROWSER' "$ENV_FILE"; then
    {
        echo ""
        echo "# yt-dlp reads cookies from the Chromium profile maintained by yt-chromium.service."
        echo "# Uncomment after you've logged into YouTube once via the superadmin 'YouTube session' panel."
        echo "# Most public videos do NOT need this once yt-pot-server is running;"
        echo "# only flip it on for age-gated / login-only content."
        echo "# YTDLP_COOKIES_FROM_BROWSER=chromium:${PROFILE_DIR}"
    } >> "$ENV_FILE"
fi

cat <<EOF

----------------------------------------------------------------
YouTube cookie-session + PO-token stack installed.

Status:
  systemctl status yt-pot-server yt-chromium yt-vnc yt-novnc yt-keepwarm.timer

Sanity check:
  yt-dlp --extractor-args "youtube:player_client=android,ios,web" \\
    --dump-single-json --no-playlist --no-warnings --quiet \\
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ" | head -c 200

If Chromium fails to start in the LXC, check:
  journalctl -u yt-chromium -n 50
If the POT server fails:
  journalctl -u yt-pot-server -n 50
----------------------------------------------------------------
EOF
