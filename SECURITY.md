# Security

## What this software can reach

The extension runs with `debugger` and `<all_urls>` permissions inside your real browser profile. Anything Claude Code asks it to do happens with your cookies and logged-in sessions. The `api_*` tools can write session cookies and bearer tokens to `custom_apis/<slug>/auth.json` in plaintext. The optional sidecar runs `claude -p` on your machine with the browser tools attached.

Install it only on a machine you control, keep `custom_apis/` and `recordings/` out of version control (the `.gitignore` already does this), and read the Security section of the README before enabling the sidecar.

## Reporting a vulnerability

Open a GitHub issue with the title prefixed `[security]` describing the problem and how to reproduce it. Do not include captured credentials, cookies or recordings in the report. If the issue would let a web page or another local process drive the browser or read credentials without the user's involvement, say so in the first line so it can be prioritized.
