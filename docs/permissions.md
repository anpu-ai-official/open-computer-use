# macOS permissions

Open Computer Use needs Accessibility to inspect and operate controls, Screen Recording to capture target windows, and iTerm2 Automation for the in-terminal preview.

Run:

```bash
open-computer-use permissions
```

The command opens the relevant System Settings pages and verifies the resulting state. These approvals are attached to the driver identity. The free release uses an ad-hoc signature, so an upgrade that changes the driver may require the approvals again. A future stable Developer ID signature can reduce repeat prompts.

Gatekeeper approval is separate. If macOS reports that Apple cannot check the driver or that it is from an unidentified developer, try opening `~/Applications/OpenComputerUseDriver.app`, then choose **Open Anyway** in **System Settings → Privacy & Security**. Do not disable Gatekeeper globally.

`sudo` does not grant Transparency, Consent, and Control permissions. Do not edit the TCC database, disable system security, copy another machine's records, or turn off iTerm2 authentication. Managed enterprise Macs can use an administrator-provided PPPC profile where Apple supports it, but the project does not install one.

If approval appears enabled but the doctor still reports it missing:

1. Toggle the entry off and on in Privacy & Security.
2. Quit System Settings and restart the services with `open-computer-use restart`.
3. Run `open-computer-use doctor --deep`.
4. If the app identity changed, remove the stale entry and grant it again.
