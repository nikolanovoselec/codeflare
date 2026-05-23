#!/usr/bin/env bash
# PreToolUse hook -- unconditional HARD BLOCK while the memory-capture
# .vars directive is undrained.
#
# Companion to memory-capture.sh (UserPromptSubmit). When that hook fires
# and delta >= 15 it writes a .vars file at ~/.memory/counter/<session>.vars.
# The main agent MUST spawn `subagent_type: memory-capture` in the
# background; the subagent's first step deletes .vars (dedup gate).
#
# Pre-this-hook behaviour: if the agent ignored the additionalContext
# directive, .vars sat undrained and the next 14 user prompts were below
# threshold so no fresh fire happened -- entire sessions silently went
# without a capture.
#
# This hook closes that gap with stop-hook semantics (same shape as the
# review-agent enforcement hook): while .vars exists, every tool call
# other than `Task(subagent_type=memory-capture)` is hard-blocked (exit 2)
# with a clear instruction to spawn the subagent. The agent cannot
# Read/Write/Edit/Bash/anything else until the deferred capture is drained.
#
# No bypass file. The block clears naturally when the subagent runs and
# deletes .vars. If .vars is stale beyond recovery (e.g. transcript path
# moved), delete it manually: `rm ~/.memory/counter/*.vars`.
set -e

USER_HOME="${HOME:-/home/user}"
COUNTER_DIR="$USER_HOME/.memory/counter"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || true
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || true

# No session id, no enforcement (defensive — shouldn't happen in a real fire).
[[ -z "$SESSION_ID" ]] && exit 0

VARS_FILE="$COUNTER_DIR/${SESSION_ID}.vars"

# Common case: no deferred capture, allow the tool call.
[[ ! -f "$VARS_FILE" ]] && exit 0

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
This block is unconditional. There is no bypass file. The block clears
automatically the moment the subagent runs and deletes .vars.

  Task tool:
    subagent_type: "memory-capture"
    run_in_background: true
    description: "Drain deferred memory capture"
    prompt: |
      PROMPT_FILE=$PROMPT_FILE
      VARS_FILE=$VARS_FILE

The subagent's first step deletes $VARS_FILE (dedup gate). Frontmatter
pins the model to sonnet (AD58); do NOT pass a model override.
EOF
exit 2
