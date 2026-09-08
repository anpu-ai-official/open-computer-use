# Contributing

Thank you for helping improve Open Computer Use. The most useful contributions include reproducible focus-safety bugs, browser lifecycle tests, DevTools diagnostics, macOS accessibility edge cases, and documentation that makes setup more predictable.

## Before opening a change

- Search existing issues and discussions.
- Use an issue for behavior changes large enough to affect the public contract.
- Keep pull requests focused and explain the user-visible outcome.
- Never include credentials, cookies, private browsing artifacts, machine-specific paths, or proprietary application code.

## Development workflow

1. Fork the repository and create a descriptive branch.
2. Install development dependencies with `make install-dev`.
3. Make the smallest coherent change.
4. Add or update tests for behavior changes.
5. Run `make check` and `make test`.
6. Update docs and `CHANGELOG.md` when the public behavior changes.

Live browser and native tests operate real applications. Read [docs/development.md](docs/development.md) before running them.

## Pull-request expectations

A pull request should state what changed, why it is necessary, how it was tested, and whether it affects focus, tab ownership, permissions, artifacts, or installer behavior. UI and focus changes should include repeatable evidence rather than only a screen recording.

Maintainers may ask to split broad changes. Contributions are accepted under the repository's MIT license.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues belong in private disclosure, not a pull request or public issue.
