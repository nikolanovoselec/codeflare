# No-VSIX Claude sidebar contract

This directory holds the RED contract and inert interfaces for the Claude sidebar selected by REQ-IDE-005. It does not contain an Anthropic VSIX or a working adapter.

The sidebar must use a fresh `0700` configuration root. Only the explicit projection allowlist may link back to approved terminal-side configuration; the projection must never copy credential bytes. Terminal transcripts, resumable sessions, runtime state, source settings, telemetry state, and unknown entries stay out of the sidebar root. Sidebar settings come from the fixed root-owned path `/etc/codeflare/claude-sidebar/settings.json`.

Claude's hook runner treats a timeout and every non-2 hook failure as fail-open. The configured native permission rules are therefore an independent approval layer, not a fallback implemented by the hook. The hook returns an interactive `ask` decision during normal operation and reserves exit 2 for bounded internal-failure output.
