#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:99
export NO_AT_BRIDGE=0
export GTK_MODULES=gail:atk-bridge
export XDG_SESSION_TYPE=x11

cleanup() { jobs -pr | xargs -r kill 2>/dev/null || true; }
trap cleanup EXIT

Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac -noreset -nolisten tcp >/tmp/xvfb.log 2>&1 &
for _ in $(seq 1 100); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 0.05; done
openbox >/tmp/openbox.log 2>&1 &
picom --backend xrender --config /dev/null >/tmp/picom.log 2>&1 &

cua-driver telemetry disable >/dev/null
cua-driver serve --socket /tmp/cua-driver.sock \
  --permission-mode unrestricted --dangerously-bypass-approvals --no-overlay >/tmp/cua-driver.log 2>&1 &
for _ in $(seq 1 100); do [[ -S /tmp/cua-driver.sock ]] && break; sleep 0.05; done
test -S /tmp/cua-driver.sock

CLAUDE_CUA_DRIVER=/usr/local/bin/cua-driver \
CLAUDE_CUA_DRIVER_SOCKET=/tmp/cua-driver.sock \
CLAUDE_CUA_BROWSER_MODE=headless \
node /opt/ocu-runtime/http-server.mjs >/tmp/ocu-http.log 2>&1 &
for _ in $(seq 1 100); do
  curl -fsS -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
    http://127.0.0.1:17840/mcp >/dev/null 2>&1 && break
  sleep 0.05
done

/usr/bin/python3 /opt/ocu-test/gtk_fixture.py target >/tmp/target.log 2>&1 &
/usr/bin/python3 /opt/ocu-test/gtk_fixture.py sentinel >/tmp/sentinel.log 2>&1 &
for _ in $(seq 1 100); do
  target_xid="$(xdotool search --name '^OCU Linux Target$' 2>/dev/null | head -1 || true)"
  sentinel_xid="$(xdotool search --name '^OCU Focus Sentinel$' 2>/dev/null | head -1 || true)"
  [[ -n "$target_xid" && -n "$sentinel_xid" ]] && break
  sleep 0.05
done
test -n "${target_xid:-}"
test -n "${sentinel_xid:-}"
xdotool windowactivate --sync "$sentinel_xid"
target_pid="$(xdotool getwindowpid "$target_xid")"

echo "Linux $(uname -m); $(cua-driver --version); $(google-chrome --version)"
/usr/bin/python3 /opt/ocu-test/native_http_test.py "$target_pid" "$target_xid" "$sentinel_xid"

parallel_targets=()
for identifier in a b c d; do
  /usr/bin/python3 /opt/ocu-test/gtk_fixture.py target "$identifier" >"/tmp/target-$identifier.log" 2>&1 &
done
for identifier in a b c d; do
  for _ in $(seq 1 100); do
    xid="$(xdotool search --name "^OCU Linux Target $identifier$" 2>/dev/null | head -1 || true)"
    [[ -n "$xid" ]] && break
    sleep 0.05
  done
  test -n "${xid:-}"
  parallel_targets+=("$identifier:$(xdotool getwindowpid "$xid"):$xid")
done
xdotool windowactivate --sync "$sentinel_xid"
/usr/bin/python3 /opt/ocu-test/native_parallel_test.py "$sentinel_xid" "${parallel_targets[@]}"

export CLAUDE_CUA_BROWSER_MODE=headless
export CLAUDE_CUA_CHROME_PATH=/usr/local/bin/ocu-test-chrome
export CLAUDE_CUA_BROWSER_PROFILE=/tmp/ocu-linux-browser-profile
cd /opt/ocu-runtime
node test/smoke.mjs
node test/devtools.mjs
node test/resilience.mjs
