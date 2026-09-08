# Security policy

## Supported versions

Until the first stable release, only the latest commit on `main` and the newest published preview release receive security fixes.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** private security-advisory flow for this repository. If that option is unavailable, contact the maintainers through the organization profile without including exploit details in public.

Please include the affected version or commit, macOS and Chrome versions, reproduction steps, impact, and a minimal proof of concept. Remove credentials and personal data. We will acknowledge a complete report when maintainers are available, coordinate remediation and disclosure, and credit reporters who want attribution.

Do not open public issues for suspected cross-tab access, focus-safety bypasses, local broker exposure, arbitrary command execution, update/signing compromise, or sensitive artifact leakage.

## Scope notes

Websites opened by an agent, third-party Chrome extensions, Claude Code, Chrome, iTerm2, macOS, and the upstream Cua project have their own security boundaries. Reports are still welcome when Open Computer Use composes those systems unsafely.
