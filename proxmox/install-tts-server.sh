#!/usr/bin/env bash
# TTS Server - Proxmox LXC install script with automatic GPU detection
# Creates a container, detects and passes through GPU devices, installs the TTS service.
#
# Usage: ./install-tts-server.sh [install|update]

set -e

# --- Config (override with env vars) ---
CT_HOSTNAME="${CT_HOSTNAME:-tts-server}"
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

# --- Colors ---
BL="\e[36m"; GN="\e[32m"; RD="\e[31m"; YW="\e[33m"; CL="\e[0m"
msg_info() { echo -e " ${BL}[i]${CL} $1"; }
msg_ok()   { echo -e " ${GN}[+]${CL} $1"; }
msg_warn() { echo -e " ${YW}[!]${CL} $1"; }
msg_err()  { echo -e " ${RD}[x]${CL} $1"; }

# --- Help ---
usage() {
    echo "Usage: $0 [install|update]"
    echo ""
    echo "  install  - Create GPU LXC and install TTS service (default)"
    echo "  update   - Update existing container (requires CTID)"
    echo ""
    echo "Override: CTID, CT_HOSTNAME, MEMORY, CORES, DISK, STORAGE, BRIDGE, GIT_URL, IP, GW"
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
    msg_err "Could not find free container ID"
    return 1
}

# --- GPU Detection (runs on Proxmox host) ---
detect_gpu() {
    GPU_TYPE=""
    GPU_DEVICES=()

    local pci_info
    pci_info=$(lspci -nn 2>/dev/null | grep -E "VGA|Display|3D" || true)

    if [[ -z "$pci_info" ]]; then
        msg_warn "No GPU detected via lspci"
        return
    fi

    # NVIDIA - vendor ID [10de]
    if grep -q "\[10de:" <<<"$pci_info"; then
        GPU_TYPE="nvidia"
        for d in /dev/nvidia{0,1,2,3,4,5,6,7} /dev/nvidiactl /dev/nvidia-modeset /dev/nvidia-uvm /dev/nvidia-uvm-tools; do
            [[ -c "$d" ]] && GPU_DEVICES+=("$d")
        done
        if [[ -d /dev/nvidia-caps ]]; then
            for d in /dev/nvidia-caps/*; do
                [[ -c "$d" ]] && GPU_DEVICES+=("$d")
            done
        fi
    # Intel iGPU - vendor ID [8086]
    elif grep -q "\[8086:" <<<"$pci_info"; then
        GPU_TYPE="intel"
        for d in /dev/dri/renderD* /dev/dri/card*; do
            [[ -e "$d" ]] && GPU_DEVICES+=("$d")
        done
    # AMD - vendor IDs [1002] or [1022]
    elif grep -qE "\[1002:|\[1022:" <<<"$pci_info"; then
        GPU_TYPE="amd"
        for d in /dev/dri/renderD* /dev/dri/card*; do
            [[ -e "$d" ]] && GPU_DEVICES+=("$d")
        done
    fi
}

# --- Configure GPU passthrough in LXC config ---
configure_gpu_passthrough() {
    local lxc_config="/etc/pve/lxc/${CTID}.conf"

    if [[ ${#GPU_DEVICES[@]} -eq 0 ]]; then
        msg_warn "No GPU devices to pass through"
        return
    fi

    msg_info "Configuring ${GPU_TYPE^^} GPU passthrough (${#GPU_DEVICES[@]} devices)..."

    # Stop container to modify config
    local was_running=false
    if pct status "${CTID}" 2>/dev/null | grep -q running; then
        was_running=true
        pct stop "${CTID}" 2>/dev/null || true
        sleep 2
    fi

    # Remove any existing dev lines to avoid duplicates
    sed -i '/^dev[0-9]*:/d' "$lxc_config"

    # Add device entries using Proxmox dev syntax
    local idx=0
    for dev in "${GPU_DEVICES[@]}"; do
        echo "dev${idx}: ${dev}" >> "$lxc_config"
        idx=$((idx + 1))
    done

    # Start container back up
    if $was_running || true; then
        pct start "${CTID}"
        for i in $(seq 1 30); do
            pct exec "${CTID}" -- true 2>/dev/null && break
            sleep 2
        done
    fi

    msg_ok "GPU passthrough configured (${#GPU_DEVICES[@]} devices passed through)"
}

# --- Setup auto-login (no password required for pct enter) ---
setup_autologin() {
    msg_info "Configuring auto-login..."
    pct exec "${CTID}" -- bash -c '
        GETTY_OVERRIDE="/etc/systemd/system/container-getty@1.service.d/override.conf"
        mkdir -p "$(dirname "$GETTY_OVERRIDE")"
        cat > "$GETTY_OVERRIDE" <<AEOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud tty%I 115200,38400,9600 \$TERM
AEOF
        systemctl daemon-reload
        systemctl restart "container-getty@1.service" 2>/dev/null || true
    '
    msg_ok "Auto-login configured (pct enter ${CTID} drops to root shell)"
}

# --- Set container description/notes ---
set_description() {
    local desc="<div align='center'>
<h3>TTS Server (Kokoro)</h3>
<p>Text-to-Speech service for Discord Soundboard</p>
<p>API: http://\${CONTAINER_IP}:8880</p>
<p>GPU: ${GPU_TYPE:-none}</p>
</div>"
    pct set "${CTID}" --description "$desc" 2>/dev/null || true
}

# --- Update ---
do_update() {
    if [[ -z "${CTID:-}" ]]; then
        msg_err "For update, set CTID (e.g. CTID=201 $0 update)"
        exit 1
    fi
    msg_info "Updating TTS server in CT ${CTID}..."
    pct exec "${CTID}" -- bash -c "cd ${APP_DIR} && git pull && ${APP_DIR}/tts-server/.venv/bin/pip install -r ${APP_DIR}/tts-server/requirements.txt && systemctl restart tts-server"
    msg_ok "TTS update done. Models were not changed."
}

if [[ "${1:-}" == "update" ]]; then
    do_update
    exit 0
fi

# --- Install ---
echo ""
echo -e "${BL}╔══════════════════════════════════════════╗${CL}"
echo -e "${BL}║   TTS Server - Proxmox LXC Installer     ║${CL}"
echo -e "${BL}╚══════════════════════════════════════════╝${CL}"
echo ""

# Detect GPU on host
msg_info "Detecting GPU on host..."
detect_gpu
if [[ -n "$GPU_TYPE" ]]; then
    msg_ok "Detected ${GPU_TYPE^^} GPU (${#GPU_DEVICES[@]} devices: ${GPU_DEVICES[*]})"
else
    msg_warn "No GPU detected. TTS will run on CPU (slower but functional)."
    echo "    To use GPU, ensure NVIDIA/Intel/AMD drivers are installed on the host."
    echo ""
    read -p "    Continue without GPU? [y/N] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]] || exit 0
fi

# Resolve CTID
if [[ -n "${CTID:-}" ]]; then
    msg_info "Using container ID: ${CTID}"
else
    for id in $(pct list 2>/dev/null | awk 'NR>1 {print $1}'); do
        conf_hostname=$(pct config "$id" 2>/dev/null | grep '^hostname:' | sed 's/.*: *//;s/^ *//;s/ *$//')
        if [[ "$conf_hostname" == "${CT_HOSTNAME}" ]]; then
            CTID="$id"
            msg_info "Found existing container with hostname ${CT_HOSTNAME}: ${CTID} (resuming)"
            break
        fi
    done
    if [[ -z "${CTID:-}" ]]; then
        CTID=$(get_next_ctid)
        msg_info "Using next free container ID: ${CTID}"
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
        msg_err "No Debian/Ubuntu template found. Download one from the Proxmox UI."
        exit 1
    fi
fi
msg_info "Using template: ${TEMPLATE_DEBIAN}"

# Create CT if not exists
if ! pct status "${CTID}" &>/dev/null; then
    msg_info "Creating LXC ${CTID} (${CT_HOSTNAME})..."
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
    pct create "${CTID}" "${TEMPLATE_DEBIAN}" --hostname "${CT_HOSTNAME}" --memory "${MEMORY}" --cores "${CORES}" \
        --rootfs "${STORAGE}:${DISK}" --net0 "${NET}" --unprivileged 0 --features nesting=1 ${NS_FOR_CT} --onboot 1

    msg_info "Starting container..."
    pct start "${CTID}"

    msg_info "Waiting for container to boot..."
    for i in $(seq 1 30); do
        if pct exec "${CTID}" -- true 2>/dev/null; then break; fi
        sleep 2
    done
    if ! pct exec "${CTID}" -- true 2>/dev/null; then
        msg_err "Container did not become ready. Check: pct status ${CTID}"
        exit 1
    fi
    msg_ok "Container ${CTID} is running"
fi

# Container must be running
if ! pct status "${CTID}" | grep -q running; then
    msg_info "Starting CT ${CTID}..."
    pct start "${CTID}"
    for i in $(seq 1 20); do
        pct exec "${CTID}" -- true 2>/dev/null && break
        sleep 2
    done
fi

# Configure GPU passthrough (auto-detect already ran above)
if [[ -n "$GPU_TYPE" && ${#GPU_DEVICES[@]} -gt 0 ]]; then
    configure_gpu_passthrough
fi

# Setup auto-login
setup_autologin

# Wait for network
msg_info "Waiting for container network..."
ip_in_ct=""
for i in $(seq 1 25); do
    ip_in_ct=$(pct exec "${CTID}" -- ip -4 addr show dev eth0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1)
    [[ -n "$ip_in_ct" ]] && break
    sleep 1
done
if [[ -z "$ip_in_ct" ]]; then
    msg_err "No IP on eth0 after 25s."
    exit 1
fi
msg_ok "Container network ready (${ip_in_ct})"

# Ensure DNS
msg_info "Ensuring container DNS..."
HOST_NS=$(grep "^nameserver" /etc/resolv.conf 2>/dev/null | head -2 | awk '{print $2}' | tr '\n' ' ')
if [[ -z "$HOST_NS" ]]; then HOST_NS="8.8.8.8 1.1.1.1"; fi
pct exec "${CTID}" -- bash -c 'if ! grep -q "^nameserver" /etc/resolv.conf 2>/dev/null; then
  for ns in '"${HOST_NS}"'; do echo "nameserver $ns"; done > /etc/resolv.conf
fi'
sleep 5
if ! pct exec "${CTID}" -- getent hosts deb.debian.org &>/dev/null; then
  sleep 5
  if ! pct exec "${CTID}" -- getent hosts deb.debian.org &>/dev/null; then
    msg_err "Container cannot resolve DNS."
    exit 1
  fi
fi

# Run container-side install script
INSTALL_SCRIPT_URL="${INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/smartpbx/discord-soundboard/main/proxmox/install/tts-server-install.sh}"
msg_info "Running install inside container..."
pct exec "${CTID}" -- bash -c "apt-get update -qq && apt-get install -y curl ca-certificates && curl -fsSL '${INSTALL_SCRIPT_URL}' | env APP_DIR='${APP_DIR}' GIT_URL='${GIT_URL}' GPU_TYPE='${GPU_TYPE}' bash -s"

# Set container description in Proxmox UI
CONTAINER_IP=$(pct exec "${CTID}" -- hostname -I 2>/dev/null | awk '{print $1}' || true)
set_description

# Show access info
echo ""
echo -e "${GN}══════════════════════════════════════════${CL}"
echo -e "${GN}  TTS Server installed successfully!${CL}"
echo -e "${GN}══════════════════════════════════════════${CL}"
echo ""
echo "    Container:  CT ${CTID} (${CT_HOSTNAME})"
echo "    API:        http://${CONTAINER_IP:-<container-ip>}:8880"
echo "    Health:     curl http://${CONTAINER_IP:-<container-ip>}:8880/health"
echo "    GPU:        ${GPU_TYPE:-none} (${#GPU_DEVICES[@]} devices)"
echo "    Logs:       pct exec ${CTID} -- journalctl -u tts-server -f"
echo "    Console:    pct enter ${CTID}  (auto-login, no password)"
echo "    Update:     CTID=${CTID} $0 update   (or inside CT: update)"
echo ""
echo -e "${YW}  Next step: Add to your soundboard .env:${CL}"
echo "    TTS_API_URL=http://${CONTAINER_IP:-<container-ip>}:8880"
echo ""
