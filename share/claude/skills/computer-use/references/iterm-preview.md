# iTerm picture-in-picture preview

Computer-use tasks launched from iTerm should share one minimizable preview pane in the originating Claude Code tab. The preview is presentation-only: frames stay local and never enter model context.

## Start once in the dispatcher

Before dispatching the first GUI operator, use one Bash call:

```bash
if [ -n "${ITERM_SESSION_ID:-}" ]; then
  preview_session_id=${ITERM_SESSION_ID##*:}
  preview_stream="claude-${preview_session_id}"
  "$HOME/.local/bin/open-computer-use" preview start \
    --stream "$preview_stream" \
    --source-session "$ITERM_SESSION_ID" \
    --position auto \
    --width 30 \
    --height 12
fi
```

Pass the returned `stream` to every sibling operator as `Preview stream: <value>`. Each operator uses its own task session ID as the preview channel. If `ITERM_SESSION_ID` is absent or setup fails, continue the task without preview and report the limitation briefly.

Do not create one pane per subagent. `start` is idempotent for an existing live viewer and restores it if minimized. Keep the viewer after task completion so the user can inspect the last frame.

## Viewer controls

The preview stays inside the same iTerm tab and the source Claude pane remains active.

- `m`: hide the preview pane completely while retaining its stream state.
- `p` or Space: pause/resume rendering.
- `q`: close the preview pane.

After hiding, restore from the Claude pane with the command below. A later idempotent `start` also restores the same stream automatically.

The same controls are available from the Claude shell:

```bash
"$HOME/.local/bin/open-computer-use" preview minimize --stream <stream>
"$HOME/.local/bin/open-computer-use" preview restore --stream <stream>
"$HOME/.local/bin/open-computer-use" preview status --stream <stream>
"$HOME/.local/bin/open-computer-use" preview close --stream <stream>
```

## Operator frame sources

Browser operators start the target-owned frame publisher after creating their tab:

```js
await tab.preview.start({
  stream: "<dispatcher stream>",
  channel: "<operator session>",
  fps: 4,
  quality: 60
});
```

The default polling mode captures changed page states reliably even when Chrome does not continuously composite an inactive tab. It deduplicates unchanged screenshots, drops stale frames under backpressure, and writes only the latest JPEG plus compact metadata. Call `await tab.preview.stop()` before closing the tab.

Native operators publish the same post-action verification snapshot they already need, without returning screenshot base64 to the model:

```bash
"$HOME/.local/bin/open-computer-use" preview native-snapshot \
  --stream <dispatcher-stream> \
  --channel <operator-session> \
  --label "after <action>" \
  --json '<normal get_window_state JSON>'
```

This invokes `cua-driver get_window_state` with a temporary `screenshot_out_file`, atomically publishes the frame, and returns the ordinary state with `screenshot_file_path` rewritten to the published image.

After selecting the exact native `pid` and `window_id`, also start a change-detected watcher so manual typing, app animations, and other non-agent changes appear between operator actions:

```bash
"$HOME/.local/bin/open-computer-use" preview native-watch-start \
  --stream <dispatcher-stream> \
  --channel <operator-session>-live \
  --pid <pid> \
  --window-id <window-id> \
  --fps 1 \
  --label "<app or task>"
```

Stop it before returning with `"$HOME/.local/bin/open-computer-use" preview native-watch-stop --stream <dispatcher-stream> --channel <operator-session>-live`. The watcher uses screenshot-only capture, pixel deduplication, and a one-frame latest-value buffer; frames never enter model context. One frame per second is deliberate: it makes terminal cursor motion and slow UI changes readable without turning the terminal image renderer into a flashing video surface.

If the target is an iTerm session in the same window as the preview, add `--iterm-session <exact-session-id>`. The watcher reads only that session's visible text through iTerm's built-in AppleScript interface, which captures terminal typing and excludes the preview pane by construction.

The viewer clears its alternate screen only once at startup. Later frames are painted over one fixed region with cursor save/restore, so a changed frame cannot expose a blank pane between images.

## Measurement boundary

Screenshot polling adds renderer and encoding work. For Web Vitals, CPU profiling, tracing, or memory-performance measurements, stop the live preview immediately before the measured interval and restart it afterward if visual progress is still useful. Application/storage and ordinary Network diagnosis can keep preview enabled unless the investigation concerns precise timing.
