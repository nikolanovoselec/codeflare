#!/usr/bin/env bash
# PreToolUse hook -- HARD BLOCK if the memory-capture .vars directive is undrained.
#
# Companion to memory-capture.sh (UserPromptSubmit). When that hook fires and
# delta >= 15 it writes a .vars file at ~/.memory/counter/<session>.vars. The
# main agent is supposed to spawn `subagent_type: memory-capture` in the
# background; the subagent's first step deletes .vars (dedup gate).
#
# Pre-this-hook behaviour: if the agent ignored the additionalContext
# directive, .vars sat undrained and the next 14 user prompts were below
# threshold so no fresh fire happened -- entire sessions silently went
# without a capture.
#
# This hook closes that gap. While .vars exists, every tool call other than
# `Task(subagent_type=memory-capture)` is hard-blocked (exit 2) with a clear
# instruction to spawn the subagent. The agent cannot Read/Write/Edit/Bash/
# anything else until the deferred capture is drained.
#
# Bypass: `touch /tmp/memory-capture-bypass` (user-only escape hatch, one-shot,
# auto-deleted on the next hook fire). Use only when the .vars file is stale
# beyond recovery (e.g. transcript path moved).
set -e

USER_HOME="${HOME:-/home/user}"
COUNTER_DIR="$USER_HOME/.memory/counter"
BYPASS_FILE="/tmp/memory-capture-bypass"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || true
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || true

# No session id, no enforcement (defensive — shouldn't happen in a real fire).
[[ -z "$SESSION_ID" ]] && exit 0

VARS_FILE="$COUNTER_DIR/${SESSION_ID}.vars"

# Common case: no deferred capture, allow the tool call.
[[ ! -f "$VARS_FILE" ]] && exit 0

# Bypass: one-shot user override.
if [[ -f "$BYPASS_FILE" ]]; then
    rm -f "$BYPASS_FILE"
    echo "[memory-capture-block] bypass consumed: $BYPASS_FILE removed, .vars left for next attempt" >&2
    exit 0
fi

# Allow the memory-capture subagent itself.
if [[ "$TOOL_NAME" == "Task" ]]; then
    SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null) || true
    if [[ "$SUBAGENT_TYPE" == "memory-capture" ]]; then
        exit 0
    fi
fi

# Everything else: HARD BLOCK with a directive the agent cannot ignore.
PROMPT_FILE="$USER_HOME/.claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md"
VARS_AGE_SEC=$(($(date +%s) - $(stat -c %Y "$VARS_FILE" 2>/dev/null || echo 0)))

cat >&2 <<EOF
HARD BLOCK: memory-capture subagent has not been spawned.

A deferred memory-capture directive is sitting in $VARS_FILE
(age: ${VARS_AGE_SEC}s). The UserPromptSubmit hook emitted a spawn directive
earlier this turn or in a prior turn and the subagent never ran -- so .vars
has not been drained.

You MUST spawn the memory-capture subagent BEFORE any other tool call.

  Task tool:
    subagent_type: "memory-capture"
    run_in_background: true
    description: "Drain deferred memory capture"
    prompt: |
      PROMPT_FILE=$PROMPT_FILE
      VARS_FILE=$VARS_FILE

The subagent's first step deletes $VARS_FILE (dedup gate). Once deleted,
this hook unblocks and your subsequent tool calls proceed normally. The
subagent's frontmatter pins the model to sonnet (AD58); do NOT pass a
model override.

User-only bypass (use sparingly, only if .vars is stale beyond recovery):
  touch $BYPASS_FILE
EOF
exit 2
