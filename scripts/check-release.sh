#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(tr -d '[:space:]' < "$root/VERSION")"

[ "$(uname -s)" = Darwin ] || { echo "release checks require macOS" >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "release checks require Apple silicon" >&2; exit 1; }
if ! git -C "$root" diff --quiet || ! git -C "$root" diff --cached --quiet; then
  echo "release checks require a clean worktree" >&2
  exit 1
fi
git -C "$root" rev-parse "v$version" >/dev/null 2>&1 && { echo "tag v$version already exists" >&2; exit 1; }
command -v shellcheck >/dev/null && shellcheck "$root/install.sh" "$root/bin/"* "$root/packaging/"*.sh "$root/scripts/"*.sh
echo "release preflight passed for v$version"
