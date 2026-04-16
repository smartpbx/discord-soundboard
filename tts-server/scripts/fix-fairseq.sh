#!/usr/bin/env bash
# Fix fairseq 0.12.2 dataclass bug for Python 3.11+ compatibility.
#
# The issue: fairseq uses `common: CommonConfig = CommonConfig()` which
# Python 3.11+ rejects because CommonConfig() is a mutable default.
#
# The fix: wrap in field(default_factory=lambda: CommonConfig()) so
# each instance gets its own copy.
set -e
VENV="/opt/discord-soundboard/tts-server/.venv"
F="$VENV/lib/python3.11/site-packages/fairseq/dataclass/configs.py"

if [ ! -f "$F" ]; then
    echo "[!] fairseq configs.py not found at $F"
    exit 1
fi

echo "[*] Patching $F ..."

# First, ensure 'field' is imported
grep -q "from dataclasses import.*field" "$F" || \
    sed -i 's/from dataclasses import dataclass/from dataclasses import dataclass, field/' "$F"

# Replace all "= SomeConfig()" with "= field(default_factory=lambda: SomeConfig())"
# Using lambda ensures the instance is created fresh each time (same semantics as original)
sed -i -E 's/: ([A-Z][a-zA-Z]+) = ([A-Z][a-zA-Z]+)\(\)$/: \1 = field(default_factory=lambda: \2())/' "$F"

COUNT=$(grep -c "default_factory=lambda" "$F" || true)
echo "[+] Done. Patched $COUNT fields."

echo "[*] Restarting tts-server..."
systemctl restart tts-server
echo "[+] Service restarted."
