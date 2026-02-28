#!/usr/bin/env bash
# Discord Soundboard - Proxmox LXC install script (single run)
# Run once on your Proxmox host. Creates container, sets password, starts, runs install script inside.
#
# Standalone: no integration with community-scripts/ProxmoxVE. We use only our own logic;
# layout (host script + install/AppName-install.sh inside container) is inspired by their guide.
# Usage: ./install-discord-soundboard.sh [install|update]

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

# Resolve CTID: prefer existing container with our hostname (so reruns continue on same CT), else next free or user's CTID
if [[ -n "${CTID:-}" ]]; then
    echo "[*] Using container ID: ${CTID} (from CTID)"
else
    # Look for existing container with hostname discord-soundboard (e.g. from a previous failed run)
    for id in $(pct list 2>/dev/null | awk 'NR>1 {print $1}'); do
        conf_hostname=$(pct config "$id" 2>/dev/null | grep '^hostname:' | sed 's/.*: *//;s/^ *//;s/ *$//')
        if [[ "$conf_hostname" == "${HOSTNAME}" ]]; then
            CTID="$id"
            echo "[*] Found existing container with hostname ${HOSTNAME}: ${CTID} (resuming install)"
            break
        fi
    done
    if [[ -z "${CTID:-}" ]]; then
        CTID=$(get_next_ctid)
        echo "[*] Using next free container ID: ${CTID}"
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
    # Build net0: must include ip=dhcp or ip=CIDR so eth0 comes up (community-scripts pattern)
    NET="name=eth0,bridge=${BRIDGE}"
    if [[ -n "${IP}" ]]; then
        NET="${NET},ip=${IP}"
        [[ -n "${GW}" ]] && NET="${NET},gw=${GW}"
    else
        NET="${NET},ip=dhcp"
        [[ -n "${GW}" ]] && NET="${NET},gw=${GW}"
    fi
    # Nameserver at create time (Proxmox injects into container); fallback if host has none
    NS_FOR_CT=""
    HOST_NS_CREATE=$(grep "^nameserver" /etc/resolv.conf 2>/dev/null | head -1 | awk '{print $2}')
    if [[ -n "$HOST_NS_CREATE" ]]; then
        NS_FOR_CT="--nameserver ${HOST_NS_CREATE}"
    else
        NS_FOR_CT="--nameserver 8.8.8.8"
    fi
    # Bind-mount data dir on host so volume, channel, guest settings persist across container rebuilds
    DATA_MOUNT_HOST="/var/lib/discord-soundboard-data/${CTID}"
    mkdir -p "${DATA_MOUNT_HOST}"
    pct create "${CTID}" "${TEMPLATE_DEBIAN}" --hostname "${HOSTNAME}" --memory "${MEMORY}" --cores "${CORES}" \
        --rootfs "${STORAGE}:${DISK}" --net0 "${NET}" --unprivileged 0 --features nesting=0 ${NS_FOR_CT} --onboot 1 \
        --mp0 "${DATA_MOUNT_HOST},mp=${APP_DIR}/data"

    ROOT_PASSWORD="${ROOT_PASSWORD:-$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c 12)}"
    echo "[*] Starting container..."
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
    echo "[*] Setting root password..."
    pct exec "${CTID}" -- bash -c "echo 'root:${ROOT_PASSWORD}' | chpasswd"
    echo "[+] Container ${CTID} is running. Root password: ${ROOT_PASSWORD} (change with: pct exec ${CTID} -- passwd)"
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

# Wait for network (eth0 up + IP) before apt/curl - community-scripts pattern
echo "[*] Waiting for container network..."
ip_in_ct=""
for i in $(seq 1 25); do
    ip_in_ct=$(pct exec "${CTID}" -- ip -4 addr show dev eth0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1)
    [[ -n "$ip_in_ct" ]] && break
    sleep 1
done
if [[ -z "$ip_in_ct" ]]; then
    echo "[!] No IP on eth0 after 25s. Check bridge ${BRIDGE} and DHCP."
    echo "    If resuming a failed install, destroy and re-run: pct stop ${CTID}; pct destroy ${CTID}"
    echo "    Debug: pct exec ${CTID} -- ip a"
    exit 1
fi
echo "[*] Container network ready (${ip_in_ct})"

# New containers often have no DNS at first; set nameservers before any apt/curl
echo "[*] Ensuring container DNS..."
# Use host's nameservers if available, else public DNS
HOST_NS=$(grep "^nameserver" /etc/resolv.conf 2>/dev/null | head -2 | awk '{print $2}' | tr '\n' ' ')
if [[ -z "$HOST_NS" ]]; then
  HOST_NS="8.8.8.8 1.1.1.1"
fi
pct exec "${CTID}" -- bash -c 'if ! grep -q "^nameserver" /etc/resolv.conf 2>/dev/null; then
  for ns in '"${HOST_NS}"'; do echo "nameserver $ns"; done > /etc/resolv.conf
fi'
sleep 5
# Retry once in case network wasn't ready
if ! pct exec "${CTID}" -- getent hosts deb.debian.org &>/dev/null; then
  sleep 5
  if ! pct exec "${CTID}" -- getent hosts deb.debian.org &>/dev/null; then
    echo "[!] Container cannot resolve DNS. Try: pct exec ${CTID} -- cat /etc/resolv.conf"
    exit 1
  fi
fi

# Run container-side install script
# Install curl in container first (minimal template may not have it), then fetch and run install script inside CT.
INSTALL_SCRIPT_URL="${INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/smartpbx/discord-soundboard/main/proxmox/install/discord-soundboard-install.sh}"
SESSION_RANDOM=$(openssl rand -hex 32 2>/dev/null || true)
echo "[*] Running install inside container..."
pct exec "${CTID}" -- bash -c "apt-get update -qq && apt-get install -y curl ca-certificates && curl -fsSL '${INSTALL_SCRIPT_URL}' | env APP_DIR='${APP_DIR}' GIT_URL='${GIT_URL}' SESSION_SECRET='${SESSION_RANDOM}' bash -s"

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
