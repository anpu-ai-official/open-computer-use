# Verification record for 0.1.0

Test host: Apple silicon, macOS 26.5.1, Claude Code 2.1.263, iTerm2 3.6.10, Google Chrome 152.0.7977.76.

## Release artifact

- Archive: `open-computer-use-0.1.0-darwin-arm64.tar.gz`
- Compressed size: approximately 50 MB.
- SHA-256: recorded in the adjacent `.sha256` file and verified after the final build.
- Bundles Node.js v22.23.2 arm64, Playwright 1.63.0, Acorn 8.18.0, the iTerm viewer, Claude integration files, and the patched driver app.
- The release contains no machine-specific `/Users/...` path and no dependency on ChatGPT.app.

## Installer boundaries

- Isolated setup under a generated fake home: passed.
- Download → checksum → extract → versioned install → `current` symlink → setup: passed through a local HTTP release server.
- `.zprofile` PATH onboarding: passed; the marker is idempotent.
- Generated LaunchAgent: `plutil` passed.
- Legacy `com.claude.cua-repl` migration and exact broker-version checks prevent an upgrade from silently talking to a stale process on port 17840; unknown listeners are refused rather than killed.
- Homebrew: a temporary local tap installed the archive into the Cellar (562 files), the bundled doctor passed, then the formula and tap were removed cleanly.
- Shell scripts: `bash -n` and ShellCheck passed without findings.
- Formula template: Ruby syntax passed. The local `brew style` command could not fetch its RuboCop bundle because this test host's portable Ruby rejected the RubyGems certificate; the actual local-tap installation succeeded afterward.

## Browser and DevTools

- Packaged Node/Playwright broker cold-started on an isolated port.
- The explicit `warm-browser` onboarding probe restored the original ChatGPT foreground app after Chrome's one-time consent handshake.
- A subsequent inactive existing-profile task created and closed a tab, returned `owned: 0`, and left ChatGPT foreground.
- Component suites passed: persistent REPL bindings, parallel sessions, rollback, teardown, trace lease recovery, network/HAR, Console, Application storage, Web Vitals, CPU profiling, JavaScript/CSS coverage, compressed tracing, heap snapshots, allocation sampling, preview publishing, and anchored repaint.
- Representative DevTools run: 8 network requests, 2 expected failures, 3 console entries, 290 CPU samples, a 21 KB trace, and a 9.2 MB heap snapshot; all tabs and capture domains were cleaned up.

## iTerm preview and native stream

- Packaged preview lifecycle passed: start, image publish, hide, restore, close.
- Foreground app remained ChatGPT.
- iTerm window bounds remained exactly `0, 33, 890, 695` and the source grid remained `80x25` across the lifecycle.
- Viewer repaint test confirmed one clear at startup and zero full-pane clears on later frames.
- Same-window terminal watcher used the AppleScript text-buffer path, observed typed text `NODE_WATCH_TYPED_9182`, advanced changed frames with zero capture errors, and excluded the preview pane by construction.
- Parallel background native launches were verified without either target becoming foreground. When macOS placed a test window on another Space, the action was correctly reported as not background-addressable instead of moving Spaces.

## Linux X11 and Chrome

The checked-in `tests/platform/linux-x11` harness was run end to end on this Apple-silicon host through Docker's native Linux ARM64 VM:

- Debian 12 ARM64, Xvfb/Openbox X11 desktop, AT-SPI session bus, Cua Driver 0.24.0, Node.js 22.23.2, and Google Chrome 152.0.7977.82.
- Native GTK snapshot, background text insertion, background button action, and semantic postcondition readback passed while a separate sentinel window remained focused and the real pointer was unchanged.
- Four independent native broker sessions simultaneously drove four different GTK windows in 301–340 ms across repeated runs; every result was isolated and focus/pointer invariants remained unchanged.
- The broker's opaque-token compatibility layer was exercised against the real Linux daemon proxy. A separate deterministic fake-driver regression test checks the exact token-to-PID/window/snapshot/index translation.
- Browser JavaScript persistence and parallel-session isolation passed. The full DevTools regression passed Network, Console, Application storage, CPU, JavaScript/CSS coverage, performance, trace, heap snapshot, heap sampling, cleanup, and resilience checks; all browser-owned tabs were closed.

The GitHub Actions Linux lane runs the same image natively on x86_64. Linux X11 runtime qualification is distinct from a public Linux installer/release, which is not shipped by 0.1.0.

## Claude Code native-channel regression

After upgrading the installed skill and broker, Claude Code 2.1.263 dispatched two `gui-operator` subagents together. One used the new session-isolated native channel for an app inventory; the other created an inactive existing-profile Chrome tab, read “Example Domain,” closed it, and reported zero owned tabs. Both completed successfully. An external 200 ms monitor captured 408 samples with zero foreground transitions, Chrome never became foreground, and no agent tab was selected. The run cost was $0.3945 and returned only compact operator summaries to the dispatcher.

## Public-release gate

The checked local archive contains an ad-hoc-signed driver. Its code signature is internally valid and does not expire, while Gatekeeper correctly reports that it is not notarized.

The release workflow rebuilds the driver from the pinned Cua commit plus this repository's patch, ad-hoc signs it, verifies both the signature and expected Gatekeeper result, rebuilds the archive, reruns the isolated installer test, and only then publishes. It requires no Apple signing secrets. Users may need to choose **Open Anyway** once after installation, and driver-changing upgrades may require renewed privacy approvals.

macOS Accessibility, Screen Recording, and iTerm Automation remain explicit user approvals. `sudo` cannot grant them.
