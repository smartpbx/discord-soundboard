#!/usr/bin/env bash
# Run inside the container to restore from a backup tarball.
# Usage: ./scripts/restore.sh /path/to/discord-soundboard-backup-*.tar.gz
# Tarball should contain .env and sounds/ (as created by backup.sh).
set -e
APP_DIR="${APP_DIR:-/opt/discord-soundboard}"
ARCHIVE="${1:?Usage: $0 /path/to/backup.tar.gz}"
cd "$APP_DIR"
if [[ ! -f "$ARCHIVE" ]]; then
    echo "[!] File not found: $ARCHIVE"
    echo "    Copy into container first: pct push ${CTID:-?} ./backup.tar.gz $APP_DIR/"
    exit 1
fi
echo "[*] Stopping service..."
systemctl stop discord-soundboard || true
echo "[*] Restoring from $ARCHIVE..."
tar xzf "$ARCHIVE" -C "$APP_DIR"
echo "[*] Starting service..."
systemctl start discord-soundboard
echo "[+] Restore done. .env and sounds/ replaced from backup."
