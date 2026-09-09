# Development

## Repository layout

- `runtime/`: persistent MCP, browser facade, DevTools adapter, preview runtime, and tests
- `share/claude/`: dispatcher skill plus isolated GUI and DevTools operators for Claude Code
- `share/agy/`: dispatcher skill plus operator guides and broker-call helper for Google Antigravity
- `packaging/`: driver build, release assembly, signing metadata, and formula renderer
- `patches/`: pinned upstream Cua changes and license notice
- `bin/`: management CLI and internal preview launcher
- `scripts/`: repository, skill/agent validation, and isolated-install checks

## Local checks

Requirements for source development are Node.js 22+, npm, Bash, Ruby, and macOS tools such as `plutil`. ShellCheck is recommended.

```bash
make install-dev
make check
make test
```

`make test` uses headless browser fixtures and does not require your live Chrome profile. Live suites are opt-in because they control real local applications:

```bash
cd runtime
npm run test:live-browser
npm run test:http-browser
npm run test:http-devtools-stress
npm run test:live-native
scripts/test-linux-x11.sh
```

Review the test source before running live tests. The suite creates temporary tabs/windows and should return ownership to zero.

## Building a development archive

Build the patched driver first or provide an existing development-signed app:

```bash
CUA_DRIVER_APP_SOURCE=/absolute/path/to/OpenComputerUseDriver.app packaging/build-release.sh
```

The public release gate is stricter: the driver must be Developer ID-signed, notarized, and stapled. Never publish the local development artifact.

## Skill and agent changes

The dispatcher is intentionally short; detailed protocols belong in its references and operator files. Validate skills and agents with:

```bash
python3 scripts/validate-skill.py share/claude/skills/computer-use
python3 scripts/validate-skill.py share/agy/skills/computer-use
```

Keep the root agent delegate-only. Browser accessibility trees, screenshots, and raw diagnostic payloads belong in isolated operator context, not the dispatcher.
