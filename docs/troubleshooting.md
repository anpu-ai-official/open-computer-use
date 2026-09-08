# Troubleshooting

Start with `open-computer-use doctor --deep`. Use `open-computer-use doctor --repair` to repeat safe setup steps, then run the deep check again.

## Browser broker does not respond

```bash
open-computer-use restart
open-computer-use status
```

Logs are under `~/Library/Logs/OpenComputerUse`. The broker must be the only listener on `127.0.0.1:17840`; setup refuses to replace an unknown listener.

## Chrome opens or steals focus once

Chrome can show a one-time consent transition on first contact. Start Chrome yourself, choose the profile you want to use, and run `open-computer-use warm-browser`. The warm-up restores the previously foreground application. Normal task tabs should then remain inactive.

## Wrong account or session

The runtime uses the profile of the already-running Chrome instance. Switch Chrome profiles before the task, or use a dedicated profile. Clean incognito and simultaneous multi-account isolation are not available in v0.1.

## Native action is rejected

Background input may be unavailable when the target window is on another macOS Space, minimized, or implemented with controls that do not expose usable accessibility actions. Move the window to the current Space without focusing it, unminimize it, and retry. The operator intentionally does not fall back to foreground input.

## Preview is blank or missing

Verify iTerm2 is in `/Applications`, then run `open-computer-use preview probe`. Approve the iTerm2 Automation prompt if macOS shows it. The preview is only created when Claude Code is running inside iTerm2 and `ITERM_SESSION_ID` is present.

## Collecting a report

Include the output of `open-computer-use doctor --deep`, macOS/Chrome/iTerm2/Claude Code versions, reproduction steps, and redacted broker logs. Never attach raw HAR, storage, heap, or trace artifacts without reviewing them for credentials and personal data.
