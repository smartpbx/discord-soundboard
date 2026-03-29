#!/usr/bin/env bash
# Soundboard Global Hotkey Companion — Setup (Linux)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo "  Soundboard Global Hotkey Companion Setup"
echo "============================================"
echo ""

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "[!] Python 3 not found. Install it:"
    echo "    Arch/Manjaro: sudo pacman -S python python-pip"
    echo "    Ubuntu/Debian: sudo apt install python3 python3-pip"
    exit 1
fi
echo "[+] Python 3 found."

# Install dependencies
echo "[*] Installing required packages..."
pip3 install --user keyboard requests 2>/dev/null || pip install --user keyboard requests
echo "[+] Packages installed."

# Add user to input group (needed for keyboard library without root)
if ! groups | grep -q '\binput\b'; then
    echo ""
    echo "[*] Your user is NOT in the 'input' group."
    echo "    The companion needs this to capture global hotkeys."
    read -p "    Add $(whoami) to the input group now? [Y/n] " yn
    if [[ "$yn" != "n" && "$yn" != "N" ]]; then
        sudo usermod -aG input "$(whoami)"
        echo "[+] Added to input group. You need to LOG OUT and back in for this to take effect."
    fi
fi

# Create .env if missing
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    echo "[+] Config file found (.env)"
else
    echo ""
    echo "[*] First-time setup — let's configure your connection."
    echo ""
    read -p "Soundboard URL (e.g. https://soundboard.example.com): " SURL
    read -p "Companion Token (same as COMPANION_TOKEN in your LXC .env): " STOKEN
    cat > "$SCRIPT_DIR/.env" <<EOF
# Soundboard Companion Config
SOUNDBOARD_URL=$SURL
COMPANION_TOKEN=$STOKEN
STOP_KEY=s
PAUSE_KEY=space
EOF
    echo "[+] Config saved to .env"
fi

echo ""
echo "    Setup complete! Run: ./start.sh"
echo ""
