#!/usr/bin/env bash
# Stop hook — triggers main agent to summarize conversation into MCP memory.
# Outputs a reminder when 15+ new user messages since last summary.
# The main agent spawns a background Task agent to do the actual work.
set -e

USER_HOME="${HOME:-/home/user}"
COUNTER_DIR="$USER_HOME/.memory/counter"
mkdir -p "$COUNTER_DIR"

INPUT=$(cat)

# Don't loop — if we already triggered a summary, let Claude stop
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null) || true
[[ "$STOP_ACTIVE" == "true" ]] && exit 0

TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null) || true
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || true
TRANSCRIPT="${TRANSCRIPT/#\~/$USER_HOME}"
[[ -z "$TRANSCRIPT" || -z "$SESSION_ID" || ! -f "$TRANSCRIPT" ]] && exit 0

CURRENT_COUNT=$(jq -r '.type' "$TRANSCRIPT" 2>/dev/null | grep -c '^user$') || CURRENT_COUNT=0

COUNTER_FILE="$COUNTER_DIR/${SESSION_ID}"
last_count=0
last_line=1
if [[ -f "$COUNTER_FILE" ]]; then
    last_count=$(head -1 "$COUNTER_FILE" 2>/dev/null) || last_count=0
    last_line=$(tail -1 "$COUNTER_FILE" 2>/dev/null) || last_line=1
    [[ "$last_count" =~ ^[0-9]+$ ]] || last_count=0
    [[ "$last_line" =~ ^[0-9]+$ ]] || last_line=1
fi

DELTA=$((CURRENT_COUNT - last_count))
[[ $DELTA -lt 15 ]] && exit 0

LOCK_FILE="$COUNTER_DIR/${SESSION_ID}.lock"
[[ -f "$LOCK_FILE" ]] && exit 0

TODAY=$(date +%Y-%m-%d)
TOTAL_LINES=$(wc -l < "$TRANSCRIPT")

# Tell the main agent to spawn a background task for memory capture
cat << EOF
Spawn a background haiku Task agent to summarize this conversation into MCP memory.
Tell it: read ${TRANSCRIPT} from line ${last_line}, summarize into entity chat-${TODAY}, then write ${CURRENT_COUNT} and ${TOTAL_LINES} to ${COUNTER_FILE} (one per line).
Create ${LOCK_FILE} before spawning. Agent must rm -f ${LOCK_FILE} when done.
EOF
