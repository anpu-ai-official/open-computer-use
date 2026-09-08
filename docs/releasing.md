# Releasing

Public releases are created only by the GitHub Actions release workflow.

## Prerequisites

Configure these repository secrets:

- `APPLE_DEVELOPER_ID_P12_BASE64`
- `APPLE_DEVELOPER_ID_P12_PASSWORD`
- `APPLE_CODESIGN_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_PASSWORD`
- `APPLE_TEAM_ID`

The signing certificate must be a Developer ID Application certificate whose identity matches `APPLE_CODESIGN_IDENTITY`. The app-specific Apple password must be authorized for notarization.

## Checklist

1. Update `VERSION`, `CHANGELOG.md`, and any version constants together.
2. Run `make release-check` on an Apple-silicon Mac.
3. Merge through a green CI run with a clean working tree.
4. Dispatch `release.yml` with the exact version from `VERSION`.
5. Confirm notarization and stapling succeed.
6. Confirm the isolated archive installation passes.
7. Verify the generated GitHub release, checksums, and Homebrew formula.
8. Install the published artifact on a clean test account and run `doctor --deep` before announcing it.

The workflow rebuilds the driver from the pinned upstream commit and patch, imports signing credentials into a temporary keychain, notarizes the app, builds the self-contained archive, tests it, publishes release assets, and updates the formula.

Do not bypass a failed notarization or replace the artifact manually. A release must preserve the driver identity so macOS permissions survive upgrades.
