#!/usr/bin/env bash
# PreToolUse hook -- unconditional HARD BLOCK while the memory-capture
# .vars directive is undrained.
#
# Companion to memory-capture.sh (UserPromptSubmit). When that hook fires
# and delta >= 15 it writes a .vars file at /tmp/.memory-counter/<session>.vars.
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
# moved), delete it manually: `rm /tmp/.memory-counter/*.vars`. On container
# recycle /tmp is wiped by Cloudflare Containers contract, so stale .vars
# cannot survive a session restart.
#
# COUNTER_DIR must match memory-capture.sh's MEMCAP_COUNTER_DIR resolution
# (defaults to /tmp/.memory-counter; production never overrides).
set -e

USER_HOME="${HOME:-/home/user}"
COUNTER_DIR="${MEMCAP_COUNTER_DIR:-/tmp/.memory-counter}"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || true
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || true

# No session id, no enforcement (defensive — shouldn't happen in a real fire).
[[ -z "$SESSION_ID" ]] && exit 0

VARS_FILE="$COUNTER_DIR/${SESSION_ID}.vars"
SENTINEL="/tmp/.memory-capture-in-flight.${SESSION_ID}"
SENTINEL_TTL_SEC=600  # 10 min — subagent runtime budget

# Common case: no deferred capture, allow the tool call. (Sentinel is moot
# without a pending .vars; clean it up if it lingered past the previous run.)
if [[ ! -f "$VARS_FILE" ]]; then
    [[ -f "$SENTINEL" ]] && rm -f "$SENTINEL"
    exit 0
fi

# Allow the parent's spawn of the memory-capture subagent. The tool that
# spawns subagents is called "Task" in the legacy API and "Agent" in the
# current Claude Code harness -- accept either. Mark sentinel so the
# subagent's own tool calls (Read/Bash/Write) below are NOT blocked --
# PreToolUse fires on the subagent's calls too, and without this they'd
# be hard-blocked by the same hook the spawn just satisfied (the original
# chicken-and-egg deadlock).
if [[ "$TOOL_NAME" == "Task" || "$TOOL_NAME" == "Agent" ]]; then
    SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null) || true
    if [[ "$SUBAGENT_TYPE" == "memory-capture" ]]; then
        touch "$SENTINEL"
        exit 0
    fi
fi

# Sentinel hot: a memory-capture subagent has been spawned in this session
# within the TTL window. Let the subagent's tool calls (and any parent
# tool calls during background processing) through. The block resumes
# automatically when .vars is deleted (early-exit above) or when the
# sentinel ages out below.
if [[ -f "$SENTINEL" ]]; then
    SENTINEL_AGE=$(($(date +%s) - $(stat -c %Y "$SENTINEL" 2>/dev/null || echo 0)))
    if (( SENTINEL_AGE < SENTINEL_TTL_SEC )); then
        exit 0
    fi
    # Stale: subagent never completed -- clear and fall through to block.
    rm -f "$SENTINEL"
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
