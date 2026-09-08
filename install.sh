#!/bin/bash
set -euo pipefail

REPOSITORY="${OCU_REPOSITORY:-anpu-ai-official/open-computer-use}"
VERSION="${OCU_VERSION:-latest}"
INSTALL_ROOT="${OCU_INSTALL_ROOT:-$HOME/Library/Application Support/OpenComputerUse}"

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  printf 'Open Computer Use currently supports only Apple-silicon macOS.\n' >&2
  exit 1
fi
if [ "$VERSION" = latest ]; then
  release_api="${OCU_RELEASE_API_URL:-https://api.github.com/repos/$REPOSITORY/releases/latest}"
  VERSION="$(curl -fsSL "$release_api" | sed -n 's/.*"tag_name":[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$VERSION" ] || { printf 'Could not resolve the latest release.\n' >&2; exit 1; }
fi

asset="open-computer-use-$VERSION-darwin-arm64.tar.gz"
base="${OCU_RELEASE_BASE_URL:-https://github.com/$REPOSITORY/releases/download/v$VERSION}"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/open-computer-use-install.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT

printf 'Downloading Open Computer Use %s…\n' "$VERSION"
curl -fL --retry 3 -o "$temporary/$asset" "$base/$asset"
curl -fL --retry 3 -o "$temporary/$asset.sha256" "$base/$asset.sha256"
expected="$(awk '{print $1}' "$temporary/$asset.sha256")"
actual="$(shasum -a 256 "$temporary/$asset" | awk '{print $1}')"
[ "$expected" = "$actual" ] || { printf 'Release checksum mismatch.\n' >&2; exit 1; }

tar -xzf "$temporary/$asset" -C "$temporary"
source_root="$temporary/open-computer-use-$VERSION"
[ -x "$source_root/bin/open-computer-use" ] || { printf 'Release archive is incomplete.\n' >&2; exit 1; }
release_root="$INSTALL_ROOT/releases/$VERSION"
mkdir -p "$INSTALL_ROOT/releases"
if [ -e "$release_root" ]; then mv "$release_root" "$release_root.previous-$(date +%Y%m%d-%H%M%S)"; fi
/usr/bin/ditto "$source_root" "$release_root"
ln -sfn "$release_root" "$INSTALL_ROOT/current"
printf 'direct\n' > "$INSTALL_ROOT/install-kind"
exec "$INSTALL_ROOT/current/bin/open-computer-use" setup
