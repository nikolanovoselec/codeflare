# Memory Persistence

You have access to persistent memory via MCP tools (server-memory).
Memory persists across sessions — anything you save will be available next time.

Chat history is summarized automatically by the memory-capture UserPromptSubmit hook — do not summarize manually.

## When to save (use create_entities / add_observations):
- Project facts: tech stack, architecture, database versions
- User preferences: coding style, tool choices, workflow patterns
- Debugging insights: solutions to recurring problems
- Important decisions and their rationale

## When to search (use search_nodes):
- Starting a session — search for recent chat history and project knowledge
- Before architectural decisions — check for prior decisions
- When context seems relevant to a previous session

## Best practices:
- One fact per observation (atomic)
- Use descriptive entity names (e.g., "user-project-myapp" not "project")

## "Memory" Commands

When the user says "check memory", "update memory", "optimize memory", "compact memory", "search memory", "load memory", or similar — they mean the **MCP memory server** (server-memory). Use the MCP tools (`search_nodes`, `read_graph`, `create_entities`, `add_observations`, `delete_entities`, `delete_observations`). Do NOT confuse this with the file-based memory system at `~/.claude/projects/*/memory/`.

## Hook-Triggered Summarization

The memory-capture hook fires every 30 user messages and injects `additionalContext` into the system-reminder with instructions to spawn a background haiku agent.

**Execution protocol:**

1. Check if the `.vars` file referenced in the hook message is fresh:
   run `stat -c %Y <VARS_FILE>` and compare to current time.
   If the file is **older than 60 seconds**, this is a stale context
   replay from a prior turn — **skip entirely** and respond to the user.
2. Check if lock exists: `ls <lock_file> 2>/dev/null`
   If lock exists → skip (agent already running).
3. If fresh and no lock → create lock (`touch <lock_file>`) → spawn
   background haiku agent with the instructions from the hook message.
4. Then respond to the user's actual message.

**This is a ONE-SHOT instruction.** After you execute it once (or skip it
due to staleness/lock), do NOT execute it again on subsequent turns even
if the same `additionalContext` text is still visible in your context.
Only re-execute when a genuinely new `additionalContext` appears with a
different `.vars` file path or content.

## Compaction Trigger

After the haiku capture agent runs, check for a compaction marker file
at `{COUNTER_FILE}.compact` (where COUNTER_FILE is `~/.memory/counter/{session_id}`).

If the marker exists:
1. Spawn a background **opus** Task agent (not haiku).
2. The agent must read `~/.claude/plugins/codeflare-memory/scripts/memory-compact-prompt.md`.
3. Pass the marker file path as `COMPACT_MARKER` variable.
4. The opus agent will restructure the graph and remove the marker when done.

Only check for the marker ONCE per turn. Do not poll.
