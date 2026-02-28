# Proxmox LXC Install Script

Install the Discord Soundboard as an LXC container on your Proxmox host, in the same style as [Proxmox VE Helper-Scripts](https://community-scripts.github.io/ProxmoxVE/).

**Repo:** https://github.com/smartpbx/discord-soundboard

## Prerequisites

- Proxmox VE host with a Debian 12 or Ubuntu 22.04/24.04 template.
- If you don't have one: **Datacenter → local (storage) → Templates** → “Templates” → download e.g. `debian-12-standard` or `ubuntu-22.04-standard`.

## One-line install (from Proxmox host)

Default clone URL is already set to `https://github.com/smartpbx/discord-soundboard.git`:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/smartpbx/discord-soundboard/main/proxmox/install-discord-soundboard.sh)"
```

With options (e.g. custom CTID or static IP):

```bash
CTID=201 IP="192.168.1.201/24" GW="192.168.1.1" bash -c "$(curl -fsSL https://raw.githubusercontent.com/smartpbx/discord-soundboard/main/proxmox/install-discord-soundboard.sh)"
```

If the script creates a new container, set the root password and start it, then run the **same one-liner again** to finish the install:

```bash
pct set 200 --password 'YourRootPassword'
pct start 200
# then run the one-liner again
```

## One-line update (from host)

Pulls latest code and restarts the app. **Your `.env` and `sounds/` (files, folders, names, settings) are not touched.**

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/smartpbx/discord-soundboard/main/proxmox/install-discord-soundboard.sh)" update
```

Or with the script locally: `./install-discord-soundboard.sh update`

---

## Manual / clone-based install

1. Copy `install-discord-soundboard.sh` to your Proxmox host (or clone the repo there).
2. Run install (default GIT_URL is already `https://github.com/smartpbx/discord-soundboard.git`):

   ```bash
   chmod +x install-discord-soundboard.sh
   ./install-discord-soundboard.sh install
   ```

   Or override the repo: `export GIT_URL="https://github.com/you/discord-soundboard.git"`

3. If the script creates a new container, set root password and start the CT, then run the same command again (see above).
4. Edit `.env` with your Discord bot token and passwords (see below).
5. Open the Web UI at `http://<container-ip>:3000` and log in.

## Options

| Env var      | Default              | Description           |
|-------------|----------------------|------------------------|
| `CTID`      | 200                  | Container ID          |
| `HOSTNAME`  | discord-soundboard   | Container hostname    |
| `MEMORY`    | 512                  | RAM (MB)               |
| `CORES`     | 1                    | CPU cores              |
| `DISK`      | 8                    | Root disk (GB)         |
| `STORAGE`   | local-lvm            | Storage name           |
| `BRIDGE`    | vmbr0                | Bridge                 |
| `GIT_URL`   | https://github.com/smartpbx/discord-soundboard.git | Git clone URL |
| `IP`        | (DHCP)               | Optional static IP     |
| `GW`        | (none)               | Optional gateway       |

Example with custom CTID and static IP:

```bash
export GIT_URL="https://github.com/you/discord-soundboard.git"
export CTID=201
export IP="192.168.1.201/24"
export GW="192.168.1.1"
./install-discord-soundboard.sh install
```

## Update (after code changes)

Updates **code only**; `.env` and `sounds/` (your files, folders, names, settings) are kept.

**From the Proxmox host:**

```bash
./install-discord-soundboard.sh update
```

Or one-liner:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/smartpbx/discord-soundboard/main/proxmox/install-discord-soundboard.sh)" update
```

**From inside the LXC console** (after `pct enter 200` or via SSH into the container):

```bash
update
```

Or explicitly: `cd /opt/discord-soundboard && ./scripts/update.sh`

## Backup and restore

Full export/import of `.env`, `sounds/` (all audio files, `sounds.json` with names, folders, order).

**Backup (inside container):**

```bash
pct exec 200 -- bash -c 'cd /opt/discord-soundboard && ./scripts/backup.sh'
# Creates e.g. /opt/discord-soundboard/discord-soundboard-backup-20260227-123456.tar.gz
```

Copy backup off the container:

```bash
pct pull 200 /opt/discord-soundboard/discord-soundboard-backup-YYYYMMDD-HHMMSS.tar.gz ./
```

**Restore:** copy tarball into container, then restore:

```bash
pct push 200 ./discord-soundboard-backup-YYYYMMDD-HHMMSS.tar.gz /opt/discord-soundboard/
pct exec 200 -- bash -c 'cd /opt/discord-soundboard && ./scripts/restore.sh /opt/discord-soundboard/discord-soundboard-backup-YYYYMMDD-HHMMSS.tar.gz'
```

## After install

- **Edit .env (token, passwords):**  
  `pct exec 200 -- nano /opt/discord-soundboard/.env`  
  Set `DISCORD_TOKEN` (from [Discord Developer Portal](https://discord.com/developers/applications)), `ADMIN_PASSWORD`, `USER_PASSWORD`, and optionally `SESSION_SECRET`. Then: `pct exec 200 -- systemctl restart discord-soundboard`

- **Logs:**  
  `pct exec 200 -- journalctl -u discord-soundboard -f`

- **Sounds:**  
  Upload via the Web UI; files and metadata live under `/opt/discord-soundboard/sounds/`. Back them up with `./scripts/backup.sh` (see Backup and restore above).
