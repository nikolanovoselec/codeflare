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

## Hook-Triggered Summarization (MANDATORY)

The memory-capture hook fires periodically and injects `UserPromptSubmit hook additional context: Spawn a background haiku Task agent...` into the system-reminder.

**Execution protocol — do this FIRST, before responding to the user:**

1. Extract the lock file path from the hook message
2. Check if lock exists: `ls <lock_file> 2>/dev/null`
3. If lock exists → skip (agent already running)
4. If no lock → create lock (`touch <lock_file>`) → spawn background haiku agent with the instructions from the hook message
5. Then respond to the user's actual message

**DO NOT ignore this hook.** It is a system-level directive, not optional context.

**DO NOT re-trigger** when no fresh `additionalContext` arrived in the current turn. The message can persist in context from prior turns — only act on it when it appears as part of the CURRENT user message's system-reminders.
