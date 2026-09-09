# Installation

## Requirements

- Apple-silicon Mac (`arm64`) running macOS 13 or newer
- Either Google Antigravity CLI (`agy`) or Claude Code CLI (`claude`) installed and authenticated (both supported)
- iTerm2 installed at `/Applications/iTerm.app`
- Google Chrome installed at `/Applications/Google Chrome.app`

Chrome should already be running when you first use browser automation. Open Computer Use creates inactive tabs in that same profile and inherits its cookies, extensions, and authenticated sessions.

## GitHub release

Install the latest version with:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/anpu-ai-official/open-computer-use/main/install.sh)"
```

The bootstrap downloads the matching release archive and checksum from GitHub, verifies SHA-256, installs a versioned bundle under `~/Library/Application Support/OpenComputerUse`, switches the `current` symlink, and runs setup. It does not invoke `sudo`.

The bundled native driver is ad-hoc signed. The signature has no subscription or expiry, but it is not an Apple Developer ID signature and the app is not notarized. If macOS blocks `~/Applications/OpenComputerUseDriver.app` on first launch, try to open it once, then go to **System Settings → Privacy & Security → Open Anyway**. Rerun the permissions command afterward. Do not disable Gatekeeper globally.

Then complete Apple's approvals and verify everything:

```bash
open-computer-use permissions
open-computer-use doctor --deep
```

## Homebrew

After the first release publishes the formula:

```bash
brew install anpu-ai-official/open-computer-use/open-computer-use
open-computer-use permissions
open-computer-use doctor --deep
```

## Development installation

Development archives require a patched driver app. `packaging/build-driver.sh` creates the same ad-hoc-signed driver used by the free GitHub release unless `APPLE_CODESIGN_IDENTITY` selects a Developer ID certificate.

```bash
CUA_DRIVER_APP_SOURCE=/absolute/path/to/OpenComputerUseDriver.app packaging/build-release.sh
```

Extract the generated archive and run its setup command. For isolated installer validation, use `scripts/test-install.sh` as documented in [development.md](development.md).

## Upgrades and migration

Running the installer again places the new immutable bundle next to the old one and atomically updates `current`. Setup installs the agy skill with its operator guides and helper under `~/.gemini/config/skills/computer-use`, installs the Claude Code skill and agents under `~/.claude`, registers agy's lightweight stdio proxy and Claude Code's direct HTTP endpoint (`http://127.0.0.1:17840/mcp`), and migrates earlier commands, driver app, and LaunchAgent names.

Launch agy normally and ask it to use `computer-use`. The skill delegates each operation to a built-in `self` subagent, which reads the installed operator guide and calls the broker through the bundled helper; it does not depend on custom-agent discovery.

Setup can be configured via environment variables:
- `OCU_AGY_CONFIG`: Target Antigravity configuration directory (defaults to `~/.gemini/config`).
- `OCU_SKIP_AGY=1`: Skip Antigravity skills, operators, and MCP registration.
- `OCU_SKIP_CLAUDE=1`: Skip Claude Code skills, agents, and MCP registration.

Existing user-authored skills or agents in either assistant's configuration are moved to timestamped backups before managed files are installed. The installer refuses to kill an unknown process occupying the broker port.

## Uninstall

```bash
open-computer-use uninstall
```

Managed integrations (including agy and Claude skills, Claude operators, MCP registrations, and command symlinks) and a direct-install bundle are moved to `~/.Trash/OpenComputerUse-<timestamp>-<pid>` so they can be recovered. Homebrew users should then run `brew uninstall open-computer-use` to remove the Cellar package.
