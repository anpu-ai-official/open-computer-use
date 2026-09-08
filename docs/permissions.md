# macOS permissions

Open Computer Use needs Accessibility to inspect and operate controls, Screen Recording to capture target windows, and iTerm2 Automation for the in-terminal preview.

Run:

```bash
open-computer-use permissions
```

The command opens the relevant System Settings pages and verifies the resulting state. These approvals are attached to the signed driver identity. A stable Developer ID signature minimizes repeat prompts across upgrades.

`sudo` does not grant Transparency, Consent, and Control permissions. Do not edit the TCC database, disable system security, copy another machine's records, or turn off iTerm2 authentication. Managed enterprise Macs can use an administrator-provided PPPC profile where Apple supports it, but the project does not install one.

If approval appears enabled but the doctor still reports it missing:

1. Toggle the entry off and on in Privacy & Security.
2. Quit System Settings and restart the services with `open-computer-use restart`.
3. Run `open-computer-use doctor --deep`.
4. If the app identity changed, remove the stale entry and grant it again.
