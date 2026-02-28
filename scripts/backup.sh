#!/usr/bin/env bash
# Run inside the container to export a full backup (sounds, metadata, .env).
# Usage: ./scripts/backup.sh [output.tar.gz]
# Default: discord-soundboard-backup-YYYYMMDD-HHMMSS.tar.gz in APP_DIR or current dir.
set -e
APP_DIR="${APP_DIR:-/opt/discord-soundboard}"
cd "$APP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT="${1:-${APP_DIR}/discord-soundboard-backup-${TS}.tar.gz}"
mkdir -p "$(dirname "$OUT")"
echo "[*] Backing up .env and sounds/ to $OUT"
if [[ -f .env ]]; then
    if [[ -d sounds ]]; then
        tar czf "$OUT" .env sounds/
    else
        tar czf "$OUT" .env
    fi
else
    if [[ -d sounds ]]; then
        tar czf "$OUT" sounds/
    else
        echo "[!] No .env or sounds/ found."
        exit 1
    fi
fi
echo "[+] Backup saved: $OUT"
echo "    Copy off container: pct pull <CTID> $OUT ./"
