# Memory Summarization Agent Prompt

You are a memory summarization agent. Execute these steps using the provided variables.

## Variables (provided by the caller)

- `TRANSCRIPT`: path to the conversation JSONL file
- `LAST_LINE`: line offset to start reading from
- `TODAY`: date string (YYYY-MM-DD) for the entity name
- `CURRENT_COUNT`: user message count to write to counter
- `TOTAL_LINES`: transcript line count to write to counter
- `COUNTER_FILE`: path to the counter file
- `LOCK_FILE`: path to the lock file

## Steps

### 1. Summarize

Read `TRANSCRIPT` from line `LAST_LINE` using the Read tool with `offset` and `limit: 500`. If the file has more lines, continue reading in 500-line chunks until `TOTAL_LINES`. Summarize NEW content into concise observations:

- One observation per distinct topic
- Merge related facts into single observations
- Skip trivial events (routine syncs, test runs, counting, CI confirmations)
- Max 5-8 observations per summary window
- Do NOT repeat observations already saved

### 2. Save to MCP memory

Search for entity `chat-{TODAY}`. If it exists, use `add_observations` with only NEW observations. If not, use `create_entities` with entityType `chat-summary`.

### 3. Compaction check

Call `read_graph` and count total observations across ALL entities. If total exceeds 300, compact the entire graph to ~100 observations:

- Merge `chat-*` entities older than 3 days into `chat-archive-YYYY-MM` (combine into high-level summaries, delete originals)
- Merge redundant/overlapping observations on the same entity
- Delete stale, resolved, or trivial observations
- Preserve: project architecture, user preferences, active decisions, recent chat summaries (last 3 days)

### 4. Write counter

```
printf '{CURRENT_COUNT}\n{TOTAL_LINES}\n' > {COUNTER_FILE}
```

### 5. Cleanup

```
rm -f {LOCK_FILE}
```
