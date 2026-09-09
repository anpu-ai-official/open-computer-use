# Architecture

Open Computer Use separates orchestration, operation, transport, and presentation so parallel work does not flood the dispatcher context or take over the desktop.

## Components

1. The `computer-use` dispatcher skill chooses the browser/native GUI operator or the DevTools operator. It passes a self-contained brief and consumes only the returned summary and artifact paths. Claude Code uses named `Agent` operators; agy uses built-in `self` subagents that load focused operator guides from the skill.
2. The persistent HTTP MCP broker binds to `127.0.0.1:17840`. It keeps one isolated JavaScript REPL and one isolated native-driver transport per operator session while allowing independent sessions to execute concurrently. Claude Code connects to it directly. agy's operator helper forwards JSON-RPC calls to the broker without owning Chrome or native-driver state; an stdio proxy is also registered for agy builds that mount global MCP servers.
3. The browser runtime connects to the user's already-running Chrome through the patched Cua driver. It creates normal but inactive tabs, records ownership, and exposes a tab-scoped facade.
4. The DevTools adapter binds a CDP session to the owned page. Large results are streamed or written under a unique artifact directory; compact manifests cross the model boundary.
5. The native channel identifies an exact process and window and uses fresh accessibility tokens. The broker keeps token state scoped to one delegated session and translates tokens to exact snapshot/index targets for daemon transports that cannot retain opaque token caches. On macOS the driver is a signed app installed in `~/Applications`; Linux uses the upstream native binary in the desktop user session.
6. The iTerm2 preview renders the latest changed frame in a split pane for active stream sessions (prefixed with `ocu-` or `claude-`). It is a local presentation path, independent of model input.

## Isolation and concurrency

Each REPL has its own bindings, owned-tab set, and cleanup lifecycle. Calls within a session are ordered; different sessions can progress concurrently. A process-wide lease serializes Chrome tracing because tracing is effectively global. Other target-scoped diagnostics remain parallel.

Browser ownership is capability-based: operators can navigate, inspect, and close the tab returned by `createBrowserTab`, but cannot enumerate or foreground arbitrary tabs through the public facade. Cleanup closes unmarked owned tabs, detaches CDP, stops capture domains, resets emulation, and releases trace leases.

## Focus preservation

Chrome tabs are created with inactive target semantics. The runtime does not call `bringToFront`. Native actions set `delivery_mode: background` and are rejected when the OS cannot route them safely. The setup warm-up handles Chrome's one-time broker handshake and restores the prior foreground application.

Focus safety is a tested contract, not a claim that every application supports perfect background input. macOS may reject cross-Space delivery, and some applications expose incomplete accessibility APIs. Operators report those conditions instead of activating a window.

## Artifact model

Network logs, HARs, traces, CPU profiles, coverage, heap snapshots, console records, and application snapshots are stored in per-run UUID directories. Each artifact has a kind, path, byte count, and SHA-256 digest. Operator responses contain summaries and manifests, not the full payload.

The artifact root defaults to the system temporary directory and can be overridden with `CLAUDE_CUA_ARTIFACT_DIR`. Treat artifacts as potentially sensitive because they may contain URLs, headers, storage values, or page data.
