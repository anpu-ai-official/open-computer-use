# Privacy and security model

Open Computer Use runs locally, but computer-use data can be sensitive. This document describes the trust boundary rather than promising that arbitrary websites or applications are safe.

## Local interfaces

The MCP broker binds to `127.0.0.1` and does not intentionally expose a network service outside the Mac. The LaunchAgent runs as the logged-in user. Release archives are protected by GitHub transport plus a published SHA-256 checksum; the native app is Developer ID-signed and notarized.

The runtime itself does not call Anthropic or OpenAI APIs. Claude Code still sends the operator prompts and selected results according to Claude Code's own configuration and consumes the user's normal model allowance.

## Chrome profile access

Owned tabs run inside the user's active Chrome profile. They inherit its cookies, logins, extensions, proxy configuration, and website permissions. The browser facade prevents normal operators from adopting arbitrary existing tabs, but websites loaded in owned tabs have the same ambient profile privileges they would have if opened manually.

Use a dedicated Chrome profile for least privilege. Do not ask an agent to visit untrusted content while sensitive authenticated sessions are present unless you accept that browser-level risk.

## Artifacts and logs

HAR files can contain headers and URLs. Application snapshots can contain cookies or storage values. Heap snapshots and traces can contain page strings. Artifacts are stored locally under a temporary per-run directory by default; logs are under `~/Library/Logs/OpenComputerUse`.

Review and redact artifacts before sharing them. Delete sensitive artifacts after use. Override `CLAUDE_CUA_ARTIFACT_DIR` if you need an encrypted or managed location.

## Responsible disclosure

Do not open a public issue for a vulnerability. Follow [SECURITY.md](../SECURITY.md). Particularly important reports include cross-tab ownership escapes, unintended foreground input, non-loopback broker exposure, signature/update compromise, and secrets appearing in model output.
