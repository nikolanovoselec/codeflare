# Memory

Cross-session memory lives in `/home/user/Vault/` (the persistent user-curatable note store, synced session-to-session via rclone bisync). Graphify ingests every vault file into the unified global graph at `~/.graphify/global-graph.json`, merged with every active repo's per-repo graphify-out.

## Session start

Before any work, call `mcp__graphify__query_graph` (or `god_nodes` for orientation without a specific question) with a broad query - project name or subsystem you'll be touching. Loads prior decisions, concepts, and code structure.

## When user asks about memory

User says "check memory", "search memory", "load memory", "what do you remember about X" -> use `mcp__graphify__*` against the unified graph. The file-based `~/.claude/projects/*/memory/` is the per-user assistant memory layer (unrelated).

## Vault operations

Any tool call inside `/home/user/Vault/`, or any user prompt referencing vault contents -> invoke the `vault-operations` skill for layout, who-writes-where rules, wikilink convention, and the NEVER list. The skill auto-surfaces on vault-shaped tasks; load it explicitly before mid-task writes inside the vault tree.

For "take a note" / "note this down" / "save this" / similar phrases, [vault-note-capture.md](./vault-note-capture.md) routes to the `vault-note-capture` skill instead.

## Hook-triggered capture (every 15 user messages)

`memory-capture.sh` (UserPromptSubmit hook) fires every 15 user messages and emits a directive pointing at a `.vars` file.

- If the `.vars` file exists -> spawn a background `subagent_type: memory-capture` (sonnet) with the hook's instructions. The subagent's first step deletes the `.vars` file (dedup gate).
- If it does not exist -> do nothing.

Sonnet (not haiku) because capture must cite REQ IDs / ADRs / commit SHAs verbatim; haiku confabulated adjacent IDs in benchmarking. See AD58 for rationale.

## Vault-edit hook (vault-extract subagent)

`vault-monitor-hook.sh` (UserPromptSubmit hook, paired with a 60s daemon that polls `~/Vault/` for changes and writes the `.vars` directive) fires on direct user vault edits. Same `.vars` directive protocol, but spawns `subagent_type: vault-extract` (sonnet) which reads the recent change, chunks it, and merges into `/home/user/Vault/graphify-out/vault-graph.json` then `graphify global add ... --as user_vault` updates the unified global graph.
