#!/bin/sh
# Install login banner for Discord Soundboard LXC (OS, hostname, IP, Web UI).
# Safe to run multiple times. Used by Proxmox install script and update.
set -e
cat > /etc/update-motd.d/99-discord-soundboard << 'MOTD'
#!/bin/sh
printf "\033[1;37mDiscord Soundboard LXC Container\033[0m\n"
printf "\033[1;33mProvided by:\033[0m smartpbx \033[1;33m|\033[0m \033[1;32mGitHub:\033[0m https://github.com/smartpbx/discord-soundboard\n"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    printf "\033[1;32mOS:\033[0m %s – Version: %s\n" "${NAME:-Linux}" "${VERSION_ID:-unknown}"
fi
printf "\033[1;33mHostname:\033[0m %s\n" "$(hostname)"
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$ip" ] && printf "\033[1;33mIP Address:\033[0m %s\n" "$ip"
printf "\033[1;33mWeb UI:\033[0m http://%s:3000\n" "${ip:-<container-ip>}"
MOTD
chmod +x /etc/update-motd.d/99-discord-soundboard
