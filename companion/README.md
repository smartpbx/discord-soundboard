# Soundboard Global Hotkey Companion

Lets you control the soundboard with global keyboard shortcuts even when the browser is not focused. Works on Linux and Windows.

## Setup

1. Install Python 3 and pip
2. Install dependencies:
   ```
   pip install keyboard requests
   ```
3. Copy the example config:
   ```
   cp companion/hotkeys.example.env companion/.env
   ```
4. Edit `companion/.env`:
   - Set `SOUNDBOARD_URL` to your soundboard address (local IP or Cloudflare tunnel URL)
   - Set `COMPANION_TOKEN` to a strong random string (same value you set in the LXC `.env`)
5. In your LXC `.env`, add:
   ```
   COMPANION_TOKEN=same_value_as_above
   ```
   Then run `update` in the LXC to restart the service.
6. Run the companion:
   ```
   python companion/hotkeys.py
   ```

## Linux notes
- On Linux, `keyboard` requires root or the user to be in the `input` group:
  ```
  sudo python companion/hotkeys.py
  # or
  sudo usermod -aG input $USER  # then log out and back in
  ```
- On Hyprland/Arch, you can add it as a startup command in `hyprland.conf`:
  ```
  exec-once = sudo python /path/to/companion/hotkeys.py
  ```

## Windows notes
- Run the script as Administrator for global hotkey support.
- Or add it to Task Scheduler to run at login with elevated privileges.

## Keys
| Key | Action |
|-----|--------|
| `S` | Stop playback |
| `Space` | Pause / Resume |

Favorites (1–9) require exposing favorites via the API — planned for a future update.
