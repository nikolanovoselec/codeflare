# Global Graph

Interactive force-directed visualization of the unified graph: every active repo's `graphify-out/` plus the entire vault, merged via `graphify global add` and tagged per-source (`user_vault` for the vault, `<owner>/<repo>` for each cloned repo). Concept nodes (`[[wikilinks]]`) deduplicate by exact label across all sources.

[Open global graph viz](global-graph.html)

Source data: `~/.graphify/global-graph.json` (lives under your home directory, not in the vault — same data the `mcp__graphify__*` MCP tools query).

## What you'll see

- Vault pages and per-repo code symbols side by side, connected by shared concept nodes.
- A wikilink `[[VaultMonitorDaemon]]` mentioned in a vault note unifies with a `vault_monitor_daemon` function node from a per-repo graph **only** when the labels match exactly - case-sensitive, no normalisation (see `~/.claude/skills/vault-operations/SKILL.md` for the dedup contract).
- Active repos contribute via the `graphify-active-repo` PostToolUse hook; the vault contributes via the vault-monitor 60s daemon.

## Notes

This page is preseeded by codeflare on first boot and is free for you to edit afterwards — your edits will not be overwritten on subsequent boots.
