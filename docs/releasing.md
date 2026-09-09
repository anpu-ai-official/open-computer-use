# Releasing

Public releases are created only by the GitHub Actions release workflow.

The release workflow uses macOS ad-hoc code signing. It requires no Apple Developer membership, signing certificate, or repository secrets. The resulting build does not expire, but Gatekeeper may require users to approve the native driver with **Open Anyway** on first launch.

## Checklist

1. Update `VERSION`, `CHANGELOG.md`, and any version constants together.
2. Run `make release-check` on an Apple-silicon Mac.
3. Merge through a green CI run with a clean working tree.
4. Dispatch `release.yml` with the exact version from `VERSION`.
5. Confirm the workflow verifies the driver's ad-hoc signature and expected Gatekeeper rejection.
6. Confirm the isolated archive installation passes.
7. Verify the generated GitHub release, checksums, and Homebrew formula.
8. Install the published artifact on a clean test account, complete **Open Anyway** if prompted, and run `doctor --deep` before announcing it.

The workflow rebuilds the driver from the pinned upstream commit and patch, ad-hoc signs it, builds the self-contained archive, tests it, publishes release assets, and updates the formula.

Do not replace workflow-built assets manually. Ad-hoc signatures change when the driver changes, so macOS may ask users to renew Accessibility or Screen Recording approval after an upgrade. A future Developer ID release can improve that experience without changing the installer interface.
