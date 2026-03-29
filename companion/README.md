# Soundboard Global Hotkey Companion

Control the soundboard with keyboard shortcuts even when the browser is not focused. Works on **Windows** and **Linux**.

## Quick Start

### Windows

1. Install [Python](https://www.python.org/downloads/) — **check "Add Python to PATH"** during install
2. Double-click `setup.bat` — it installs packages and asks for your soundboard URL + token
3. Double-click `start.bat` to run

> If hotkeys don't work, right-click `start.bat` → **Run as administrator**

### Linux

1. Open a terminal in the `companion/` folder
2. Run `./setup.sh` — it installs packages, adds you to the `input` group, and asks for config
3. Log out and back in (one-time, for the input group)
4. Run `./start.sh`

## Server Setup (one-time)

The companion authenticates with a token. Set it on your LXC:

1. SSH/enter your LXC
2. Edit `/opt/discord-soundboard/.env` and add:
   ```
   COMPANION_TOKEN=pick_a_strong_random_string
   ```
3. Run `update` to restart the service
4. Use this same token when `setup.bat` or `setup.sh` asks for it

## Default Keys

| Key | Action |
|-----|--------|
| `S` | Stop playback |
| `Space` | Pause / Resume |

Edit the `.env` file to change key bindings (uses [keyboard library key names](https://github.com/boppreh/keyboard#key-names)).

## Autostart

**Windows:** Add `start.bat` to your Startup folder (`Win+R` → `shell:startup`), or create a Task Scheduler entry.

**Linux (Hyprland/Sway):** Add to your config:
```
exec-once = /path/to/companion/start.sh
```

**Linux (systemd):** Create `~/.config/systemd/user/soundboard-companion.service`:
```ini
[Unit]
Description=Soundboard Companion

[Service]
ExecStart=/path/to/companion/start.sh
Restart=on-failure

[Install]
WantedBy=default.target
```
Then: `systemctl --user enable --now soundboard-companion`
