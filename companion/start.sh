#!/usr/bin/env bash
# Soundboard Global Hotkey Companion — Start (Linux)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    echo "[!] No config found. Run ./setup.sh first!"
    exit 1
fi

echo "Starting companion... Press Ctrl+C to quit."
echo ""
python3 "$SCRIPT_DIR/hotkeys.py"
