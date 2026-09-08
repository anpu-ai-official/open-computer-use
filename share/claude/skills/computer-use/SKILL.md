---
name: computer-use
description: Delegate native-app and browser UI work to focused operators. Ordinary UI work uses gui-operator; Chrome DevTools, network, storage, performance, CPU, coverage, trace, or memory diagnosis uses devtools-operator. Both create isolated background work that does not steal focus or fill the dispatcher's context.
---

# Computer Use & Browser Use

Delegate all GUI/browser execution and state inspection. Use `devtools-operator` for Chrome DevTools diagnosis: Network, Console, Issues, Application/storage, Web Vitals, traces, CPU, JavaScript/CSS coverage, heap, or throttling. Use `gui-operator` for all other browser and native UI work. Browser work uses a persistent Codex-shaped `js`/`js_reset` runtime; native work uses separate packaged-driver CLI connections to its persistent daemon. The dispatcher must not call browser/native MCP tools or ingest accessibility trees, screenshots, app inventories, window inventories, DOM dumps, HARs, traces, heap snapshots, or profiles. Its job is preview setup, dispatch, and synthesis from concise operator results. A test harness may make a one-line, read-only frontmost-app identity check, but never broad GUI discovery.

When the parent Claude session runs in iTerm, start one shared in-tab preview before dispatching unless the user asked to disable it. Read [references/iterm-preview.md](references/iterm-preview.md) for the one-command setup and pass its stream name to every operator. The pane is minimizable, never becomes the active source pane, and receives only file-backed local frames—not model-visible screenshots.

## Dispatch

Create a short unique session ID using only letters, digits, `_`, and `-`. Include it in the prompt and require the operator to pass it unchanged to every browser `js`/`js_reset` call or native cua-driver call.

```text
Agent({
  subagent_type: "<gui-operator or devtools-operator>",
  name: "<short-task-name>",
  description: "<3-5 word summary>",
  run_in_background: false,
  prompt: "Session: <unique-session>. Goal: <complete task>. Starting app/URL: <value>. Required values or diagnostic question: <values>. Success means: <observable postcondition>. Return only: <outcome, evidence-backed findings, requested values, and artifact paths>. Zero foreground/focus changes."
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
- Claude Code currently schedules at most four of these operators simultaneously in the tested configuration. Dispatch larger batches normally, but expect excess agents to queue; do not mistake queued work for failed isolation.
- Issue sibling `Agent` calls together with `run_in_background:false`; Claude still runs sibling calls concurrently and delivers their final results to the dispatcher. Do not create cron jobs or `ScheduleWakeup` heartbeats for ordinary GUI delegation, and do not poll agent transcripts into the parent context.

## Result

Relay the operator's concise outcome. Do not reproduce raw screenshots, complete accessibility trees, HARs, traces, heap snapshots, profiles, coverage blobs, or action-by-action logs unless the user requested debugging evidence.

## Runtime

Browser tools: `mcp__open-computer-use__js` and `mcp__open-computer-use__js_reset`. Newly created tabs expose `tab.devtools` and `tab.preview`; the dedicated operators document their high-level capture, preview, and file-backed artifact APIs.

The normal browser transport is the persistent local HTTP MCP at `http://127.0.0.1:17840/mcp`. Its long-lived broker owns one Chrome 144+ agent auto-connect/Playwright connection and multiplexes every operator session over it, so a fresh Claude CLI process does not reconnect Chrome or trigger debugger-consent focus. If the HTTP broker is unavailable, return `persistent_browser_broker_unavailable`; do not start a per-task stdio bridge, launch another Chrome/profile, attach through the stock Playwright extension, or change focus. Headless mode exists only for explicit component tests through `CLAUDE_CUA_BROWSER_MODE=headless`.

Native runtime: `Bash` calls shaped as `"$HOME/.local/bin/open-computer-use" driver <tool> '<JSON>'`. Separate CLI connections can run concurrently against the packaged daemon.

The persistent browser MCP is managed by the `open-computer-use` installation. If it is unavailable, run `"$HOME/.local/bin/open-computer-use" doctor --repair` and report any remaining failed check.
