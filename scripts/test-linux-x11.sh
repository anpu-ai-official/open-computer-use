#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${OCU_LINUX_TEST_IMAGE:-open-computer-use-linux-x11:test}"
BUILD_ARGS=()
HOST_CA_BUNDLE=""
if [ "$(uname -s)" = Darwin ]; then
  HOST_CA_BUNDLE="$(mktemp "${TMPDIR:-/tmp}/ocu-host-ca.XXXXXX")"
  trap 'rm -f "$HOST_CA_BUNDLE"' EXIT
  security find-certificate -a -p /Library/Keychains/System.keychain > "$HOST_CA_BUNDLE" 2>/dev/null || true
  security find-certificate -a -p "$HOME/Library/Keychains/login.keychain-db" >> "$HOST_CA_BUNDLE" 2>/dev/null || true
  BUILD_ARGS+=(--secret "id=ca,src=$HOST_CA_BUNDLE")
fi

docker build --platform "linux/${OCU_LINUX_ARCH:-arm64}" \
  "${BUILD_ARGS[@]}" \
  -f "$ROOT/tests/platform/linux-x11/Dockerfile" \
  -t "$IMAGE" "$ROOT"
docker run --rm --shm-size=1g --platform "linux/${OCU_LINUX_ARCH:-arm64}" "$IMAGE"
