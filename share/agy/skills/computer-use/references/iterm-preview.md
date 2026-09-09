# iTerm picture-in-picture preview

Computer-use tasks launched from iTerm should share one minimizable preview pane in the originating terminal tab (agy CLI or Claude Code). The preview is presentation-only: frames stay local and never enter model context.

## Start once in the dispatcher

Before dispatching the first GUI operator, use one shell call:

```bash
if [ -n "${ITERM_SESSION_ID:-}" ]; then
  preview_session_id=${ITERM_SESSION_ID##*:}
  preview_stream="ocu-${preview_session_id}"
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

The preview stays inside the same iTerm tab and the source CLI pane remains active.

- `m`: hide the preview pane completely while retaining its stream state.
- `p` or Space: pause/resume rendering.
- `q`: close the preview pane.

After hiding, restore from the CLI shell with the command below. A later idempotent `start` also restores the same stream automatically.

The same controls are available from the terminal shell:

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
  --stream "<dispatcher stream>" \
  --channel "<operator session>-actions" \
  --label "before/after <action>" \
  --json '<get_window_state JSON>'
```

For continuous background watching between actions, launch a watcher before acting and terminate it in cleanup:

```bash
"$HOME/.local/bin/open-computer-use" preview native-watch-start \
  --stream "<dispatcher stream>" \
  --channel "<operator session>-live" \
  --pid <pid> \
  --window-id <window_id> \
  --fps 1 \
  --label "<app/task>"
```
