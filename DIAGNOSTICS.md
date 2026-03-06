# Audio Playback Diagnostics

When the bot doesn't produce audio (UI shows playback but Discord doesn't light up), run the server and capture logs while reproducing. Look for `[DIAG]` lines.

## Voice never reaches `ready` (LXC/Docker/firewall)

If `voice.stateChange` cycles `signalling -> connecting -> signalling` and never reaches `ready`, the voice connection cannot establish. This is almost always a **network** issue:

- **Discord voice requires UDP** outbound to Discord's voice servers
- LXC containers, Docker, and firewalls often block or restrict UDP
- **Fix**: Allow UDP outbound from the host/container, or run the bot on a host with direct internet access

## What to capture

1. **Join a voice channel** – you should see:
   ```
   [DIAG] voice.join channelId=... guildId=... connectionState=...
   [DIAG] voice.stateChange connecting -> ready
   ```

2. **Play a sound** – you should see:
   ```
   [DIAG] play.start filename=... effectiveVolume=... playerStatusBefore=... voiceConnectionStatus=...
   [DIAG] player.stateChange idle -> buffering
   [DIAG] player.stateChange buffering -> playing
   ... (when done) ...
   [DIAG] player.stateChange playing -> idle
   ```

## What to check

| Observation | Likely cause |
|-------------|--------------|
| `player.stateChange` never reaches `playing` | Player stuck in buffering or goes straight to idle – stream/decoding issue |
| `player.stateChange playing -> idle` almost immediately | Stream ends right away – file/ffmpeg issue |
| `[DIAG] player.error` appears | Audio player error – check the error message |
| `[DIAG] ffmpeg.error` or `ffmpeg.close code=1` | ffmpeg failing – file format or path issue |
| `[DIAG] voice.connectionError` | Voice connection broken – Discord/network |
| `voiceConnectionStatus` not `ready` when play.start | Connection not ready yet – play handler now waits for ready (or returns 503) |
| `voice.stateChange` never reaches `ready` | **Voice connection stuck** – almost always a **network/firewall** issue. Discord voice needs UDP outbound. In LXC/Docker/behind NAT, ensure UDP is allowed. |
| No `[DIAG]` lines at all | Logs not reaching stdout – check how you run the server |

## Networking codes (networkingCode in stateChange)

When `voice.stateChange` fires, `networkingCode` shows the internal state: `0`=OpeningWs, `1`=Identifying, `2`=UdpHandshaking, `3`=SelectingProtocol, `4`=Ready, `5`=Resuming, `6`=Closed. If it gets stuck at 2, UDP handshake may be failing.

## How to capture

- **systemd**: `journalctl -u <service> -f` or `journalctl -u <service> -n 200`
- **pm2**: `pm2 logs`
- **direct**: `node server.js 2>&1 | tee diag.log`
