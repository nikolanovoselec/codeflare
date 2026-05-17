# Memory Persistence

Cross-session memory lives in **one place**: the user vault at
`/home/user/Vault/`. Graphify ingests every vault file into
the unified global graph at `~/.graphify/global-graph.json`, merged with
every active repo's per-repo graphify-out. Queries go through
`mcp__graphify__*`.

See [vault.md](./vault.md) for the full vault contract.

## Session start (mandatory)

Before doing any work, call `mcp__graphify__query_graph` (or
`god_nodes` for orientation without a specific question) with a broad
query — project name, "codeflare", or the subsystem you'll be touching.
This loads prior decisions, concepts, and code structure.

## When to query the unified graph

- Starting a session, after `/resume`, or when the user references prior work.
- Before implementing any feature or making an architectural decision.
- When encountering a bug — check if it was seen before.
- When starting work on an unfamiliar subsystem.

## "Memory" commands

When the user says "check memory", "search memory", "load memory", etc.:
use `mcp__graphify__*`. The file-based memory at
`~/.claude/projects/*/memory/` is the per-user assistant memory layer
(unrelated). The legacy MCP server-memory subsystem has been removed —
do not look for `mcp__memory__*` tools.

## Hook-triggered capture

The memory-capture hook fires every 15 user messages. It writes a
`.vars` file at `~/.memory/counter/{session_id}.vars` and emits
`additionalContext` pointing at the capture-agent prompt.

Execution protocol:

1. Check whether the `.vars` file referenced in the directive exists.
2. If it EXISTS → spawn a background **haiku** Task agent with the
   hook's instructions. The agent deletes the `.vars` file first (dedup
   gate), writes a markdown capture into
   `/home/user/Vault/Raw/Sessions/`, then merges it into the
   unified global graph via `graphify global add`.
3. If it does NOT exist → do nothing.
4. Then respond to the user's actual message.

## Vault edit hook (companion)

A separate UserPromptSubmit hook fires from `vault-monitor-hook.sh`
when the user has edited vault files directly via SilverBullet. See
[vault.md](./vault.md) for the symmetric agent-side contract.
