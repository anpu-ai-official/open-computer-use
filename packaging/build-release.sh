#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${OCU_VERSION:-$(tr -d '[:space:]' < "$ROOT/VERSION")}"
OUTPUT_DIR="${OCU_OUTPUT_DIR:-$ROOT/dist}"
NODE_VERSION="${OCU_NODE_VERSION:-v22.23.2}"
DRIVER_SOURCE="${CUA_DRIVER_APP_SOURCE:-}"
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/open-computer-use-release.XXXXXX")"
trap 'rm -rf "$BUILD_ROOT"' EXIT

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "Builds require Apple-silicon macOS" >&2; exit 1; }
command -v curl >/dev/null
command -v npm >/dev/null
command -v shasum >/dev/null

stage="$BUILD_ROOT/open-computer-use-$VERSION"
mkdir -p "$stage/bin" "$stage/runtime" "$stage/libexec/node/bin" "$stage/libexec/driver" "$stage/share"
cp "$ROOT/VERSION" "$ROOT/LICENSE" "$ROOT/README.md" "$ROOT/TESTING.md" "$ROOT/THIRD_PARTY_NOTICES.md" \
  "$ROOT/CHANGELOG.md" "$ROOT/SECURITY.md" "$ROOT/SUPPORT.md" "$stage/"
cp -R "$ROOT/bin/." "$stage/bin/"
cp -R "$ROOT/runtime/." "$stage/runtime/"
cp -R "$ROOT/share/." "$stage/share/"
cp -R "$ROOT/docs" "$stage/docs"
find "$stage/runtime" -name '__pycache__' -type d -prune -exec rm -rf {} +
if [ -d "$stage/runtime/test" ]; then rm -rf "$stage/runtime/test"; fi

echo "Installing pinned production JavaScript dependencies…"
(cd "$stage/runtime" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts)

echo "Bundling official Node.js $NODE_VERSION arm64…"
node_index="$BUILD_ROOT/node-index"
node_archive="node-$NODE_VERSION-darwin-arm64.tar.gz"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$node_index"
grep -q " $node_archive$" "$node_index" || { echo "Node.js archive is not in the official checksum manifest" >&2; exit 1; }
curl -fL --retry 3 "https://nodejs.org/dist/$NODE_VERSION/$node_archive" -o "$BUILD_ROOT/$node_archive"
(cd "$BUILD_ROOT" && shasum -a 256 -c <(grep " $node_archive$" "$node_index"))
tar -xzf "$BUILD_ROOT/$node_archive" -C "$BUILD_ROOT"
cp "$BUILD_ROOT/${node_archive%.tar.gz}/bin/node" "$stage/libexec/node/bin/node"
cp "$BUILD_ROOT/${node_archive%.tar.gz}/LICENSE" "$stage/libexec/node/LICENSE"

if [ -z "$DRIVER_SOURCE" ]; then
  echo "Set CUA_DRIVER_APP_SOURCE to the patched CuaDriver app to include in this release." >&2
  echo "For public releases, build patches/cua-driver-existing-profile.patch at the pinned Cua commit, then Developer-ID sign and notarize it." >&2
  exit 1
fi
[ -d "$DRIVER_SOURCE" ] || { echo "Driver app not found: $DRIVER_SOURCE" >&2; exit 1; }
/usr/bin/ditto "$DRIVER_SOURCE" "$stage/libexec/driver/OpenComputerUseDriver.app"
/usr/bin/codesign --verify --deep --strict "$stage/libexec/driver/OpenComputerUseDriver.app"

chmod 755 "$stage/bin/open-computer-use" "$stage/bin/claude-cua-preview" "$stage/libexec/node/bin/node"
mkdir -p "$OUTPUT_DIR"
archive="$OUTPUT_DIR/open-computer-use-$VERSION-darwin-arm64.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$archive" -C "$BUILD_ROOT" "open-computer-use-$VERSION"
(cd "$OUTPUT_DIR" && shasum -a 256 "$(basename "$archive")" > "$(basename "$archive").sha256")
echo "Built $archive"
echo "Node $NODE_VERSION; archive SHA-256 $(awk '{print $1}' "$archive.sha256")"
