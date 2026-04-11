# Memory Persistence

You have access to persistent memory via MCP tools (server-memory).
Memory persists across sessions — anything you save will be available next time.

Chat history is summarized automatically by the memory-capture UserPromptSubmit hook — do not summarize manually.

## Session Start (mandatory)

At the beginning of every conversation, before doing any work, call
`search_nodes` with a broad query (e.g., project name, "codeflare",
"recent") to load prior context from previous sessions. This is not
optional — it ensures continuity across sessions and prevents re-asking
questions that were already answered.

## When to save (use create_entities / add_observations):
- Project facts: tech stack, architecture, database versions
- User preferences: coding style, tool choices, workflow patterns
- Debugging insights: solutions to recurring problems
- Important decisions and their rationale

## When to search (use search_nodes):
- Starting a session — search for recent chat history and project knowledge
- Before implementing any feature — check if it was discussed or attempted before
- Before architectural decisions — check for prior decisions
- When the user references a previous session ("we talked about", "remember when", "last time")
- When encountering a bug — check if it was seen and solved before
- After every `/resume` — load context for the resumed session
- When starting work on a subsystem (billing, terminal, storage, memory) — search for that subsystem's history
- When the user asks about project architecture, decisions, or history

## Best practices:
- One fact per observation (atomic)
- Use descriptive entity names (e.g., "user-project-myapp" not "project")

## "Memory" Commands

When the user says "check memory", "update memory", "optimize memory", "compact memory", "search memory", "load memory", or similar — they mean the **MCP memory server** (server-memory). Use the MCP tools (`search_nodes`, `read_graph`, `create_entities`, `add_observations`, `delete_entities`, `delete_observations`). Do NOT confuse this with the file-based memory system at `~/.claude/projects/*/memory/`.

## Hook-Triggered Summarization

The memory-capture hook fires every 30 user messages and injects
`additionalContext` into the system-reminder with instructions to spawn
a background sonnet agent. The hook handles all counting and gating —
it only emits when it's time.

**Execution protocol:**

1. See the hook instruction in `additionalContext` → check if the
   `.vars` file referenced in the message exists (`ls <vars_file>`).
2. If the file EXISTS → spawn a background sonnet agent with the
   instructions from the hook message. The agent deletes the `.vars`
   file as its first step, preventing duplicate spawns.
3. If the file does NOT exist → do nothing. Capture was already done.
4. Then respond to the user's actual message.

The `.vars` file is the gate. The hook creates it when it's time to
capture. The agent deletes it immediately after reading. No other
checks needed.

## Compaction Trigger

After the sonnet capture agent runs, check for a compaction marker file
at `{COUNTER_FILE}.compact` (where COUNTER_FILE is `~/.memory/counter/{session_id}`).

If the marker exists:
1. Spawn a background **opus** Task agent (not sonnet).
2. The agent must read `~/.claude/plugins/codeflare-memory/scripts/memory-compact-prompt.md`.
3. Pass the marker file path as `COMPACT_MARKER` variable.
4. The opus agent will restructure the graph and remove the marker when done.

Only check for the marker ONCE per turn. Do not poll.
