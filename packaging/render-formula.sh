#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${OCU_VERSION:-$(tr -d '[:space:]' < "$ROOT/VERSION")}"
REPOSITORY="${OCU_REPOSITORY:?Set OCU_REPOSITORY to owner/open-computer-use}"
ARCHIVE="${OCU_ARCHIVE:-$ROOT/dist/open-computer-use-$VERSION-darwin-arm64.tar.gz}"
[ -f "$ARCHIVE" ] || { echo "Archive not found: $ARCHIVE" >&2; exit 1; }
SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
HOMEPAGE="https://github.com/$REPOSITORY"
URL="$HOMEPAGE/releases/download/v$VERSION/$(basename "$ARCHIVE")"
OUTPUT="${OCU_FORMULA_OUTPUT:-$ROOT/Formula/open-computer-use.rb}"
sed \
  -e "s|@@HOMEPAGE@@|$HOMEPAGE|g" \
  -e "s|@@URL@@|$URL|g" \
  -e "s|@@SHA256@@|$SHA256|g" \
  -e "s|@@VERSION@@|$VERSION|g" \
  "$ROOT/Formula/open-computer-use.rb.in" > "$OUTPUT"
ruby -c "$OUTPUT"
echo "Rendered $OUTPUT"
