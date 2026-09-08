#!/usr/bin/python3
import json
import pathlib
import platform
import subprocess
import sys
import time
import urllib.request


target_pid, target_xid, sentinel_xid = map(int, sys.argv[1:4])
next_id = 0


def request(method, params):
    global next_id
    next_id += 1
    body = json.dumps({"jsonrpc": "2.0", "id": next_id, "method": method, "params": params}).encode()
    http_request = urllib.request.Request("http://127.0.0.1:17840/mcp", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(http_request, timeout=30) as response:
        message = json.load(response)
    if "error" in message:
        raise RuntimeError(message["error"])
    return message["result"]


def native(tool, arguments):
    result = request("tools/call", {
        "name": "native",
        "arguments": {"session": "linux_native_e2e", "tool": tool, "arguments": arguments},
    })
    if result.get("isError"):
        raise RuntimeError(result)
    return result.get("structuredContent")


def xdotool(*args):
    return subprocess.check_output(["xdotool", *args], text=True).strip()


request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "linux-native-e2e", "version": "1"}})
state = native("get_window_state", {"pid": target_pid, "window_id": target_xid, "include_screenshot": True})
entry = next(item for item in state["elements"] if item["label"] == "Payload entry")
button = next(item for item in state["elements"] if item["label"] == "Commit payload")
focus_before = int(xdotool("getwindowfocus"))
pointer_before = xdotool("getmouselocation", "--shell")
assert focus_before == sentinel_xid

typed = native("type_text", {"element_token": entry["element_token"], "text": "linux-background-parity", "delivery_mode": "background"})
clicked = native("click", {"element_token": button["element_token"], "delivery_mode": "background"})
result_file = pathlib.Path("/tmp/ocu-result.txt")
for _ in range(100):
    if result_file.exists():
        break
    time.sleep(0.05)
assert result_file.read_text(encoding="utf-8") == "linux-background-parity"

focus_after = int(xdotool("getwindowfocus"))
pointer_after = xdotool("getmouselocation", "--shell")
assert focus_after == sentinel_xid
assert pointer_after == pointer_before
final_state = native("get_window_state", {"pid": target_pid, "window_id": target_xid, "include_screenshot": False})
assert "committed:linux-background-parity" in final_state["tree_markdown"]
request("tools/call", {"name": "native_reset", "arguments": {"session": "linux_native_e2e"}})

print(json.dumps({
    "passed": True,
    "platform": "linux",
    "arch": platform.machine(),
    "display": "x11",
    "focus_unchanged": focus_before == focus_after,
    "pointer_unchanged": pointer_before == pointer_after,
    "token_bridge": True,
    "type_route": typed.get("route"),
    "click_route": clicked.get("route"),
    "postcondition": result_file.read_text(encoding="utf-8"),
}, indent=2, sort_keys=True))
