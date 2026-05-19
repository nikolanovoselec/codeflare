#!/usr/bin/env bash
# UserPromptSubmit hook — triggers main agent to capture conversation into the vault.
# Injects additionalContext when 15+ new user messages since last capture.
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

# Count REAL user prompts only — messages a human actually typed.
#
# The Claude CLI writes many synthetic messages to the transcript with
# `role:"user"`, all of which the naive grep `'"type":"user"'` would
# match. Two over-counting layers to peel off:
#
#   Layer 1 — tool_result wrappers
#     `{"type":"user", message:{role:"user", content:[{type:"tool_result",...}]}}`
#     Created on every Bash, Read, Edit, etc. tool call return.
#     Distinguished by `content` being an array `[...]` instead of a string.
#     `'"role":"user","content":"'` (with trailing quote) excludes them.
#
#   Layer 2 — slash-command + task-notification wrappers
#     `{"type":"user", message:{role:"user", content:"<local-command-caveat>..."}}`
#     `{"type":"user", message:{role:"user", content:"<command-name>/foo</command-name>"}}`
#     `{"type":"user", message:{role:"user", content:"<command-message>...</command-message>"}}`
#     `{"type":"user", message:{role:"user", content:"<command-args>...</command-args>"}}`
#     `{"type":"user", message:{role:"user", content:"<local-command-stdout>..."}}`
#     `{"type":"user", message:{role:"user", content:"<task-notification>..."}}`
#     Plus any record with `isMeta: true`.
#     All of these have string content but start with a `<` tag.
#     `[^<]` after the opening quote excludes them.
#
# Empirical test (4124-line aa375f82 transcript):
#   old grep '"type":"user"'                       → 1451 (counts everything)
#   '"role":"user","content":"'                    →  241 (string-only, includes synthetic)
#   '"role":"user","content":"[^<]'                →   83 (real human prompts) ✓
#
# All observed `isMeta:true` records in the transcript also have content
# starting with `<` (they ARE the slash-command wrappers), so the Layer 1
# `[^<]` filter already excludes them. No second-pass isMeta subtraction
# needed; an earlier draft of this fix tried it with the wrong field
# order and produced 0 anyway.
# DO NOT drop the `|| CURRENT_COUNT=0` tail. `set -e` is active (line 5) and
# `grep -c` exits 1 when the pattern has zero matches (legitimate on a fresh
# transcript). Without the fallback the hook crashes silently inside Claude
# Code with no user-visible error.
CURRENT_COUNT=$(grep -c '"role":"user","content":"[^<]' "$TRANSCRIPT") || CURRENT_COUNT=0

COUNTER_FILE="$COUNTER_DIR/${SESSION_ID}"
MEMORY_SCAN=""
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
    # First message — nudge graphify-based context lookup against the unified vault graph.
    MEMORY_SCAN="BEFORE responding, query the unified graph for context. Use mcp__graphify__query_graph (or mcp__graphify__get_node for a known concept) with terms from the user's message to surface prior decisions, vault notes, and per-repo references."
fi

DELTA=$((CURRENT_COUNT - last_count))
if [[ $DELTA -lt 15 ]]; then
    # No capture needed, but still emit memory scan directive if set
    if [[ -n "$MEMORY_SCAN" ]]; then
        jq -n --arg ctx "$MEMORY_SCAN" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
    fi
    exit 0
fi

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

# Update counter so subsequent hook invocations see delta < 15.
# Agent reads line range from .vars, not from the counter file.
printf '%s\n%s\n' "$CURRENT_COUNT" "$TOTAL_LINES" > "$COUNTER_FILE"

# UserPromptSubmit: exit 0 with additionalContext (no blocking)
CONTEXT="Check if ${VARS_FILE} exists. If it does, spawn the **memory-capture** subagent (Task tool with subagent_type=\"memory-capture\") in the background. Pass PROMPT_FILE=${USER_HOME}/.claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md and VARS_FILE=${VARS_FILE}; the subagent reads both and executes the contract documented in the prompt file. The subagent's frontmatter pins the model to sonnet (AD58); do not pass a model override. If the .vars file does not exist, do nothing - capture was already completed."

# Append memory scan directive if set (first message)
if [[ -n "$MEMORY_SCAN" ]]; then
    CONTEXT="${MEMORY_SCAN} ${CONTEXT}"
fi

jq -n --arg ctx "$CONTEXT" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
exit 0
