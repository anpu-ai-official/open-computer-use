# Installation

## Requirements

- Apple-silicon Mac (`arm64`) running macOS 13 or newer
- Claude Code CLI installed and authenticated
- iTerm2 installed at `/Applications/iTerm.app`
- Google Chrome installed at `/Applications/Google Chrome.app`

Chrome should already be running when you first use browser automation. Open Computer Use creates inactive tabs in that same profile and inherits its cookies, extensions, and authenticated sessions.

## Signed release

When the first signed release is available, install the latest version with:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/anpu-ai-official/open-computer-use/main/install.sh)"
```

The bootstrap downloads the matching release archive and checksum from GitHub, verifies SHA-256, installs a versioned bundle under `~/Library/Application Support/OpenComputerUse`, switches the `current` symlink, and runs setup. It does not invoke `sudo`.

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

Development archives require a patched driver app. They are intentionally not suitable for public distribution unless the app is Developer ID-signed and notarized.

```bash
CUA_DRIVER_APP_SOURCE=/absolute/path/to/OpenComputerUseDriver.app packaging/build-release.sh
```

Extract the generated archive and run its setup command. For isolated installer validation, use `scripts/test-install.sh` as documented in [development.md](development.md).

## Upgrades and migration

Running the installer again places the new immutable bundle next to the old one and atomically updates `current`. Setup migrates the earlier `claude-computer-use` command, MCP registration, managed skill marker, driver app, and LaunchAgent names.

Existing user-authored Claude skills or agents are moved to timestamped backups before managed files are installed. The installer refuses to kill an unknown process occupying the broker port.

## Uninstall

```bash
open-computer-use uninstall
```

Managed integrations and a direct-install bundle are moved to `~/.Trash/OpenComputerUse-<timestamp>` so they can be recovered. Homebrew users should then run `brew uninstall open-computer-use` to remove the Cellar package.
