# Soundboard Global Hotkey Companion

A small desktop app that lets you control the soundboard with keyboard shortcuts even when the browser is not focused. Works on **Windows** and **Linux**.

## Quick Start

### Windows

1. Install [Python](https://www.python.org/downloads/) — **check "Add Python to PATH"** during install
2. Double-click `setup.bat` — installs the required packages
3. Double-click `start.bat` — opens the companion app

> If hotkeys don't respond, right-click `start.bat` → **Run as administrator**

### Linux

1. Run `./setup.sh` — installs packages and adds you to the `input` group
2. Log out and back in (one-time, for the input group)
3. Run `./start.sh`

## Using the App

When you launch the companion, a window opens with:

- **Connection** — Enter your soundboard URL and companion token, then click "Test Connection" to verify
- **Hotkeys** — Click "Set" next to any action, then press the key you want to bind. Default: `S` = Stop, `Space` = Pause/Resume
- **Enable/Disable** — Toggle hotkeys on/off with the checkbox (no need to close the app)
- **Save** — Saves your settings so they persist between sessions

Settings are stored in `companion/config.json`.

## Server Setup (one-time)

1. SSH/enter your LXC
2. Edit `/opt/discord-soundboard/.env` and add:
   ```
   COMPANION_TOKEN=pick_a_strong_random_string
   ```
3. Run `update` to restart the service
4. Use this same token in the companion app's "Companion Token" field

## Default Keys

| Key | Action |
|-----|--------|
| `S` | Stop playback |
| `Space` | Pause / Resume |

Click "Set" in the app to change any binding to whatever key you prefer.

## Autostart

**Windows:** Add `start.bat` to your Startup folder (`Win+R` → `shell:startup`).

**Linux (Hyprland/Sway):**
```
exec-once = /path/to/companion/start.sh
```
