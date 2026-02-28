# Proxmox LXC Install Script

Install the Discord Soundboard as an LXC container on your Proxmox host in **one run**.

**Repo:** https://github.com/smartpbx/discord-soundboard

**Standalone:** This installer does **not** use or depend on [community-scripts/ProxmoxVE](https://github.com/community-scripts/ProxmoxVE). All logic lives in this repo: a **host script** (`install-discord-soundboard.sh`) and a **container-side script** (`install/discord-soundboard-install.sh`) that runs inside the LXC.

## Prerequisites

- Proxmox VE host with a Debian 12 or Ubuntu 22.04/24.04 template.
- If you don't have one: **Datacenter → local (storage) → CT Templates** → “Templates” → download e.g. `debian-12-standard` or `ubuntu-24.04-standard`.

## One-line install (single run)

Run once; the script creates the container, sets a root password, starts it, and installs the app. **No need to start the LXC or run the script again.**

Uses the **next free container ID** (from `pvesh get /cluster/nextid` or 100, 101, …) unless you set `CTID`:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/smartpbx/discord-soundboard/main/proxmox/install-discord-soundboard.sh)"
```

At the end you get the Web UI URL, root password for the new CT, and update/backup commands.

With options (e.g. fixed CTID or static IP):

```bash
CTID=201 IP="192.168.1.201/24" GW="192.168.1.1" bash -c "$(curl -fsSL https://raw.githubusercontent.com/smartpbx/discord-soundboard/main/proxmox/install-discord-soundboard.sh)"
```

## One-line update (from host)

Pulls latest code and restarts the app. **Your `.env` and `sounds/` are not touched.** Requires `CTID` (the script does not remember which CT you used):

```bash
CTID=200 bash -c "$(curl -fsSL https://raw.githubusercontent.com/smartpbx/discord-soundboard/main/proxmox/install-discord-soundboard.sh)" update
```

Or with the script locally: `CTID=200 ./install-discord-soundboard.sh update`

---

## Manual / clone-based install

1. Copy `install-discord-soundboard.sh` to your Proxmox host (or clone the repo there).
2. Run install once (default GIT_URL is `https://github.com/smartpbx/discord-soundboard.git`):

   ```bash
   chmod +x install-discord-soundboard.sh
   ./install-discord-soundboard.sh
   ```

   The script will use the next free container ID, create the CT, set a random root password, start it, and install the app. At the end it prints the Web UI URL and root password.

   To force a specific CTID or static IP: `CTID=200 IP="192.168.1.200/24" GW="192.168.1.1" ./install-discord-soundboard.sh`

3. Edit `.env` with your Discord bot token and passwords (see After install).
4. Open the Web UI at the printed URL (e.g. `http://<container-ip>:3000`) and log in.

## Options

| Env var      | Default              | Description           |
|-------------|----------------------|------------------------|
| `CTID`      | next free ID         | Container ID (optional; script uses pvesh /cluster/nextid or 100+) |
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

**From the Proxmox host** (set CTID to your container):

```bash
CTID=200 ./install-discord-soundboard.sh update
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

## Troubleshooting

**"No IP on eth0" / eth0 DOWN / DNS fails:** The container needs `ip=dhcp` (or static IP) in its network config. If you're resuming a failed install on an existing container that was created before this fix, destroy it and run the installer again:

```bash
pct stop 109
pct destroy 109
# Then re-run the install script
```

**DHCP not working:** Ensure your bridge (default `vmbr0`) has access to a DHCP server. For static IP: `IP="192.168.1.200/24" GW="192.168.1.1" ./install-discord-soundboard.sh`
