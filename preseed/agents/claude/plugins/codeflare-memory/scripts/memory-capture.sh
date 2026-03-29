#!/usr/bin/env bash
# UserPromptSubmit hook — triggers main agent to summarize conversation into MCP memory.
# Injects additionalContext when 30+ new user messages since last summary.
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
if [[ -f "$COUNTER_FILE" ]]; then
    last_count=$(head -1 "$COUNTER_FILE" 2>/dev/null) || last_count=0
    last_line=$(tail -1 "$COUNTER_FILE" 2>/dev/null) || last_line=1
    [[ "$last_count" =~ ^[0-9]+$ ]] || last_count=0
    [[ "$last_line" =~ ^[0-9]+$ ]] || last_line=1
else
    # First run: baseline from current transcript so we don't fire on the entire history.
    last_count=$CURRENT_COUNT
    last_line=$(wc -l < "$TRANSCRIPT")
    printf '%s\n%s\n' "$last_count" "$last_line" > "$COUNTER_FILE"
fi

DELTA=$((CURRENT_COUNT - last_count))
[[ $DELTA -lt 30 ]] && exit 0

TODAY=$(date +%Y-%m-%d)
TOTAL_LINES=$(wc -l < "$TRANSCRIPT")

# Write variables to file so the additionalContext string stays short
VARS_FILE="$COUNTER_DIR/${SESSION_ID}.vars"
jq -n \
  --arg transcript "$TRANSCRIPT" \
  --arg last_line "$last_line" \
  --arg today "$TODAY" \
  --arg current_count "$CURRENT_COUNT" \
  --arg total_lines "$TOTAL_LINES" \
  --arg counter_file "$COUNTER_FILE" \
  --arg vars_file "$VARS_FILE" \
  '{transcript:$transcript,last_line:$last_line,today:$today,current_count:$current_count,total_lines:$total_lines,counter_file:$counter_file,vars_file:$vars_file}' \
  > "$VARS_FILE"

# Update counter so subsequent hook invocations see delta < 30.
# Agent reads line range from .vars, not from the counter file.
printf '%s\n%s\n' "$CURRENT_COUNT" "$TOTAL_LINES" > "$COUNTER_FILE"

# UserPromptSubmit: exit 0 with additionalContext (no blocking)
CONTEXT="Check if ${VARS_FILE} exists. If it does, spawn a background haiku agent to read ${USER_HOME}/.claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md and ${VARS_FILE}, then execute. If the file does not exist, do nothing — capture was already completed."

jq -n --arg ctx "$CONTEXT" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
exit 0
