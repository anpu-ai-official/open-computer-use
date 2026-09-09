#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ocu-agy-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

export HOME="$TEST_DIR/home"
MOCK_BIN="$TEST_DIR/mock-bin"
export STATE_MOCK_DIR="$TEST_DIR/mcp-state"
mkdir -p "$HOME" "$MOCK_BIN" "$STATE_MOCK_DIR"
export PATH="$MOCK_BIN:$PATH"

# Create mock agy
export MOCK_AGY_LOG="$TEST_DIR/agy.log"
cat << 'MOCK_AGY' > "$MOCK_BIN/agy"
#!/bin/bash
echo "agy $*" >> "$MOCK_AGY_LOG"
case "${1:-}" in
  --version) echo "agy 1.1.12" ;;
  mcp)
    case "${2:-}" in
      add)
        shift 2
        while [ $# -gt 0 ]; do
          case "$1" in
            --env|--header|--type|-e|-H|-t) shift 2 ;;
            --) shift; break ;;
            -*) shift ;;
            *) name="$1"; break ;;
          esac
        done
        [ -n "${name:-}" ] || exit 1
        touch "$STATE_MOCK_DIR/agy_$name"
        echo "Added MCP server $name"
        ;;
      remove)
        rm -f "$STATE_MOCK_DIR/agy_$3"
        echo "Removed MCP server $3"
        ;;
      list)
        if [ -f "$STATE_MOCK_DIR/agy_open-computer-use" ]; then
          echo "open-computer-use  http  enabled  http://127.0.0.1:17840/mcp"
        fi
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 0 ;;
esac
MOCK_AGY
chmod +x "$MOCK_BIN/agy"

# Create mock claude
export MOCK_CLAUDE_LOG="$TEST_DIR/claude.log"
cat << 'MOCK_CLAUDE' > "$MOCK_BIN/claude"
#!/bin/bash
echo "claude $*" >> "$MOCK_CLAUDE_LOG"
case "${1:-}" in
  --version) echo "2.1.266 (Claude Code)" ;;
  mcp)
    case "${2:-}" in
      add)
        # last arg is url, second to last is name
        shift 2
        name=""
        for arg in "$@"; do
          case "$arg" in
            --*) ;;
            *) name="$arg" ;; # will end up being the second non-flag arg or URL, let us check name
          esac
        done
        touch "$STATE_MOCK_DIR/claude_open-computer-use"
        exit 0
        ;;
      remove)
        shift 2
        for arg in "$@"; do
          case "$arg" in
            --*) ;;
            *) rm -f "$STATE_MOCK_DIR/claude_$arg" ;;
          esac
        done
        exit 0
        ;;
      get)
        if [ -f "$STATE_MOCK_DIR/claude_$3" ]; then
          exit 0
        fi
        exit 1
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 0 ;;
esac
MOCK_CLAUDE
chmod +x "$MOCK_BIN/claude"

export OCU_INSTALL_ROOT="$HOME/Library/Application Support/OpenComputerUse"
export OCU_CLAUDE_HOME="$HOME/.claude"
export OCU_AGY_CONFIG="$HOME/.gemini/config"
export OCU_APPLICATIONS_DIR="$HOME/Applications"
export OCU_LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
export OCU_BIN_DIR="$HOME/.local/bin"
export OCU_LOG_DIR="$HOME/Library/Logs/OpenComputerUse"
export OCU_SKIP_LAUNCHD=1
export OCU_SKIP_DRIVER=1
export OCU_SKIP_ITERM=1
export OCU_SKIP_PERMISSIONS=1
export OCU_SKIP_PATH=1

echo "=== Test 1: Setup with both agy and claude ==="
"$ROOT/bin/open-computer-use" setup --non-interactive --skip-permissions

test -x "$OCU_BIN_DIR/open-computer-use"
test -x "$OCU_BIN_DIR/ocu"
test -x "$OCU_BIN_DIR/claude-computer-use"
test -f "$OCU_AGY_CONFIG/skills/computer-use/SKILL.md"
test -f "$OCU_AGY_CONFIG/skills/computer-use/references/iterm-preview.md"
test -f "$OCU_AGY_CONFIG/skills/computer-use/.open-computer-use-managed"
test -f "$OCU_AGY_CONFIG/skills/computer-use/references/gui-operator.md"
test -f "$OCU_AGY_CONFIG/skills/computer-use/references/devtools-operator.md"
test -f "$OCU_AGY_CONFIG/skills/computer-use/scripts/ocu-call.mjs"

# Claude files
test -f "$OCU_CLAUDE_HOME/skills/computer-use/SKILL.md"
test -f "$OCU_CLAUDE_HOME/agents/gui-operator.md"
test -f "$OCU_CLAUDE_HOME/agents/devtools-operator.md"

# Verify MCP registration calls
grep -Eq "agy mcp add --env OCU_MCP_URL=http://127.0.0.1:17840/mcp open-computer-use .*/node .*/runtime/stdio-proxy.mjs" "$MOCK_AGY_LOG"
grep -q "claude mcp add --scope user --transport http open-computer-use http://127.0.0.1:17840/mcp" "$MOCK_CLAUDE_LOG"
echo "  ✓ Setup successfully installed agy and claude integrations"

echo "=== Test 2: Doctor detects agy and claude ==="
doctor_output="$("$ROOT/bin/open-computer-use" doctor 2>&1 || true)"
echo "$doctor_output" | grep -q "✓ agy CLI"
echo "$doctor_output" | grep -q "✓ agy skill installed"
echo "$doctor_output" | grep -q "✓ agy operator helpers installed"
echo "$doctor_output" | grep -q "✓ agy MCP registration"
echo "$doctor_output" | grep -q "✓ Claude Code CLI"
echo "$doctor_output" | grep -q "✓ Claude skill installed"
echo "$doctor_output" | grep -q "✓ Claude operators installed"
echo "$doctor_output" | grep -q "✓ Claude Code MCP registration"
echo "  ✓ Doctor verified all agy and claude checks"

echo "=== Test 3: Uninstall removes agy and claude integrations ==="
"$ROOT/bin/open-computer-use" uninstall

test ! -e "$OCU_BIN_DIR/open-computer-use"
test ! -e "$OCU_BIN_DIR/ocu"
test ! -e "$OCU_BIN_DIR/claude-computer-use"
test ! -e "$OCU_AGY_CONFIG/skills/computer-use"
test ! -e "$OCU_CLAUDE_HOME/skills/computer-use"
test ! -e "$OCU_CLAUDE_HOME/agents/gui-operator.md"
test ! -e "$OCU_CLAUDE_HOME/agents/devtools-operator.md"

grep -q "agy mcp remove open-computer-use" "$MOCK_AGY_LOG"
grep -q "claude mcp remove --scope user open-computer-use" "$MOCK_CLAUDE_LOG"
echo "  ✓ Uninstall cleaned up both agy and claude integrations"

echo "=== Test 4: agy-only setup and doctor ==="
rm -f "$MOCK_AGY_LOG" "$MOCK_CLAUDE_LOG"
OCU_SKIP_CLAUDE=1 "$ROOT/bin/open-computer-use" setup --non-interactive --skip-permissions

test -f "$OCU_AGY_CONFIG/skills/computer-use/SKILL.md"
test ! -e "$OCU_CLAUDE_HOME/skills/computer-use"
grep -q "agy mcp add --env OCU_MCP_URL=http://127.0.0.1:17840/mcp open-computer-use" "$MOCK_AGY_LOG"
! grep -q "claude mcp add" "$MOCK_CLAUDE_LOG" 2>/dev/null || { echo "Claude should have been skipped"; exit 1; }

doctor_output="$(OCU_SKIP_CLAUDE=1 "$ROOT/bin/open-computer-use" doctor 2>&1 || true)"
echo "$doctor_output" | grep -q "✓ agy CLI"
echo "$doctor_output" | grep -q "✓ agy skill installed"
echo "$doctor_output" | grep -q "✓ agy operator helpers installed"
echo "$doctor_output" | grep -q "✓ agy MCP registration"
! echo "$doctor_output" | grep -q "Claude Code CLI" || { echo "Claude doctor should have been skipped"; exit 1; }

OCU_SKIP_CLAUDE=1 "$ROOT/bin/open-computer-use" uninstall
test ! -e "$OCU_AGY_CONFIG/skills/computer-use"
echo "  ✓ agy-only workflow verified"

echo "=== Test 5: claude-only setup and doctor ==="
rm -f "$MOCK_AGY_LOG" "$MOCK_CLAUDE_LOG"
OCU_SKIP_AGY=1 "$ROOT/bin/open-computer-use" setup --non-interactive --skip-permissions

test -f "$OCU_CLAUDE_HOME/skills/computer-use/SKILL.md"
test ! -e "$OCU_AGY_CONFIG/skills/computer-use"
grep -q "claude mcp add" "$MOCK_CLAUDE_LOG"
! grep -q "agy mcp add" "$MOCK_AGY_LOG" 2>/dev/null || { echo "agy should have been skipped"; exit 1; }

doctor_output="$(OCU_SKIP_AGY=1 "$ROOT/bin/open-computer-use" doctor 2>&1 || true)"
echo "$doctor_output" | grep -q "✓ Claude Code CLI"
echo "$doctor_output" | grep -q "✓ Claude skill installed"
echo "$doctor_output" | grep -q "✓ Claude operators installed"
echo "$doctor_output" | grep -q "✓ Claude Code MCP registration"
! echo "$doctor_output" | grep -q "agy CLI" || { echo "agy doctor should have been skipped"; exit 1; }

OCU_SKIP_AGY=1 "$ROOT/bin/open-computer-use" uninstall
test ! -e "$OCU_CLAUDE_HOME/skills/computer-use"
echo "  ✓ claude-only workflow verified"

echo "All agy integration tests passed successfully!"
