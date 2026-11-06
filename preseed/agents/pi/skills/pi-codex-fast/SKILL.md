---
name: pi-codex-fast
description: Use Pi's native Fast and Ultrafast controls for supported OpenAI models.
---

# Pi Fast and Ultrafast

Codeflare preinstalls `@calesennett/pi-codex-fast` in the image's managed Pi dependency tree. Do not run `pi install` or npm against `~/.pi/agent/npm` to enable it: that path links to the image's shared dependency cache.

Use the package's native commands in an interactive Pi session:

- `/codex-fast` toggles Fast mode.
- `/codex-ultrafast` toggles Ultrafast mode.
- Turning the active mode off restores normal requests.

The mode is stored as `pi-codex-fast.mode` (`off`, `fast`, or `ultrafast`) in Pi settings. Existing preferences are preserved; project settings can override the global mode. Do not change the user's mode unless requested.

These controls apply only to the extension's supported OpenAI models, including `openai/gpt-6.1-sol`; they do not change the provider, credentials, reasoning level, or model. Ultrafast availability depends on the selected model and the user's provider entitlement. Do not substitute `openai-codex` or treat an OAuth token as an API key.

This Pi-session extension does not configure separately hosted Operator SDK inference. Installation and source checks do not establish provider acceptance or deployed activation.
