# Proxmox LXC Install Script

Install the Discord Soundboard as an LXC container on your Proxmox host, in the same style as [Proxmox VE Helper-Scripts](https://community-scripts.github.io/ProxmoxVE/).

## Prerequisites

- Proxmox VE host with a Debian 12 or Ubuntu 22.04/24.04 template.
- If you don't have one: **Datacenter → local (storage) → Templates** → “Templates” → download e.g. `debian-12-standard` or `ubuntu-22.04-standard`.

## One-line install (from Proxmox host)

Replace `YOUR_USER` with your GitHub username (or org). Use `main` or your default branch:

```bash
GIT_URL="https://github.com/YOUR_USER/discord-soundboard.git" bash -c "$(curl -fsSL https://raw.githubusercontent.com/YOUR_USER/discord-soundboard/main/proxmox/install-discord-soundboard.sh)"
```

With options (e.g. custom CTID or static IP):

```bash
GIT_URL="https://github.com/YOUR_USER/discord-soundboard.git" CTID=201 IP="192.168.1.201/24" GW="192.168.1.1" bash -c "$(curl -fsSL https://raw.githubusercontent.com/YOUR_USER/discord-soundboard/main/proxmox/install-discord-soundboard.sh)"
```

If the script creates a new container, set the root password and start it, then run the **same one-liner again** to finish the install:

```bash
pct set 200 --password 'YourRootPassword'
pct start 200
# then run the one-liner again
```

## One-line update

After you push changes to the repo, run (same URL, add `update` at the end):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/YOUR_USER/discord-soundboard/main/proxmox/install-discord-soundboard.sh)" update
```

---

## Manual / clone-based install

1. Copy `install-discord-soundboard.sh` to your Proxmox host (or clone your repo there).
2. Set your Git repo URL and run install:

   ```bash
   chmod +x install-discord-soundboard.sh
   export GIT_URL="https://github.com/YOUR_USER/discord-soundboard.git"
   ./install-discord-soundboard.sh install
   ```

3. If the script creates a new container, set root password and start the CT, then run the same command again (see above).
4. Open the Web UI at `http://<container-ip>:3000` and log in (admin/user passwords are set in `.env`).

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
| `GIT_URL`   | (from repo)          | Git clone URL          |
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

From the Proxmox host (one-liner):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/YOUR_USER/discord-soundboard/main/proxmox/install-discord-soundboard.sh)" update
```

Or if you have the script locally:

```bash
./install-discord-soundboard.sh update
```

Both run inside the container: `git pull`, `npm install`, and `systemctl restart discord-soundboard`.

## After install

- **Edit .env (token, passwords):**  
  `pct exec 200 -- nano /opt/discord-soundboard/.env`  
  Then: `systemctl restart discord-soundboard`

- **Logs:**  
  `pct exec 200 -- journalctl -u discord-soundboard -f`

- **Sounds:**  
  Upload via the Web UI, or copy files into the container (sounds live under `/opt/discord-soundboard/sounds`).
