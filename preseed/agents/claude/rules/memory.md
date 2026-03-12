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

When a `UserPromptSubmit hook additional context` system-reminder appears, you MUST follow its instructions immediately. It runs in the background and does not block your response.
