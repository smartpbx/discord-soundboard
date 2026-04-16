#!/usr/bin/env bash
# Download an RVC voice model from Hugging Face and register it in the manifest.
#
# Usage:
#   ./download-rvc-model.sh <id> <name> <pth_url> [index_url] [gender] [group]
#
# Examples:
#   ./download-rvc-model.sh trump "Donald Trump" \
#     "https://huggingface.co/binant/Donald_Trump__RVC_v2_/resolve/main/model.pth" \
#     "https://huggingface.co/binant/Donald_Trump__RVC_v2_/resolve/main/model.index" \
#     male Celebrity
#
#   ./download-rvc-model.sh biden "Joe Biden" \
#     "" "" male Celebrity \
#     --zip "https://huggingface.co/0x3e9/Biden_RVC/resolve/main/biden.zip"
#
# Pre-configured voices (just pass the name):
#   ./download-rvc-model.sh trump
#   ./download-rvc-model.sh biden

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODELS_DIR="${SCRIPT_DIR}/../models/rvc"
MANIFEST="${MODELS_DIR}/manifest.json"
mkdir -p "$MODELS_DIR"

# Initialize manifest if it doesn't exist
if [[ ! -f "$MANIFEST" ]]; then
    echo "[]" > "$MANIFEST"
fi

# --- Pre-configured voices ---
declare -A PRESETS_NAME PRESETS_PTH PRESETS_INDEX PRESETS_GENDER PRESETS_GROUP

PRESETS_NAME[trump]="Donald Trump"
PRESETS_PTH[trump]="https://huggingface.co/binant/Donald_Trump__RVC_v2_/resolve/main/model.pth"
PRESETS_INDEX[trump]="https://huggingface.co/binant/Donald_Trump__RVC_v2_/resolve/main/model.index"
PRESETS_GENDER[trump]="male"
PRESETS_GROUP[trump]="Celebrity"

PRESETS_NAME[biden]="Joe Biden"
PRESETS_PTH[biden]="https://huggingface.co/0x3e9/Biden_RVC/resolve/main/biden.zip"
PRESETS_INDEX[biden]=""
PRESETS_GENDER[biden]="male"
PRESETS_GROUP[biden]="Celebrity"

# --- Parse args ---
ID="${1:-}"
if [[ -z "$ID" ]]; then
    echo "Usage: $0 <id> [name] [pth_url] [index_url] [gender] [group]"
    echo ""
    echo "Pre-configured voices:"
    for key in "${!PRESETS_NAME[@]}"; do
        echo "  $0 $key"
    done
    exit 1
fi

# Check if it's a preset
if [[ -n "${PRESETS_NAME[$ID]:-}" && -z "${2:-}" ]]; then
    NAME="${PRESETS_NAME[$ID]}"
    PTH_URL="${PRESETS_PTH[$ID]}"
    INDEX_URL="${PRESETS_INDEX[$ID]}"
    GENDER="${PRESETS_GENDER[$ID]}"
    GROUP="${PRESETS_GROUP[$ID]}"
    echo "[*] Using preset: ${NAME}"
else
    NAME="${2:-$ID}"
    PTH_URL="${3:-}"
    INDEX_URL="${4:-}"
    GENDER="${5:-unknown}"
    GROUP="${6:-Celebrity}"
fi

if [[ -z "$PTH_URL" ]]; then
    echo "[!] No download URL provided and '$ID' is not a preset."
    exit 1
fi

MODEL_DIR="${MODELS_DIR}/${ID}"
mkdir -p "$MODEL_DIR"

# Download
if [[ "$PTH_URL" == *.zip ]]; then
    echo "[*] Downloading zip for ${NAME}..."
    curl -fSL "$PTH_URL" -o "${MODEL_DIR}/model.zip"
    echo "[*] Extracting..."
    # Ensure unzip is available
    if ! command -v unzip &>/dev/null; then
        echo "[*] Installing unzip..."
        apt-get install -y unzip 2>/dev/null || { echo "[!] Failed to install unzip. Run: apt-get install -y unzip"; exit 1; }
    fi
    cd "$MODEL_DIR"
    unzip -o model.zip
    rm -f model.zip
    # Find .pth and .index files
    PTH_FILE=$(find . -name "*.pth" -type f | head -1)
    INDEX_FILE=$(find . -name "*.index" -type f | head -1)
    if [[ -z "$PTH_FILE" ]]; then
        echo "[!] No .pth file found in zip!"
        exit 1
    fi
    # Move to standard names
    mv "$PTH_FILE" model.pth
    [[ -n "$INDEX_FILE" ]] && mv "$INDEX_FILE" model.index
    # Clean up any extra files
    find . -not -name "model.pth" -not -name "model.index" -not -name "." -delete 2>/dev/null || true
    cd - > /dev/null
    echo "[+] Extracted: model.pth" $([ -f "${MODEL_DIR}/model.index" ] && echo "+ model.index")
else
    echo "[*] Downloading model for ${NAME}..."
    curl -fSL "$PTH_URL" -o "${MODEL_DIR}/model.pth"
    if [[ -n "$INDEX_URL" ]]; then
        echo "[*] Downloading index..."
        curl -fSL "$INDEX_URL" -o "${MODEL_DIR}/model.index"
    fi
fi

# Update manifest
PTH_REL="${ID}/model.pth"
INDEX_REL=""
[[ -f "${MODEL_DIR}/model.index" ]] && INDEX_REL="${ID}/model.index"

# Remove existing entry for this ID if any, then add
python3 -c "
import json, sys
manifest = json.load(open('${MANIFEST}'))
manifest = [e for e in manifest if e.get('id') != '${ID}']
manifest.append({
    'id': '${ID}',
    'name': '${NAME}',
    'pth': '${PTH_REL}',
    'index': '${INDEX_REL}' or None,
    'gender': '${GENDER}',
    'group': '${GROUP}'
})
json.dump(manifest, open('${MANIFEST}', 'w'), indent=2)
print(f'[+] Registered {len(manifest)} voice(s) in manifest')
"

echo "[+] Done! Voice '${NAME}' (${ID}) is ready."
echo "    Restart the TTS service to pick it up: systemctl restart tts-server"
