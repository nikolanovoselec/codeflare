# Memory

Cross-session memory lives in `/home/user/Vault/` (see [vault.md](./vault.md)). Graphify ingests every vault file into the unified global graph at `~/.graphify/global-graph.json`, merged with every active repo's per-repo graphify-out.

## Session start

Before any work, call `mcp__graphify__query_graph` (or `god_nodes` for orientation without a specific question) with a broad query — project name or subsystem you'll be touching. Loads prior decisions, concepts, and code structure.

## When user asks about memory

User says "check memory", "search memory", "load memory", "what do you remember about X" → use `mcp__graphify__*` against the unified graph. The file-based `~/.claude/projects/*/memory/` is the per-user assistant memory layer (unrelated).

## Hook-triggered capture

The memory-capture hook fires every 15 user messages and emits a directive pointing at a `.vars` file.

- If the `.vars` file exists → spawn a background **sonnet** Task agent with the hook's instructions. Agent's first step deletes the `.vars` file (dedup gate).
- If it does not exist → do nothing.

Sonnet (not haiku) because capture must cite REQ IDs / ADRs / commit SHAs verbatim; haiku confabulated adjacent IDs in benchmarking. See AD58 for rationale.

## Vault edit hook (companion)

`vault-monitor-hook.sh` fires on direct user vault edits. Same protocol; see [vault.md](./vault.md).
