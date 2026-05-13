#!/usr/bin/env bash
# Reload the YouTube tab in the persistent Chromium so Google sees periodic
# real-browser activity and our session cookies stay valid. Talks to Chromium
# via DevTools Protocol — no xdotool dependency, no focus assumptions.
set -euo pipefail

CDP_HOST=127.0.0.1
CDP_PORT=9222

# List open tabs; pick one whose URL is on youtube.com (fall back to the
# first tab if none match), then send Page.reload via the inspector WS.
tabs_json="$(curl -fsS "http://${CDP_HOST}:${CDP_PORT}/json" 2>/dev/null || true)"
if [ -z "$tabs_json" ]; then
    echo "[keepwarm] Chromium CDP not reachable on ${CDP_HOST}:${CDP_PORT}" >&2
    exit 1
fi

target_ws="$(printf '%s' "$tabs_json" | python3 - <<'PY'
import json, sys
tabs = json.load(sys.stdin)
yt = [t for t in tabs if t.get("type") == "page" and "youtube.com" in (t.get("url") or "")]
pick = yt[0] if yt else (tabs[0] if tabs else None)
if pick:
    print(pick.get("webSocketDebuggerUrl", ""))
PY
)"

if [ -z "$target_ws" ]; then
    echo "[keepwarm] no eligible Chromium tab to reload" >&2
    exit 1
fi

# Drive the inspector WS with a 5-line Python script so we don't need
# extra Node deps. Navigate to https://www.youtube.com if the current
# page isn't on youtube.com; otherwise just Page.reload.
python3 - "$target_ws" <<'PY'
import json, sys, urllib.request, websocket
ws_url = sys.argv[1]
ws = websocket.create_connection(ws_url, timeout=10)
def send(method, params=None, _id=[0]):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    # Drain until we see the matching id
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id[0]:
            return msg
send("Page.enable")
tinfo = send("Page.getNavigationHistory")
cur = (tinfo.get("result") or {}).get("entries", [])
idx = (tinfo.get("result") or {}).get("currentIndex", 0)
cur_url = cur[idx]["url"] if cur and 0 <= idx < len(cur) else ""
if "youtube.com" not in cur_url:
    send("Page.navigate", {"url": "https://www.youtube.com"})
else:
    send("Page.reload", {"ignoreCache": False})
ws.close()
PY

echo "[keepwarm] reloaded YouTube tab via CDP"
