#!/usr/bin/env bash
# Download and prepare reference audio clips for Chatterbox voice cloning.
#
# Usage:
#   ./prepare-reference.sh <id>           # Download a preset
#   ./prepare-reference.sh <id> <url> <start> <duration>  # Custom clip
#
# Each preset downloads a YouTube video, extracts a clean audio segment,
# and saves it as models/chatterbox/<id>/reference.wav (mono 24kHz)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODELS_DIR="${SCRIPT_DIR}/../models/chatterbox"
mkdir -p "$MODELS_DIR"

# --- Presets: YouTube URL, start time (seconds), duration (seconds) ---
# Each clip should be clear solo speech, no background music/noise
declare -A P_URL P_START P_DUR P_NAME P_GENDER P_GROUP

# Politicians
P_URL[trump]="https://www.youtube.com/watch?v=e4pLH7CF-PE"
P_START[trump]="32"
P_DUR[trump]="8"
P_NAME[trump]="Donald Trump"
P_GENDER[trump]="male"
P_GROUP[trump]="Celebrity"

P_URL[biden]="https://www.youtube.com/watch?v=2Nwl2dR1MGs"
P_START[biden]="15"
P_DUR[biden]="8"
P_NAME[biden]="Joe Biden"
P_GENDER[biden]="male"
P_GROUP[biden]="Celebrity"

P_URL[obama]="https://www.youtube.com/watch?v=CnrJFaXWB7I"
P_START[obama]="20"
P_DUR[obama]="8"
P_NAME[obama]="Barack Obama"
P_GENDER[obama]="male"
P_GROUP[obama]="Celebrity"

# Actors
P_URL[freeman]="https://www.youtube.com/watch?v=Ch5MEJk5ZCQ"
P_START[freeman]="10"
P_DUR[freeman]="8"
P_NAME[freeman]="Morgan Freeman"
P_GENDER[freeman]="male"
P_GROUP[freeman]="Celebrity"

P_URL[arnold]="https://www.youtube.com/watch?v=ldIwEG9xQ-M"
P_START[arnold]="30"
P_DUR[arnold]="8"
P_NAME[arnold]="Arnold Schwarzenegger"
P_GENDER[arnold]="male"
P_GROUP[arnold]="Celebrity"

P_URL[snoop]="https://www.youtube.com/watch?v=YIRFptk4gX4"
P_START[snoop]="15"
P_DUR[snoop]="8"
P_NAME[snoop]="Snoop Dogg"
P_GENDER[snoop]="male"
P_GROUP[snoop]="Celebrity"

P_URL[jack_black]="https://www.youtube.com/watch?v=LLaGqJwSfrY"
P_START[jack_black]="20"
P_DUR[jack_black]="8"
P_NAME[jack_black]="Jack Black"
P_GENDER[jack_black]="male"
P_GROUP[jack_black]="Celebrity"

P_URL[emma_watson]="https://www.youtube.com/watch?v=LLhSHFxYRkE"
P_START[emma_watson]="25"
P_DUR[emma_watson]="8"
P_NAME[emma_watson]="Emma Watson"
P_GENDER[emma_watson]="female"
P_GROUP[emma_watson]="Celebrity"

P_URL[elon]="https://www.youtube.com/watch?v=Ip2P3tFCRYo"
P_START[elon]="40"
P_DUR[elon]="8"
P_NAME[elon]="Elon Musk"
P_GENDER[elon]="male"
P_GROUP[elon]="Celebrity"

# Cartoon (these need clips from shows - harder to find clean solo audio)
P_URL[homer]="https://www.youtube.com/watch?v=w-0CS-T1HUQ"
P_START[homer]="5"
P_DUR[homer]="8"
P_NAME[homer]="Homer Simpson"
P_GENDER[homer]="male"
P_GROUP[homer]="Cartoon"

P_URL[rick]="https://www.youtube.com/watch?v=GZpKq9VhJfk"
P_START[rick]="10"
P_DUR[rick]="8"
P_NAME[rick]="Rick Sanchez"
P_GENDER[rick]="male"
P_GROUP[rick]="Cartoon"

P_URL[batman]="https://www.youtube.com/watch?v=DUY1AeMRCqs"
P_START[batman]="5"
P_DUR[batman]="8"
P_NAME[batman]="Batman"
P_GENDER[batman]="male"
P_GROUP[batman]="Cartoon"

P_URL[stewie]="https://www.youtube.com/watch?v=Tc1jmGqhHSM"
P_START[stewie]="5"
P_DUR[stewie]="8"
P_NAME[stewie]="Stewie Griffin"
P_GENDER[stewie]="male"
P_GROUP[stewie]="Cartoon"

P_URL[patrick]="https://www.youtube.com/watch?v=t7Bx5TFcVJU"
P_START[patrick]="10"
P_DUR[patrick]="8"
P_NAME[patrick]="Patrick Star"
P_GENDER[patrick]="male"
P_GROUP[patrick]="Cartoon"

# --- Parse args ---
ID="${1:-}"
if [[ -z "$ID" ]]; then
    echo "Usage: $0 <id> [url] [start_sec] [duration_sec]"
    echo ""
    echo "Pre-configured voices:"
    for key in "${!P_NAME[@]}"; do
        echo "  $0 $key"
    done | sort
    exit 1
fi

# Resolve parameters
if [[ -n "${P_URL[$ID]:-}" && -z "${2:-}" ]]; then
    URL="${P_URL[$ID]}"
    START="${P_START[$ID]}"
    DUR="${P_DUR[$ID]}"
    NAME="${P_NAME[$ID]}"
    GENDER="${P_GENDER[$ID]}"
    GROUP="${P_GROUP[$ID]}"
    echo "[*] Using preset: ${NAME}"
else
    URL="${2:?URL required}"
    START="${3:-0}"
    DUR="${4:-8}"
    NAME="${ID}"
    GENDER="unknown"
    GROUP="Celebrity"
fi

VOICE_DIR="${MODELS_DIR}/${ID}"
mkdir -p "$VOICE_DIR"

# --- Download and extract ---
echo "[*] Downloading audio from YouTube..."
TMP_AUDIO="/tmp/ref_${ID}_raw.wav"
yt-dlp -x --audio-format wav -o "/tmp/ref_${ID}_full.%(ext)s" "$URL" 2>/dev/null || {
    echo "[!] yt-dlp failed. Trying with --no-check-certificates..."
    yt-dlp -x --audio-format wav --no-check-certificates -o "/tmp/ref_${ID}_full.%(ext)s" "$URL"
}

# Find the downloaded file (yt-dlp may add format extension)
FULL_FILE=$(ls /tmp/ref_${ID}_full.* 2>/dev/null | head -1)
if [[ -z "$FULL_FILE" ]]; then
    echo "[!] Download failed — no output file found"
    exit 1
fi

echo "[*] Extracting ${DUR}s clip starting at ${START}s..."
ffmpeg -y -i "$FULL_FILE" -ss "$START" -t "$DUR" \
    -ac 1 -ar 24000 -acodec pcm_s16le \
    -af "highpass=f=80,lowpass=f=8000,loudnorm=I=-16:TP=-1.5:LRA=11" \
    "${VOICE_DIR}/reference.wav" 2>/dev/null

# Clean up
rm -f /tmp/ref_${ID}_full.* /tmp/ref_${ID}_raw.*

# Write metadata
cat > "${VOICE_DIR}/metadata.json" << METAEOF
{
  "name": "${NAME}",
  "gender": "${GENDER}",
  "group": "${GROUP}"
}
METAEOF

# Verify
DURATION=$(ffprobe -i "${VOICE_DIR}/reference.wav" -show_entries format=duration -v quiet -of csv="p=0" 2>/dev/null)
echo "[+] Done! Reference clip for '${NAME}': ${DURATION}s"
echo "    ${VOICE_DIR}/reference.wav"
