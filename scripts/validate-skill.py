#!/usr/bin/env python3
"""Minimal dependency-free validation for a Claude skill package."""

from pathlib import Path
import re
import sys


def fail(message: str) -> None:
    print(f"skill validation failed: {message}", file=sys.stderr)
    raise SystemExit(1)


root = Path(sys.argv[1] if len(sys.argv) > 1 else "share/claude/skills/computer-use")
skill = root / "SKILL.md"
if not skill.is_file():
    fail(f"missing {skill}")

text = skill.read_text(encoding="utf-8")
match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
if not match:
    fail("SKILL.md must begin with YAML frontmatter")

fields: dict[str, str] = {}
for line in match.group(1).splitlines():
    key, separator, value = line.partition(":")
    if not separator or not key.strip() or not value.strip():
        fail(f"invalid frontmatter line: {line!r}")
    fields[key.strip()] = value.strip()

if set(fields) != {"name", "description"}:
    fail("frontmatter must contain only name and description")
if not re.fullmatch(r"[a-z0-9-]{1,64}", fields["name"]):
    fail("name must be lowercase kebab-case and at most 64 characters")
if len(fields["description"]) > 1024:
    fail("description exceeds 1024 characters")

for link in re.findall(r"\[[^]]+\]\(([^)]+)\)", text):
    if "://" not in link and not (root / link.split("#", 1)[0]).is_file():
        fail(f"broken local reference: {link}")

print(f"skill validation passed: {fields['name']}")
