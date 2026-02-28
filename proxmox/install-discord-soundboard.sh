#!/usr/bin/env bash
# Discord Soundboard - Proxmox LXC install script (single run)
# Run once on your Proxmox host. Creates container, sets password, starts, installs.
# Usage: ./install-discord-soundboard.sh [install|update]
# See: https://community-scripts.github.io/ProxmoxVE/

set -e

# --- Config (override with env vars) ---
HOSTNAME="${HOSTNAME:-discord-soundboard}"
MEMORY="${MEMORY:-512}"
CORES="${CORES:-1}"
DISK="${DISK:-8}"
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"
GW="${GW:-}"          # e.g. 192.168.1.1
IP="${IP:-}"          # e.g. 192.168.1.200/24
GIT_URL="${GIT_URL:-https://github.com/smartpbx/discord-soundboard.git}"
APP_DIR="/opt/discord-soundboard"
TEMPLATE_DEBIAN="${TEMPLATE_DEBIAN:-}"

# --- Help ---
usage() {
    echo "Usage: $0 [install|update]"
    echo ""
    echo "  install  - Create LXC and install Discord Soundboard in one run (default)"
    echo "  update   - Update existing container (requires CTID)"
    echo ""
    echo "Uses next free container ID unless CTID is set. Override: CTID, HOSTNAME, MEMORY, CORES, DISK, STORAGE, BRIDGE, GIT_URL, IP, GW"
    exit 0
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; fi

# --- Next free container ID (cluster-aware when pvesh exists) ---
get_next_ctid() {
    local id="${1:-}"
    if [[ -z "$id" ]]; then
        id=$(pvesh get /cluster/nextid 2>/dev/null || echo 100)
    fi
    [[ "$id" =~ ^[0-9]+$ ]] || id=100
    local max=2000
    while [[ $id -lt $max ]]; do
        if ! pct status "$id" &>/dev/null && [[ ! -f "/etc/pve/lxc/${id}.conf" ]]; then
            echo "$id"
            return 0
        fi
        id=$((id + 1))
    done
    echo "Could not find free container ID" >&2
    return 1
}

# --- Update (run on host; requires CTID) ---
do_update() {
    if [[ -z "${CTID:-}" ]]; then
        echo "For update, set CTID (e.g. CTID=200 $0 update)"
        exit 1
    fi
    echo "[*] Updating Discord Soundboard in CT ${CTID}..."
    pct exec "${CTID}" -- bash -c "cd ${APP_DIR} && chmod +x scripts/*.sh 2>/dev/null; git pull && npm install && ./scripts/install-motd.sh 2>/dev/null; systemctl restart discord-soundboard"
    echo "[+] Update done. Service restarted. Your .env and sounds/ were not changed."
}

if [[ "${1:-}" == "update" ]]; then
    do_update
    exit 0
fi

# --- Install (single run) ---
echo "[*] Discord Soundboard - Proxmox LXC installer (single run)"

# Use next free CTID unless CTID is set
if [[ -z "${CTID:-}" ]]; then
    CTID=$(get_next_ctid)
    echo "[*] Using next free container ID: ${CTID}"
else
    if pct status "${CTID}" &>/dev/null || [[ -f "/etc/pve/lxc/${CTID}.conf" ]]; then
        echo "[*] Using existing container ID: ${CTID}"
    else
        echo "[*] Using container ID: ${CTID}"
    fi
fi

# Resolve template (Debian 12/13 or Ubuntu 22/24) from storage CT templates
if [[ -z "${TEMPLATE_DEBIAN}" ]]; then
    for storage in local local-lvm; do
        list=$(pveam list "${storage}" 2>/dev/null) || continue
        found=$(echo "$list" | grep -oE '(debian-(12|13)-standard_[^/[:space:]]+\.tar\.(zst|xz)|ubuntu-(22\.04|24\.04)-standard_[^/[:space:]]+\.tar\.(zst|xz))' | head -1)
        if [[ -n "$found" ]]; then
            TEMPLATE_DEBIAN="${storage}:vztmpl/${found}"
            break
        fi
    done
    if [[ -z "${TEMPLATE_DEBIAN}" ]]; then
        echo "No Debian/Ubuntu template found on storage 'local' or 'local-lvm'."
        echo "Download one from the Proxmox UI (Datacenter → local → CT Templates → Templates),"
        echo "or run:  pveam update && pveam download local debian-12-standard_12.12-1_amd64.tar.zst"
        exit 1
    fi
fi
echo "[*] Using template: ${TEMPLATE_DEBIAN}"

# Create CT if not exists, set root password, start, wait for boot
if ! pct status "${CTID}" &>/dev/null; then
    echo "[*] Creating LXC ${CTID}..."
    NET="name=eth0,bridge=${BRIDGE}"
    [[ -n "${GW}" ]] && NET="${NET},gw=${GW}"
    [[ -n "${IP}" ]] && NET="${NET},ip=${IP}"
    pct create "${CTID}" "${TEMPLATE_DEBIAN}" --hostname "${HOSTNAME}" --memory "${MEMORY}" --cores "${CORES}" \
        --rootfs "${STORAGE}:${DISK}" --net0 "${NET}" --unprivileged 0 --features nesting=0

    ROOT_PASSWORD="${ROOT_PASSWORD:-$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c 12)}"
    echo "[*] Setting root password and starting container..."
    pct set "${CTID}" --password "${ROOT_PASSWORD}"
    pct start "${CTID}"

    echo "[*] Waiting for container to boot..."
    for i in $(seq 1 30); do
        if pct exec "${CTID}" -- true 2>/dev/null; then
            break
        fi
        sleep 2
    done
    if ! pct exec "${CTID}" -- true 2>/dev/null; then
        echo "[!] Container did not become ready in time. Check: pct status ${CTID}"
        exit 1
    fi
    echo "[+] Container ${CTID} is running. Root password: ${ROOT_PASSWORD} (change with: pct set ${CTID} --password 'newpass')"
fi

# Container must be running
if ! pct status "${CTID}" | grep -q running; then
    echo "[*] Starting CT ${CTID}..."
    pct start "${CTID}"
    for i in $(seq 1 20); do
        pct exec "${CTID}" -- true 2>/dev/null && break
        sleep 2
    done
fi

# Install dependencies and app inside CT
echo "[*] Installing dependencies in container..."
pct exec "${CTID}" -- bash -c "apt-get update -qq && apt-get install -y curl git ffmpeg build-essential python3"
pct exec "${CTID}" -- bash -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"

echo "[*] Cloning app to ${APP_DIR}..."
pct exec "${CTID}" -- bash -c "rm -rf ${APP_DIR} && git clone '${GIT_URL}' ${APP_DIR}"
pct exec "${CTID}" -- bash -c "chmod +x ${APP_DIR}/scripts/*.sh 2>/dev/null || true"

echo "[*] Installing npm dependencies..."
pct exec "${CTID}" -- bash -c "cd ${APP_DIR} && npm install"

# .env
if ! pct exec "${CTID}" -- test -f "${APP_DIR}/.env" 2>/dev/null; then
    echo "[*] Creating .env (edit: pct exec ${CTID} -- nano ${APP_DIR}/.env)"
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

# Update command and login banner
pct exec "${CTID}" -- bash -c "echo '#!/bin/sh' > /usr/local/bin/update && echo 'export APP_DIR=${APP_DIR}' >> /usr/local/bin/update && echo 'exec \${APP_DIR}/scripts/update.sh' >> /usr/local/bin/update && chmod +x /usr/local/bin/update"
pct exec "${CTID}" -- bash -c "cd ${APP_DIR} && ./scripts/install-motd.sh"

# Show access info
CONTAINER_IP=$(pct exec "${CTID}" -- hostname -I 2>/dev/null | awk '{print $1}' || true)
echo ""
echo "[+] Done. Discord Soundboard is running in CT ${CTID}."
echo "    Web UI:  http://${CONTAINER_IP:-<container-ip>}:3000"
echo "    Logs:    pct exec ${CTID} -- journalctl -u discord-soundboard -f"
echo "    Update:  CTID=${CTID} $0 update   (or inside CT: update)"
echo "    Backup:  pct exec ${CTID} -- bash -c 'cd ${APP_DIR} && ./scripts/backup.sh'"
if [[ -n "${ROOT_PASSWORD:-}" ]]; then
    echo "    Root:    pct enter ${CTID}  (password: ${ROOT_PASSWORD})"
fi
