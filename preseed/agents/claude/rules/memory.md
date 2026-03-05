# Memory Persistence

You have access to persistent memory via MCP tools (server-memory).
Memory persists across sessions — anything you save will be available next time.

## Chat history (IMPORTANT)
- Every ~10-15 messages or at natural breakpoints, spawn a background Haiku agent to summarize
- The agent should summarize only NEW conversation since the last summary (not the full chat)
- Use entity name format: `chat-YYYY-MM-DD` (e.g., `chat-2026-03-05`)
- Update the same day's entity with add_observations as the conversation progresses
- Background agent prompt example:
  ```
  Summarize the following conversation excerpt into concise observations.
  Focus on: what was discussed, decisions made, problems solved, key outcomes.
  Then call the memory MCP tool add_observations on entity "chat-YYYY-MM-DD"
  (create it first if it doesn't exist). One observation per distinct topic.
  Do NOT repeat observations already saved — only add what's new.
  ```

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

## Compaction (when memory grows large)
- At session start, spawn a background Haiku agent to call read_graph and check entity count
- If >200 entities, the agent should compact:
  ```
  Read the full memory graph with read_graph. Consolidate it:
  1. Merge chat-* entities older than 7 days into "chat-archive-YYYY-MM"
     (combine observations into high-level summaries, delete originals)
  2. Merge redundant/overlapping observations on the same entity
  3. Delete entities that are no longer relevant (stale project facts,
     resolved bugs, outdated preferences)
  Use delete_entities and delete_observations to clean up, then
  create_entities/add_observations for consolidated entries.
  Target: reduce to under 100 entities.
  ```

## Best practices:
- One fact per observation (atomic)
- Use descriptive entity names (e.g., "user-project-myapp" not "project")
