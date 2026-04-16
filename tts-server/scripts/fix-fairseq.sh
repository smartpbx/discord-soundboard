#!/usr/bin/env bash
# Fix fairseq dataclass bug for Python 3.11+
# Replaces mutable class defaults with field(default_factory=...)
set -e
VENV="/opt/discord-soundboard/tts-server/.venv"
F="$VENV/lib/python3.11/site-packages/fairseq/dataclass/configs.py"

if [ ! -f "$F" ]; then
    echo "[!] fairseq configs.py not found at $F"
    exit 1
fi

echo "[*] Patching $F ..."

# Replace all instances of "= SomeConfig()" with "= field(default_factory=SomeConfig)"
sed -i -E 's/= ([A-Z][a-zA-Z]+Config)\(\)/= field(default_factory=\1)/g' "$F"

COUNT=$(grep -c "default_factory" "$F" || true)
echo "[+] Done. Found $COUNT default_factory entries."

echo "[*] Restarting tts-server..."
systemctl restart tts-server
echo "[+] Service restarted."
