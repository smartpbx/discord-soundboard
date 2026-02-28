#!/usr/bin/env bash
# Discord Soundboard - Proxmox LXC install script
# Run on your Proxmox host. Supports: install, update.
# Usage: ./install-discord-soundboard.sh [install|update]
# See: https://community-scripts.github.io/ProxmoxVE/

set -e

# --- Config (change these or set env vars) ---
CTID="${CTID:-200}"
HOSTNAME="${HOSTNAME:-discord-soundboard}"
MEMORY="${MEMORY:-512}"
CORES="${CORES:-1}"
DISK="${DISK:-8}"
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"
GW="${GW:-}"          # e.g. 192.168.1.1
IP="${IP:-}"          # e.g. 192.168.1.200/24
GIT_URL="${GIT_URL:-https://github.com/YOUR_USER/discord-soundboard.git}"  # Set your repo URL
APP_DIR="/opt/discord-soundboard"
TEMPLATE_DEBIAN="${TEMPLATE_DEBIAN:-}"   # e.g. local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst

# --- Help ---
usage() {
    echo "Usage: $0 [install|update]"
    echo ""
    echo "  install  - Create LXC and install Discord Soundboard (default)"
    echo "  update   - Update existing container (git pull, npm install, restart)"
    echo ""
    echo "Override with env: CTID, HOSTNAME, MEMORY, CORES, DISK, STORAGE, BRIDGE, GIT_URL, IP, GW"
    exit 0
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; fi

# --- Update (run on host) ---
do_update() {
    echo "[*] Updating Discord Soundboard in CT ${CTID}..."
    pct exec "${CTID}" -- bash -c "cd ${APP_DIR} && git pull && npm install && systemctl restart discord-soundboard"
    echo "[+] Update done. Service restarted."
}

if [[ "${1:-}" == "update" ]]; then
    do_update
    exit 0
fi

# --- Install ---
echo "[*] Discord Soundboard - Proxmox LXC installer"

# Resolve template (Debian 12 or Ubuntu 22/24)
if [[ -z "${TEMPLATE_DEBIAN}" ]]; then
    for t in local:vztmpl/debian-12-standard*.tar.zst local:vztmpl/ubuntu-22.04-standard*.tar.zst local:vztmpl/ubuntu-24.04-standard*.tar.zst; do
        if pveam list "${t}" 2>/dev/null | head -1 | grep -q .; then
            TEMPLATE_DEBIAN="${t}"
            break
        fi
    done
    if [[ -z "${TEMPLATE_DEBIAN}" ]]; then
        echo "No Debian/Ubuntu template found. Download one, e.g.:"
        echo "  pveam download local debian-12-standard_12.2-1_amd64.tar.zst"
        exit 1
    fi
fi
echo "[*] Using template: ${TEMPLATE_DEBIAN}"

# Create CT if not exists
if ! pct status "${CTID}" &>/dev/null; then
    echo "[*] Creating LXC ${CTID}..."
    NET="name=eth0,bridge=${BRIDGE}"
    [[ -n "${GW}" ]] && NET="${NET},gw=${GW}"
    [[ -n "${IP}" ]] && NET="${NET},ip=${IP}"
    pct create "${CTID}" "${TEMPLATE_DEBIAN}" --hostname "${HOSTNAME}" --memory "${MEMORY}" --cores "${CORES}" \
        --rootfs "${STORAGE}:${DISK}" --net0 "${NET}" --unprivileged 0 --features nesting=0
    echo "[+] Container created. Set root password and start it:"
    echo "    pct set ${CTID} -rootfs 0"
    echo "    pct start ${CTID}"
    echo "Then run this script again with: GIT_URL=... $0 install"
    exit 0
fi

# Container must be running
if ! pct status "${CTID}" | grep -q running; then
    echo "[*] Starting CT ${CTID}..."
    pct start "${CTID}"
    sleep 5
fi

# Install dependencies and app inside CT
echo "[*] Installing dependencies in container..."
pct exec "${CTID}" -- bash -c "apt-get update && apt-get install -y curl git ffmpeg build-essential python3"
pct exec "${CTID}" -- bash -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"

echo "[*] Cloning app to ${APP_DIR}..."
pct exec "${CTID}" -- bash -c "rm -rf ${APP_DIR} && git clone '${GIT_URL}' ${APP_DIR}"

echo "[*] Installing npm dependencies..."
pct exec "${CTID}" -- bash -c "cd ${APP_DIR} && npm install"

# .env
if ! pct exec "${CTID}" -- test -f "${APP_DIR}/.env" 2>/dev/null; then
    echo "[*] Creating .env (edit later with: pct exec ${CTID} -- nano ${APP_DIR}/.env)"
    SESSION_RANDOM=$(openssl rand -hex 32)
    pct exec "${CTID}" -- bash -c "cat > ${APP_DIR}/.env << 'ENVFILE'
DISCORD_TOKEN=your_bot_token_here
PORT=3000
SESSION_SECRET=${SESSION_RANDOM}
ADMIN_PASSWORD=change_admin_password
USER_PASSWORD=change_user_password
ENVFILE"
    echo "[!] Set DISCORD_TOKEN and passwords in ${APP_DIR}/.env"
fi

# systemd service
echo "[*] Installing systemd service..."
pct exec "${CTID}" -- bash -c "cat > /etc/systemd/system/discord-soundboard.service << 'SVCEOF'
[Unit]
Description=Discord Soundboard
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=APP_DIR_PLACEHOLDER
EnvironmentFile=APP_DIR_PLACEHOLDER/.env
ExecStart=/usr/bin/node server.js
Restart=unless-stopped
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF"
pct exec "${CTID}" -- sed -i \"s|APP_DIR_PLACEHOLDER|${APP_DIR}|g\" /etc/systemd/system/discord-soundboard.service
pct exec "${CTID}" -- systemctl daemon-reload
pct exec "${CTID}" -- systemctl enable discord-soundboard
pct exec "${CTID}" -- systemctl start discord-soundboard

echo "[+] Done. Discord Soundboard is running in CT ${CTID}."
echo "    Web UI: http://<container-ip>:3000"
echo "    Logs:   pct exec ${CTID} -- journalctl -u discord-soundboard -f"
echo "    Update: $0 update  (or: pct exec ${CTID} -- bash -c 'cd ${APP_DIR} && git pull && npm install && systemctl restart discord-soundboard')"
