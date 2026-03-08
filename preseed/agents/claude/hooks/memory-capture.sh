#!/usr/bin/env bash
# UserPromptSubmit hook — triggers main agent to summarize conversation into MCP memory.
# Injects additionalContext when 15+ new user messages since last summary.
# The main agent spawns a background Task agent to do the actual work.
set -e

USER_HOME="${HOME:-/home/user}"
COUNTER_DIR="$USER_HOME/.memory/counter"
mkdir -p "$COUNTER_DIR"

INPUT=$(cat)

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
if [[ -f "$LOCK_FILE" ]]; then
    # Stale lock guard: if lock is older than 2 minutes, agent likely crashed — remove and proceed
    LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0) ))
    [[ $LOCK_AGE -lt 120 ]] && exit 0
    rm -f "$LOCK_FILE"
fi

TODAY=$(date +%Y-%m-%d)
TOTAL_LINES=$(wc -l < "$TRANSCRIPT")

# Write variables to file so the reason string stays short
VARS_FILE="$COUNTER_DIR/${SESSION_ID}.vars"
jq -n \
  --arg transcript "$TRANSCRIPT" \
  --arg last_line "$last_line" \
  --arg today "$TODAY" \
  --arg current_count "$CURRENT_COUNT" \
  --arg total_lines "$TOTAL_LINES" \
  --arg counter_file "$COUNTER_FILE" \
  --arg lock_file "$LOCK_FILE" \
  '{transcript:$transcript,last_line:$last_line,today:$today,current_count:$current_count,total_lines:$total_lines,counter_file:$counter_file,lock_file:$lock_file}' \
  > "$VARS_FILE"

# UserPromptSubmit: exit 0 with additionalContext (no blocking)
CONTEXT="Spawn a background haiku Task agent. Create ${LOCK_FILE} before spawning. Agent must read ${USER_HOME}/.claude/hooks/memory-agent-prompt.md and ${VARS_FILE}, then execute."

jq -n --arg ctx "$CONTEXT" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
exit 0
