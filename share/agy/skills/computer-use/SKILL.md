---
name: computer-use
description: Delegate native-app and browser UI work to focused operators. Ordinary UI work uses gui-operator; Chrome DevTools, network, storage, performance, CPU, coverage, trace, or memory diagnosis uses devtools-operator. Both create isolated background work that does not steal focus or fill the dispatcher's context.
---

# Computer Use & Browser Use

Delegate all GUI/browser execution and state inspection. Use `devtools-operator` for Chrome DevTools diagnosis: Network, Console, Issues, Application/storage, Web Vitals, traces, CPU, JavaScript/CSS coverage, heap, or throttling. Use `gui-operator` for all other browser and native UI work. Browser work uses a persistent Codex-shaped `js`/`js_reset` runtime; native work uses the same broker's persistent session-isolated `native` channel. The dispatcher must not call browser/native MCP tools or ingest accessibility trees, screenshots, app inventories, window inventories, DOM dumps, HARs, traces, heap snapshots, or profiles. Its job is preview setup, dispatch, and synthesis from concise operator results. A test harness may make a one-line, read-only frontmost-app identity check, but never broad GUI discovery.

When the parent agy or terminal session runs in iTerm, start one shared in-tab preview before dispatching unless the user asked to disable it. Read [references/iterm-preview.md](references/iterm-preview.md) for the one-command setup and pass its stream name to every operator. The pane is minimizable, never becomes the active source pane, and receives only file-backed local frames—not model-visible screenshots.

## Dispatch

Create a short unique session ID using only letters, digits, `_`, and `-`. Include it in the prompt and require the operator to pass it unchanged to every browser `js`/`js_reset` call and every `native`/`native_reset` call.

In the agy CLI, dispatch a built-in `self` subagent. Tell it which installed operator guide to read before acting:

```text
invoke_subagent({
  Subagents: [{
    TypeName: "self",
    Role: "<GUI Operator or DevTools Operator>",
    Prompt: "Read ${OCU_AGY_CONFIG:-$HOME/.gemini/config}/skills/computer-use/references/<gui-operator.md or devtools-operator.md> completely, then follow it. Session: <unique-session>. Goal: <complete task>. Starting app/URL: <value>. Required values or diagnostic question: <values>. Success means: <observable postcondition>. Return only: <outcome, evidence-backed findings, requested values, and artifact paths>. Zero foreground/focus changes."
  }]
})
```

The operator is a fresh agent. Restate the concrete goal, starting app or URL, required inputs or diagnostic question, observable completion state, and preview stream when available. Do not refer to facts as “the thing discussed above.” DevTools operators keep large telemetry in files and return only compact findings and paths.

## Parallel work

Dispatch independent GUI/browser tasks as parallel focused operators. Every task must have a different session ID.

- Browser tasks are isolated by owned-page sets and separate JavaScript kernels. Each task creates a new inactive tab in the already-running Chrome user profile; it never adopts or activates a pre-existing user tab.
- Native tasks must target different apps or independently created windows. A singleton app/window is one shared resource and should be serialized.
- A native window on another macOS Space is not background-addressable. Do not move it, switch Spaces, activate it, or escape to Peekaboo; use a separate instance if the app supports one, otherwise return the concrete blocker.
- Each operator's persistent JavaScript kernel and action queue are separate. Calls within one session stay ordered; different sessions may execute concurrently.
- Network, Console, Application, CPU, coverage, and heap probes can run in parallel on different owned tabs. Chrome tracing is browser-global; the runtime grants one trace lease and returns a clean busy error to contenders without blocking other probes.
- Pass multiple `self` operator definitions in the `Subagents` array of `invoke_subagent` to execute independent tasks in parallel.
- Do not create cron jobs or heartbeats for ordinary GUI delegation, and do not poll agent transcripts into the parent context.

## Result

Relay the operator's concise outcome. Do not reproduce raw screenshots, complete accessibility trees, HARs, traces, heap snapshots, profiles, coverage blobs, or action-by-action logs unless the user requested debugging evidence.

## Runtime

Operators call `scripts/ocu-call.mjs` through agy's shell tool. It exposes the broker's `js`, `js_reset`, `native`, and `native_reset` operations without putting raw state in the dispatcher context. Newly created tabs expose `tab.devtools` and `tab.preview`; the operator guides document their high-level capture, preview, and file-backed artifact APIs.

The browser runtime is the persistent local HTTP MCP broker at `http://127.0.0.1:17840/mcp`. The helper forwards one JSON-RPC call at a time to that broker and never connects to Chrome itself. The long-lived broker owns one Chrome 144+ agent auto-connect/Playwright connection and multiplexes every operator session over it, so a fresh agy CLI process does not reconnect Chrome or trigger debugger-consent focus. If the broker is unavailable, return `persistent_browser_broker_unavailable`; do not start the runtime directly over stdio, launch another Chrome/profile, attach through the stock Playwright extension, or change focus. Headless mode exists only for explicit component tests through `CLAUDE_CUA_BROWSER_MODE=headless`.

Native runtime: `native` with `{session, tool, arguments}`. The broker owns one long-lived cua-driver MCP channel per delegated session, serializes calls within that session, and runs different sessions concurrently. It preserves snapshot-token validity across calls and compensates for driver proxy transports that otherwise invalidate opaque tokens. End native work with `native_reset` for that session.

The persistent Open Computer Use MCP is managed by the installation. If it is unavailable, run `"$HOME/.local/bin/open-computer-use" doctor --repair` and report any remaining failed check.
