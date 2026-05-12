#!/usr/bin/env bash
# Run inside the container (e.g. from LXC console).
# Updates app code only; keeps .env and sounds/ intact.
set -e
APP_DIR="${APP_DIR:-/opt/discord-soundboard}"
cd "$APP_DIR"
echo "[*] Pulling latest code..."
git pull
echo "[*] Installing dependencies..."
npm install
echo "[*] Ensuring yt-dlp is installed and up to date..."
if command -v pip3 >/dev/null 2>&1; then
    pip3 install --break-system-packages --upgrade yt-dlp 2>/dev/null \
        || pip3 install --upgrade yt-dlp 2>/dev/null \
        || echo "[!] yt-dlp install failed (TTS voice admin YouTube fetch will be unavailable)"
fi
echo "[*] Ensuring Claude Code CLI is installed (Phase 10 voice training)..."
if ! command -v claude >/dev/null 2>&1; then
    npm install -g @anthropic-ai/claude-code 2>&1 | tail -3 \
        || echo "[!] Claude Code install failed (Phase 10 Train new voice will be unavailable)"
fi
echo "[*] Ensuring vosk speech-to-text model is present (voice triggers)..."
VOSK_MODEL_DIR="$APP_DIR/models/vosk-en-us-small"
VOSK_MODEL_URL="https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
if [ ! -f "$VOSK_MODEL_DIR/am/final.mdl" ]; then
    echo "[*] Downloading vosk small English model (~40MB)..."
    mkdir -p "$APP_DIR/models"
    TMPZIP="$(mktemp -t vosk-model.XXXXXX.zip)"
    if curl -fL --retry 3 -o "$TMPZIP" "$VOSK_MODEL_URL"; then
        rm -rf "$VOSK_MODEL_DIR"
        TMPDIR_EXTRACT="$(mktemp -d)"
        unzip -q "$TMPZIP" -d "$TMPDIR_EXTRACT"
        # zip extracts to vosk-model-small-en-us-0.15/ — rename to our stable path
        EXTRACTED="$(find "$TMPDIR_EXTRACT" -maxdepth 1 -mindepth 1 -type d | head -1)"
        if [ -n "$EXTRACTED" ]; then
            mv "$EXTRACTED" "$VOSK_MODEL_DIR"
            echo "[+] vosk model installed at $VOSK_MODEL_DIR"
        else
            echo "[!] vosk model unzip produced no directory; voice triggers will be disabled"
        fi
        rm -rf "$TMPDIR_EXTRACT" "$TMPZIP"
    else
        echo "[!] vosk model download failed; voice triggers will be disabled"
        rm -f "$TMPZIP"
    fi
else
    echo "[=] vosk model already installed."
fi
echo "[*] Restarting service..."
systemctl restart discord-soundboard
echo "[+] Update done. Your .env and sounds/ were not changed."
