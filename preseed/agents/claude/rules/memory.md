# Memory Persistence

Cross-session memory in codeflare has **two read surfaces** and **one
write surface** as of the vault rollout.

| Surface | Where | Use for |
|---|---|---|
| Unified graph (preferred) | `mcp__graphify__*` tools | "What did we decide about X?" "What concepts connect Y and Z?" "What does this codebase look like?" Returns nodes from the vault + every active repo's graphify-out, merged. |
| Legacy MCP graph (read only) | `mcp__memory__search_nodes`, `read_graph`, etc. | Lookups for entities written by older sessions (pre-vault). Not written to any more. |
| Vault markdown (write side) | `/home/user/.obsidian_vault/` | New cross-session memory. The memory-capture hook writes here; user-curated notes go here too; graphify ingests on a 60s poll. |

The vault is the single source of truth for new memory; the unified
graph is the index. Treat MCP memory entries as a frozen archive — read
them when you have to, never add to them.

See [vault.md](./vault.md) for the full vault contract.

## Session Start (mandatory)

At the beginning of every conversation, before doing any work, call
`mcp__graphify__query_graph` (or `god_nodes` if you want orientation
without a specific question) with a broad query — project name,
"codeflare", the subsystem you'll be touching. This loads prior decisions,
concepts, and code structure from the unified graph.

For legacy compatibility, you may also `search_nodes` against MCP memory
once for the same broad terms — but only if the graphify query returned
nothing useful, since MCP memory entries are frozen and rarely fresher
than the vault.

## When to search the unified graph (`mcp__graphify__*`):
- Starting a session — query for recent work and project knowledge
- Before implementing any feature — check if it was discussed/attempted before
- Before architectural decisions — check for prior decisions
- When the user references a previous session ("we talked about", "remember when", "last time")
- When encountering a bug — check if it was seen and solved before
- After every `/resume` — load context for the resumed session
- When starting work on a subsystem — query for that subsystem's history
- When the user asks about project architecture, decisions, or history

## "Memory" commands

When the user says "check memory", "update memory", "optimize memory",
"compact memory", "search memory", "load memory", or similar:

- Default to the **unified graph** (`mcp__graphify__*`). It is the
  current source of cross-session memory.
- If the user explicitly says "MCP memory" or names entities by their
  legacy IDs (`chat-2026-04-...`), reach for `mcp__memory__*`.
- The file-based memory at `~/.claude/projects/*/memory/` is the
  per-user assistant memory layer and is unrelated to either of the
  above; never confuse it for either.

## Hook-Triggered Capture

The memory-capture hook fires every 15 user messages. It writes a
`.vars` file at `~/.memory/counter/{session_id}.vars` and emits
`additionalContext` pointing at the capture-agent prompt.

**Execution protocol when you see the capture hook directive:**

1. Check whether the `.vars` file referenced in the directive exists
   (`ls <vars_file>`).
2. If it EXISTS → spawn a background **sonnet** Task agent with the
   instructions from the hook message. The agent deletes the `.vars`
   file as its first step (dedup gate) and writes a markdown capture
   into `/home/user/.obsidian_vault/raw/sessions/`, then merges it
   into the unified global graph via `graphify global add`.
3. If it does NOT exist → do nothing. A previous turn already spawned
   the agent and it ran to completion.
4. Then respond to the user's actual message.

The `.vars` file is the gate. The hook creates it when it is time. The
agent deletes it immediately after reading. No other checks needed.

## Compaction Trigger

After the capture sonnet runs it may create a compaction marker at
`{COUNTER_FILE}.compact` if `raw/sessions/` exceeds 200 files.

If the marker exists:
1. Spawn a background **opus** Task agent.
2. The agent reads `~/.claude/plugins/codeflare-memory/scripts/memory-compact-prompt.md`.
3. Pass the marker file path as `COMPACT_MARKER`.
4. The opus agent summarises older session captures down and removes the marker.

Only check for the marker ONCE per turn. Do not poll.

## Vault edit hook (companion)

A separate UserPromptSubmit hook fires from `vault-monitor-hook.sh` when
the user has edited files in the vault directly (via SilverBullet or
otherwise). See [vault.md](./vault.md) for details — the agent-side
contract is symmetric to the capture protocol above.
