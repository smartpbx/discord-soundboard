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
echo "[*] Backing up .env, sounds/, data/ to $OUT"
FILES=()
[[ -f .env ]] && FILES+=(.env)
[[ -d sounds ]] && FILES+=(sounds/)
[[ -d data ]] && FILES+=(data/)
if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "[!] No .env, sounds/, or data/ found."
    exit 1
fi
tar czf "$OUT" "${FILES[@]}"
echo "[+] Backup saved: $OUT"
echo "    Copy off container: pct pull <CTID> $OUT ./"
