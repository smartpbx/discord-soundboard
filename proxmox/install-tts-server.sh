#!/usr/bin/env bash
# TTS Server - Proxmox LXC install script (GPU-enabled)
# Creates a container with NVIDIA GPU passthrough, installs the TTS service.
#
# Prerequisites:
#   - NVIDIA driver installed on the Proxmox host
#   - /dev/nvidia* devices available on the host
#
# Usage: ./install-tts-server.sh [install|update]
# GPU passthrough: After install, add to /etc/pve/lxc/<CTID>.conf:
#   lxc.cgroup2.devices.allow: c 195:* rwm
#   lxc.cgroup2.devices.allow: c 509:* rwm
#   lxc.mount.entry: /dev/nvidia0 dev/nvidia0 none bind,optional,create=file
#   lxc.mount.entry: /dev/nvidiactl dev/nvidiactl none bind,optional,create=file
#   lxc.mount.entry: /dev/nvidia-uvm dev/nvidia-uvm none bind,optional,create=file
#   lxc.mount.entry: /dev/nvidia-uvm-tools dev/nvidia-uvm-tools none bind,optional,create=file

set -e

# --- Config (override with env vars) ---
HOSTNAME="${HOSTNAME:-tts-server}"
MEMORY="${MEMORY:-4096}"
CORES="${CORES:-4}"
DISK="${DISK:-20}"
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"
GW="${GW:-}"
IP="${IP:-}"
GIT_URL="${GIT_URL:-https://github.com/smartpbx/discord-soundboard.git}"
APP_DIR="/opt/discord-soundboard"
TEMPLATE_DEBIAN="${TEMPLATE_DEBIAN:-}"

# --- Help ---
usage() {
    echo "Usage: $0 [install|update]"
    echo ""
    echo "  install  - Create GPU LXC and install TTS service (default)"
    echo "  update   - Update existing container (requires CTID)"
    echo ""
    echo "Override: CTID, HOSTNAME, MEMORY, CORES, DISK, STORAGE, BRIDGE, GIT_URL, IP, GW"
    exit 0
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; fi

# --- Next free container ID ---
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

# --- Update ---
do_update() {
    if [[ -z "${CTID:-}" ]]; then
        echo "For update, set CTID (e.g. CTID=201 $0 update)"
        exit 1
    fi
    echo "[*] Updating TTS server in CT ${CTID}..."
    pct exec "${CTID}" -- bash -c "cd ${APP_DIR} && git pull && ${APP_DIR}/tts-server/.venv/bin/pip install -r ${APP_DIR}/tts-server/requirements.txt && systemctl restart tts-server"
    echo "[+] TTS update done. Models were not changed."
}

if [[ "${1:-}" == "update" ]]; then
    do_update
    exit 0
fi

# --- Install ---
echo "[*] TTS Server - Proxmox LXC installer (GPU-enabled)"

# Resolve CTID
if [[ -n "${CTID:-}" ]]; then
    echo "[*] Using container ID: ${CTID}"
else
    for id in $(pct list 2>/dev/null | awk 'NR>1 {print $1}'); do
        conf_hostname=$(pct config "$id" 2>/dev/null | grep '^hostname:' | sed 's/.*: *//;s/^ *//;s/ *$//')
        if [[ "$conf_hostname" == "${HOSTNAME}" ]]; then
            CTID="$id"
            echo "[*] Found existing container with hostname ${HOSTNAME}: ${CTID}"
            break
        fi
    done
    if [[ -z "${CTID:-}" ]]; then
        CTID=$(get_next_ctid)
        echo "[*] Using next free container ID: ${CTID}"
    fi
fi

# Resolve template
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
        echo "No Debian/Ubuntu template found. Download one from the Proxmox UI."
        exit 1
    fi
fi
echo "[*] Using template: ${TEMPLATE_DEBIAN}"

# Create CT if not exists
if ! pct status "${CTID}" &>/dev/null; then
    echo "[*] Creating LXC ${CTID}..."
    NET="name=eth0,bridge=${BRIDGE}"
    if [[ -n "${IP}" ]]; then
        NET="${NET},ip=${IP}"
        [[ -n "${GW}" ]] && NET="${NET},gw=${GW}"
    else
        NET="${NET},ip=dhcp"
        [[ -n "${GW}" ]] && NET="${NET},gw=${GW}"
    fi
    NS_FOR_CT=""
    HOST_NS_CREATE=$(grep "^nameserver" /etc/resolv.conf 2>/dev/null | head -1 | awk '{print $2}')
    if [[ -n "$HOST_NS_CREATE" ]]; then
        NS_FOR_CT="--nameserver ${HOST_NS_CREATE}"
    else
        NS_FOR_CT="--nameserver 8.8.8.8"
    fi
    # NOTE: GPU LXC needs privileged mode for device passthrough
    pct create "${CTID}" "${TEMPLATE_DEBIAN}" --hostname "${HOSTNAME}" --memory "${MEMORY}" --cores "${CORES}" \
        --rootfs "${STORAGE}:${DISK}" --net0 "${NET}" --unprivileged 0 --features nesting=1 ${NS_FOR_CT} --onboot 1

    ROOT_PASSWORD="${ROOT_PASSWORD:-$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c 12)}"
    echo "[*] Starting container..."
    pct start "${CTID}"

    echo "[*] Waiting for container to boot..."
    for i in $(seq 1 30); do
        if pct exec "${CTID}" -- true 2>/dev/null; then break; fi
        sleep 2
    done
    if ! pct exec "${CTID}" -- true 2>/dev/null; then
        echo "[!] Container did not become ready. Check: pct status ${CTID}"
        exit 1
    fi
    echo "[*] Setting root password..."
    pct exec "${CTID}" -- bash -c "echo 'root:${ROOT_PASSWORD}' | chpasswd"
    echo "[+] Container ${CTID} is running. Root password: ${ROOT_PASSWORD}"
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

# Wait for network
echo "[*] Waiting for container network..."
ip_in_ct=""
for i in $(seq 1 25); do
    ip_in_ct=$(pct exec "${CTID}" -- ip -4 addr show dev eth0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1)
    [[ -n "$ip_in_ct" ]] && break
    sleep 1
done
if [[ -z "$ip_in_ct" ]]; then
    echo "[!] No IP on eth0 after 25s."
    exit 1
fi
echo "[*] Container network ready (${ip_in_ct})"

# Ensure DNS
echo "[*] Ensuring container DNS..."
HOST_NS=$(grep "^nameserver" /etc/resolv.conf 2>/dev/null | head -2 | awk '{print $2}' | tr '\n' ' ')
if [[ -z "$HOST_NS" ]]; then HOST_NS="8.8.8.8 1.1.1.1"; fi
pct exec "${CTID}" -- bash -c 'if ! grep -q "^nameserver" /etc/resolv.conf 2>/dev/null; then
  for ns in '"${HOST_NS}"'; do echo "nameserver $ns"; done > /etc/resolv.conf
fi'
sleep 5
if ! pct exec "${CTID}" -- getent hosts deb.debian.org &>/dev/null; then
  sleep 5
  if ! pct exec "${CTID}" -- getent hosts deb.debian.org &>/dev/null; then
    echo "[!] Container cannot resolve DNS."
    exit 1
  fi
fi

# Run container-side install script
INSTALL_SCRIPT_URL="${INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/smartpbx/discord-soundboard/main/proxmox/install/tts-server-install.sh}"
echo "[*] Running install inside container..."
pct exec "${CTID}" -- bash -c "apt-get update -qq && apt-get install -y curl ca-certificates && curl -fsSL '${INSTALL_SCRIPT_URL}' | env APP_DIR='${APP_DIR}' GIT_URL='${GIT_URL}' bash -s"

# Show access info
CONTAINER_IP=$(pct exec "${CTID}" -- hostname -I 2>/dev/null | awk '{print $1}' || true)
echo ""
echo "[+] Done. TTS server is running in CT ${CTID}."
echo "    API:     http://${CONTAINER_IP:-<container-ip>}:8880"
echo "    Health:  curl http://${CONTAINER_IP:-<container-ip>}:8880/health"
echo "    Logs:    pct exec ${CTID} -- journalctl -u tts-server -f"
echo "    Update:  CTID=${CTID} $0 update   (or inside CT: update)"
echo ""
echo "[!] GPU passthrough: Add the following to /etc/pve/lxc/${CTID}.conf and restart:"
echo "    lxc.cgroup2.devices.allow: c 195:* rwm"
echo "    lxc.cgroup2.devices.allow: c 509:* rwm"
echo "    lxc.mount.entry: /dev/nvidia0 dev/nvidia0 none bind,optional,create=file"
echo "    lxc.mount.entry: /dev/nvidiactl dev/nvidiactl none bind,optional,create=file"
echo "    lxc.mount.entry: /dev/nvidia-uvm dev/nvidia-uvm none bind,optional,create=file"
echo "    lxc.mount.entry: /dev/nvidia-uvm-tools dev/nvidia-uvm-tools none bind,optional,create=file"
echo ""
echo "[!] Then set TTS_API_URL=http://${CONTAINER_IP:-<container-ip>}:8880 in your soundboard .env"
if [[ -n "${ROOT_PASSWORD:-}" ]]; then
    echo "    Root:    pct enter ${CTID}  (password: ${ROOT_PASSWORD})"
fi
