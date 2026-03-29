#!/usr/bin/env python3
"""
Discord Soundboard — Global Hotkey Companion
Sends hotkey presses to the soundboard API even when the browser is not focused.

Setup:
  pip install keyboard requests
  Copy companion/hotkeys.example.env to companion/.env and fill in values.

Usage:
  python companion/hotkeys.py
"""

import os
import sys
import time
import threading
import requests

# --- Config (from environment or .env file) ---
def load_env(path):
    if not os.path.exists(path): return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line: continue
            k, _, v = line.partition('=')
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env(os.path.join(os.path.dirname(__file__), '.env'))

API_URL    = os.environ.get('SOUNDBOARD_URL', 'http://localhost:3000').rstrip('/')
TOKEN      = os.environ.get('COMPANION_TOKEN', '')
STOP_KEY   = os.environ.get('STOP_KEY', 's')
PAUSE_KEY  = os.environ.get('PAUSE_KEY', 'space')
FAVE_KEYS  = os.environ.get('FAVE_KEYS', '1,2,3,4,5,6,7,8,9').split(',')

if not TOKEN:
    print('ERROR: COMPANION_TOKEN not set. Copy companion/hotkeys.example.env → companion/.env and set it.')
    sys.exit(1)

HEADERS = {'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'}

def call(method, path, **kwargs):
    try:
        r = requests.request(method, API_URL + path, headers=HEADERS, timeout=5, **kwargs)
        return r
    except Exception as e:
        print(f'[hotkeys] request error: {e}')
        return None

def play_favorite(slot):
    r = call('GET', '/api/playback-state')
    if not r or not r.ok: return
    state = r.json()
    favs = state.get('favorites') or []
    # Favorites aren't in playback-state — fetch sounds and get from localStorage equivalent
    # Instead call the dedicated favorites endpoint
    r2 = call('GET', '/api/sounds')
    if not r2 or not r2.ok: return
    # We can't easily read localStorage from Python, so expose favorites via a new endpoint
    # For now: just trigger play for a configured sound by slot
    print(f'[hotkeys] slot {slot} — favorites require the /api/favorites endpoint (see README)')

def on_stop():
    print('[hotkeys] stop')
    call('POST', '/api/stop')

def on_pause():
    r = call('GET', '/api/playback-state')
    if not r or not r.ok: return
    status = r.json().get('status')
    if status == 'playing':
        print('[hotkeys] pause')
        call('POST', '/api/pause')
    elif status == 'paused':
        print('[hotkeys] resume')
        call('POST', '/api/resume')

def main():
    try:
        import keyboard
    except ImportError:
        print('ERROR: keyboard library not installed. Run: pip install keyboard')
        sys.exit(1)

    print(f'[hotkeys] Connected to {API_URL}')
    print(f'[hotkeys] Stop: {STOP_KEY} | Pause/Resume: {PAUSE_KEY}')
    print('[hotkeys] Listening for global hotkeys... (Ctrl+C to quit)')

    keyboard.add_hotkey(STOP_KEY, on_stop)
    keyboard.add_hotkey(PAUSE_KEY, on_pause)

    keyboard.wait()

if __name__ == '__main__':
    main()
