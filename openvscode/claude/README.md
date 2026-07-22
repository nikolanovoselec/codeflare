# Claude sidebar runtime

These files support the Claude backend in Codeflare's owned OpenVSCode extension. They do not contain Anthropic's VSIX.

`prepare-sidebar-config.sh` recreates `/tmp/codeflare-sidebar/claude/config` before every PTY process. The root is mode 0700. It links only `.credentials.json`, `CLAUDE.md`, `agents`, `commands`, `plugins`, and `skills` from the terminal-side config when those entries exist. `settings.json` points to the root-owned `/etc/codeflare/claude-sidebar/settings.json`. Terminal projects, history, session state, logs, caches, telemetry, source settings, and unknown entries are not projected. `.codeflare-projection.json` records projection schema version 1 without credential bytes.

`sidebar-settings.json` keeps Claude in Manual mode and forces native ask rules for edit, write, notebook edit, Bash, Task, network, and MCP tools. Bypass and auto modes, Remote Control, IDE extension auto-install, updates, and nonessential telemetry are disabled. `pre-tool-use-permission.mjs` adds a bounded PreToolUse decision. It asks for every tool except the fixed local read-only set and exits 2 on malformed input or internal failure. The native ask rules remain independent if the hook times out.

The extension starts `/usr/local/bin/claude` directly through `node-pty`, with no shell and no `--dangerously-skip-permissions`. Claude's native TUI owns permission interaction. See [`../README.md`](../README.md) for selection, lifecycle, build, and verification details.
