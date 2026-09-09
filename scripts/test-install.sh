#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="${OCU_TEST_BUNDLE:-$ROOT}"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/open-computer-use-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

export HOME="$TEST_ROOT/home"
export OCU_INSTALL_ROOT="$HOME/Library/Application Support/OpenComputerUse"
export OCU_CLAUDE_HOME="$HOME/.claude"
export OCU_AGY_CONFIG="$HOME/.gemini/config"
export OCU_APPLICATIONS_DIR="$HOME/Applications"
export OCU_LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
export OCU_BIN_DIR="$HOME/.local/bin"
export OCU_LOG_DIR="$HOME/Library/Logs/OpenComputerUse"
export OCU_SKIP_LAUNCHD=1
export OCU_SKIP_MCP=1
export OCU_SKIP_ITERM=1
export OCU_SKIP_PERMISSIONS=1
export OCU_SKIP_PATH=1

"$BUNDLE/bin/open-computer-use" doctor --bundle-only
"$BUNDLE/bin/open-computer-use" setup --non-interactive --skip-permissions

test -x "$OCU_BIN_DIR/open-computer-use"
test -x "$OCU_BIN_DIR/ocu"
test -x "$OCU_BIN_DIR/claude-computer-use"
test -x "$OCU_BIN_DIR/claude-cua-preview"
test -x "$OCU_BIN_DIR/ocu-preview"
test -f "$OCU_CLAUDE_HOME/skills/computer-use/SKILL.md"
test -f "$OCU_CLAUDE_HOME/agents/gui-operator.md"
test -f "$OCU_CLAUDE_HOME/agents/devtools-operator.md"
test -f "$OCU_AGY_CONFIG/skills/computer-use/SKILL.md"
test -f "$OCU_AGY_CONFIG/skills/computer-use/references/gui-operator.md"
test -f "$OCU_AGY_CONFIG/skills/computer-use/references/devtools-operator.md"
test -f "$OCU_AGY_CONFIG/skills/computer-use/scripts/ocu-call.mjs"
test -d "$OCU_APPLICATIONS_DIR/OpenComputerUseDriver.app"
"$OCU_BIN_DIR/claude-cua-preview" --help >/dev/null
(cd "$BUNDLE/runtime" && "$BUNDLE/libexec/node/bin/node" --input-type=module -e 'import("playwright").then(p => { if (!p.chromium) process.exit(1) })') >/dev/null
if /usr/bin/grep -R -E -n '/Users/user|/Applications/ChatGPT\.app' "$BUNDLE/runtime" "$BUNDLE/share/claude" "$BUNDLE/share/agy"; then
  echo "Development-machine absolute path leaked into the package" >&2
  exit 1
fi

"$OCU_BIN_DIR/open-computer-use" uninstall
test ! -e "$OCU_BIN_DIR/open-computer-use"
test ! -e "$OCU_CLAUDE_HOME/skills/computer-use"
test ! -e "$OCU_AGY_CONFIG/skills/computer-use"
test ! -e "$OCU_APPLICATIONS_DIR/OpenComputerUseDriver.app"

echo "Isolated install test passed"
