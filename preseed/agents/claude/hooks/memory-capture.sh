#!/usr/bin/env bash
# Stop hook (async) — automatic memory capture
# Counts user messages in transcript, spawns a background sonnet agent
# every 15 new messages to summarize the conversation into MCP memory.
set -e

USER_HOME="${HOME:-/home/user}"
COUNTER_DIR="$USER_HOME/.memory/counter"
mkdir -p "$COUNTER_DIR"

# Read hook input from stdin
INPUT=$(cat)

# Extract transcript_path and session_id from stdin JSON
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null) || true
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || true

# Validate required fields
[[ -z "$TRANSCRIPT" || -z "$SESSION_ID" || ! -f "$TRANSCRIPT" ]] && exit 0

# Count user messages in transcript (~150ms on 13MB file)
CURRENT_COUNT=$(jq -r '.type' "$TRANSCRIPT" 2>/dev/null | grep -c '^user$') || CURRENT_COUNT=0

# Read counter file (line 1: last_count, line 2: last_line_offset)
COUNTER_FILE="$COUNTER_DIR/${SESSION_ID}"
if [[ -f "$COUNTER_FILE" ]]; then
    last_count=$(sed -n '1p' "$COUNTER_FILE" 2>/dev/null) || last_count=0
    last_line_offset=$(sed -n '2p' "$COUNTER_FILE" 2>/dev/null) || last_line_offset=1
    # Handle empty/malformed values
    [[ "$last_count" =~ ^[0-9]+$ ]] || last_count=0
    [[ "$last_line_offset" =~ ^[0-9]+$ ]] || last_line_offset=1
else
    last_count=0
    last_line_offset=1
fi

# Check threshold: need at least 15 new user messages
DELTA=$((CURRENT_COUNT - last_count))
[[ $DELTA -lt 15 ]] && exit 0

# Check lock — another agent may already be running for this session
LOCK_FILE="$COUNTER_DIR/${SESSION_ID}.lock"
[[ -f "$LOCK_FILE" ]] && exit 0

# Create lock file
touch "$LOCK_FILE"

# Record current transcript line count for next offset
CURRENT_LINES=$(wc -l < "$TRANSCRIPT")

# Build the agent prompt
TODAY=$(date +%Y-%m-%d)
PROMPT="You are a memory summarizer. Read the transcript file and summarize the NEW conversation.

Instructions:
1. Read the file at: $TRANSCRIPT
   Start from line $last_line_offset (skip earlier lines — already summarized).
2. Focus ONLY on lines with .type 'user' or 'assistant'. Ignore tool_use, tool_result, progress, and snapshot entries.
3. Summarize into concise observations: decisions made, problems solved, solutions found, key outcomes.
   One observation per distinct topic. Be specific and factual.
4. First try to call mcp__memory__search_nodes with query 'chat-$TODAY' to check if the entity exists.
   - If it exists: call mcp__memory__add_observations to ADD new observations to entity 'chat-$TODAY'.
   - If not found: call mcp__memory__create_entities to create entity 'chat-$TODAY' with entityType 'chat-summary' and your observations.
5. After successfully writing to memory:
   - Write '$CURRENT_COUNT' on line 1 and '$CURRENT_LINES' on line 2 to the file: $COUNTER_FILE
   - Remove the lock file: $LOCK_FILE
6. If anything fails, just remove the lock file $LOCK_FILE and exit."

# Spawn background agent — main session is not blocked (async hook)
nohup claude --model sonnet --max-turns 5 --print -p "$PROMPT" > /dev/null 2>&1 &

exit 0
