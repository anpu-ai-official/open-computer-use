#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${OCU_VERSION:-$(tr -d '[:space:]' < "$ROOT/VERSION")}"
COMMIT="${CUA_DRIVER_COMMIT:-b11709305}"
OUTPUT="${CUA_DRIVER_OUTPUT:-$ROOT/dist/OpenComputerUseDriver.app}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/open-computer-use-driver.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

git clone --filter=blob:none https://github.com/trycua/cua.git "$WORK/cua"
git -C "$WORK/cua" checkout "$COMMIT"
git -C "$WORK/cua" apply "$ROOT/patches/cua-driver-existing-profile.patch"
(cd "$WORK/cua/libs/cua-driver/rust" && cargo build -p cua-driver -p cursor-theme-cli --release)

app="$WORK/OpenComputerUseDriver.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$WORK/cua/libs/cua-driver/rust/target/release/cua-driver" "$app/Contents/MacOS/cua-driver"
cursor_helper="$WORK/cua/libs/cua-driver/rust/target/release/cua-cursor-theme"
[ -x "$cursor_helper" ] || { echo "Expected cursor helper was not produced: $cursor_helper" >&2; exit 1; }
cp "$cursor_helper" "$app/Contents/MacOS/cua-cursor-theme"
cp "$ROOT/packaging/Info.plist" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$app/Contents/Info.plist"
icon="${CUA_DRIVER_ICON:-$ROOT/packaging/AppIcon.icns}"
if [ -f "$icon" ]; then cp "$icon" "$app/Contents/Resources/AppIcon.icns"; fi

identity="${APPLE_CODESIGN_IDENTITY:--}"
codesign --force --deep --options runtime --entitlements "$ROOT/packaging/CuaDriver.entitlements" --sign "$identity" "$app"
codesign --verify --deep --strict "$app"
mkdir -p "$(dirname "$OUTPUT")"
/usr/bin/ditto "$app" "$OUTPUT"
echo "Built $OUTPUT"
if [ "$identity" = - ]; then
  echo "This is an ad-hoc development signature. Public archives must use Developer ID and Apple notarization." >&2
fi
