# Memory

Cross-session memory lives in `/home/user/Vault/` (the persistent user-curatable note store, synced session-to-session via rclone bisync). Graphify ingests every vault file into the unified global graph at `~/.graphify/global-graph.json`, merged with every active repo's per-repo graphify-out.

## Session start

Before any work, call `mcp__graphify__query_graph` (or `god_nodes` for orientation without a specific question) with a broad query - project name or subsystem you'll be touching. Loads prior decisions, concepts, and code structure.

## When user asks about memory

User says "check memory", "search memory", "load memory", "what do you remember about X" -> use `mcp__graphify__*` against the unified graph. The file-based `~/.claude/projects/*/memory/` is the per-user assistant memory layer (unrelated).

## Vault operations

Any tool call inside `/home/user/Vault/`, or any user prompt referencing vault contents -> invoke the `vault-operations` skill for layout, who-writes-where rules, wikilink convention, and the NEVER list. The skill auto-surfaces on vault-shaped tasks; load it explicitly before mid-task writes inside the vault tree.

For "take a note" / "note this down" / "save this" / similar phrases, [vault-note-capture.md](./vault-note-capture.md) routes to the `vault-note-capture` skill instead.

## Hook-triggered capture (every 50 user messages)

`memory-capture.sh` fires every 50 real user messages and immediately on the first prompt with an uncaptured resumed-session tail. It writes a `.vars` carrier and launches the detached capture runner itself; the main agent does not dispatch or wait. The carrier remains until locked cumulative merge and `user_vault` publication succeed.

Sonnet (not haiku) because capture must cite REQ IDs / ADRs / commit SHAs verbatim; haiku confabulated adjacent IDs in benchmarking. See AD58 for rationale.

## Vault-edit hook (vault-extract subagent)

Memory cadence owns Vault detection: every resumed-tail capture and each crossed 100-real-user-prompt epoch performs a content-hash check. `vault-monitor-hook.sh` dispatches `subagent_type: vault-extract` (sonnet) only when that check wrote a changed-content marker. No polling extraction daemon runs; unchanged checks are silent no-ops.
