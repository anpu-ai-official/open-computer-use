#!/usr/bin/python3
import concurrent.futures
import json
import pathlib
import subprocess
import sys
import threading
import time
import urllib.request


sentinel_xid = int(sys.argv[1])
targets = []
for value in sys.argv[2:]:
    identifier, pid, xid = value.split(":")
    targets.append((identifier, int(pid), int(xid)))

counter = 0
counter_lock = threading.Lock()


def request(method, params):
    global counter
    with counter_lock:
        counter += 1
        request_id = counter
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}).encode()
    http_request = urllib.request.Request("http://127.0.0.1:17840/mcp", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(http_request, timeout=30) as response:
        message = json.load(response)
    if "error" in message:
        raise RuntimeError(message["error"])
    return message["result"]


def native(session, tool, arguments):
    result = request("tools/call", {"name": "native", "arguments": {"session": session, "tool": tool, "arguments": arguments}})
    if result.get("isError"):
        raise RuntimeError(result)
    return result.get("structuredContent")


def worker(target):
    identifier, pid, xid = target
    session = f"linux_parallel_{identifier}"
    payload = f"parallel-{identifier}"
    state = native(session, "get_window_state", {"pid": pid, "window_id": xid, "include_screenshot": False})
    entry = next(item for item in state["elements"] if item["label"] == "Payload entry")
    button = next(item for item in state["elements"] if item["label"] == "Commit payload")
    native(session, "type_text", {"element_token": entry["element_token"], "text": payload, "delivery_mode": "background"})
    native(session, "click", {"element_token": button["element_token"], "delivery_mode": "background"})
    output = pathlib.Path(f"/tmp/ocu-result-{identifier}.txt")
    for _ in range(100):
        if output.exists():
            break
        time.sleep(0.05)
    assert output.read_text(encoding="utf-8") == payload
    final_state = native(session, "get_window_state", {"pid": pid, "window_id": xid, "include_screenshot": False})
    assert f"committed:{payload}" in final_state["tree_markdown"]
    request("tools/call", {"name": "native_reset", "arguments": {"session": session}})
    return {"session": session, "pid": pid, "window_id": xid, "result": payload}


focus_before = int(subprocess.check_output(["xdotool", "getwindowfocus"], text=True).strip())
pointer_before = subprocess.check_output(["xdotool", "getmouselocation", "--shell"], text=True).strip()
assert focus_before == sentinel_xid
started = time.monotonic()
with concurrent.futures.ThreadPoolExecutor(max_workers=len(targets)) as pool:
    results = list(pool.map(worker, targets))
elapsed_ms = round((time.monotonic() - started) * 1000)
focus_after = int(subprocess.check_output(["xdotool", "getwindowfocus"], text=True).strip())
pointer_after = subprocess.check_output(["xdotool", "getmouselocation", "--shell"], text=True).strip()
assert focus_after == sentinel_xid
assert pointer_after == pointer_before

print(json.dumps({
    "passed": True,
    "parallel_sessions": len(results),
    "focus_unchanged": focus_before == focus_after,
    "pointer_unchanged": pointer_before == pointer_after,
    "elapsed_ms": elapsed_ms,
    "results": results,
}, indent=2, sort_keys=True))
