# Memory Persistence

You have access to persistent memory via MCP tools (server-memory).
Memory persists across sessions — anything you save will be available next time.

## Chat history (IMPORTANT)
- Periodically summarize the conversation and save it to memory
- Use entity name format: `chat-YYYY-MM-DD` (e.g., `chat-2026-03-05`)
- Save a summary every ~10-15 messages or at natural breakpoints
- Include: what was discussed, decisions made, problems solved, key outcomes
- Update the same day's entity with add_observations as the conversation progresses

## When to save (use create_entities / add_observations):
- Chat summaries (see above — this is the primary use case)
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
- When read_graph shows >200 entities, review and prune stale entries
