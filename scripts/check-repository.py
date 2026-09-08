#!/usr/bin/env python3
"""Fast repository invariants used locally and in CI."""

from pathlib import Path
import re
import subprocess
import sys


root = Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    print(f"repository check failed: {message}", file=sys.stderr)
    raise SystemExit(1)


tracked = subprocess.run(
    ["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True
).stdout.decode().split("\0")
tracked = [item for item in tracked if item]
if any(item.startswith("dist/") or "/node_modules/" in item for item in tracked):
    fail("generated release or node_modules content is tracked")

text_extensions = {"", ".md", ".mjs", ".js", ".json", ".sh", ".py", ".in", ".yml", ".yaml", ".plist"}
for relative in tracked:
    path = root / relative
    if not path.is_file() or path.suffix not in text_extensions:
        continue
    text = path.read_text(encoding="utf-8", errors="ignore")
    machine_path = "/" + "Users" + "/" + "user" + "/"
    placeholder = "YOUR" + "_GITHUB_USER"
    if machine_path in text:
        fail(f"machine-specific path in {relative}")
    if placeholder in text:
        fail(f"unresolved repository placeholder in {relative}")

readme = (root / "README.md").read_text(encoding="utf-8")
for target in re.findall(r"\[[^]]+\]\(([^)]+)\)", readme):
    if target.startswith(("http://", "https://", "#")):
        continue
    local = target.split("#", 1)[0]
    if local and not (root / local).exists():
        fail(f"broken README link: {target}")

versions = {
    (root / "VERSION").read_text().strip(),
    re.search(r'^VERSION="([^"]+)"', (root / "bin/open-computer-use").read_text(), re.MULTILINE).group(1),
    __import__("json").loads((root / "runtime/package.json").read_text())["version"],
}
if len(versions) != 1:
    fail(f"version mismatch: {sorted(versions)}")

print(f"repository checks passed ({len(tracked)} tracked files)")
