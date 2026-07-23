# Official Claude Code IDE configuration

These files configure Anthropic's official Claude Code extension without modifying its package.

`prepare-sidebar-config.sh` prepares `/tmp/codeflare-sidebar/claude/config` before Claude OpenVSCode launches. The mode-0700 root links only `.credentials.json`, `CLAUDE.md`, `agents`, `commands`, `plugins`, and `skills` from the terminal-side config when those entries exist. `settings.json` points to the root-owned `/etc/codeflare/claude-sidebar/settings.json`. Terminal projects, history, session state, logs, caches, telemetry, source settings, and unknown entries are not projected. The marker records projection schema version 1 without credential bytes. A valid existing projection survives an OpenVSCode restart so official-extension conversations remain available inside that IDE lifecycle.

The preparer atomically restores the ephemeral OpenVSCode user settings before every launch or restart. They point the bundled official CLI at the isolated `CLAUDE_CONFIG_DIR`, use Anthropic's native graphical panel in the right sidebar, start in Anthropic Manual (`"default"`) permission mode, suppress external login because Codeflare supplies approved credentials/routing, and disallow bypass mode.

`sidebar-settings.json` independently forces native ask rules for edit, write, notebook edit, Bash, Task, network, and MCP tools. Bypass and automatic modes, Remote Control, IDE auto-install, updates, and nonessential telemetry are disabled. `pre-tool-use-permission.mjs` allows only the fixed local read-only set plus Anthropic's read-only `mcp__ide__getDiagnostics`; every mutation, including `mcp__ide__executeCode`, asks. Malformed input or internal failure exits 2.

Anthropic's official extension owns its loopback-only authenticated IDE MCP transport, native diffs, selection context, and panel lifecycle. Codeflare adds no relay or listener. See [`../README.md`](../README.md) for package pinning, selection, process isolation, and complete-image verification.
