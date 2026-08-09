#!/usr/bin/env bash
# PreToolUse hook -- unconditional HARD BLOCK while the memory-capture
# .vars directive is undrained. The one permitted spawn authorizes only its
# capture child; parent and unrelated child tools remain blocked.
#
# Companion to memory-capture.sh (UserPromptSubmit). When that hook fires
# and delta >= 15 it writes a .vars file at /tmp/.memory-counter/<session>.vars.
# The main agent MUST spawn `subagent_type: memory-capture` in the
# background; the child's first correlated tool call claims a session-local
# authorization and the subagent deletes .vars when it drains the request.
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
# No bypass file. The block clears naturally when the subagent deletes .vars.
# Correlation authorization expires after the bounded child-start window. If
# .vars is stale beyond recovery (e.g. transcript path
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

# Sanitize session_id before it is used to build any path. The sibling
# memory-context-inject.sh has done this since it was written; these two never
# did, and both interpolate it straight into /tmp paths — SESSION_ID='../../x'
# escapes the counter directory. Same guard, verbatim, so the three hooks agree.
case "$SESSION_ID" in
  *..* | */* | *\\*) exit 0 ;;
esac
[[ "$SESSION_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 0


# No session id, no enforcement (defensive — shouldn't happen in a real fire).
[[ -z "$SESSION_ID" ]] && exit 0

VARS_FILE="$COUNTER_DIR/${SESSION_ID}.vars"
AUTH_FILE="$COUNTER_DIR/${SESSION_ID}.capture-auth"
AUTH_TTL_SEC=600
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || true
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null) || true

case "$AGENT_ID" in
  *..* | */* | *\\*) AGENT_ID="" ;;
esac
[[ -z "$AGENT_ID" || "$AGENT_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || AGENT_ID=""

# Common case: no deferred capture. Remove only this session's ephemeral
# authorization; correlation never leaves the session-local counter directory.
if [[ ! -f "$VARS_FILE" ]]; then
    rm -f "$AUTH_FILE"
    exit 0
fi

if [[ -f "$AUTH_FILE" ]]; then
    AUTH_AGE=$(($(date +%s) - $(stat -c %Y "$AUTH_FILE" 2>/dev/null || echo 0)))
    if (( AUTH_AGE >= AUTH_TTL_SEC )); then
        rm -f "$AUTH_FILE"
    fi
fi

# The parent may authorize exactly one pending memory-capture invocation.
# A replay while an authorization exists is blocked below.
if [[ "$TOOL_NAME" == "Task" || "$TOOL_NAME" == "Agent" ]]; then
    SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null) || true
    if [[ "$SUBAGENT_TYPE" == "memory-capture" && ! -f "$AUTH_FILE" ]]; then
        printf 'pending\n' > "$AUTH_FILE"
        exit 0
    fi
fi

# The first identified memory-capture child claims the pending authorization.
# Subsequent calls are allowed only for that exact child. Parent calls have no
# agent_id and unrelated children cannot claim or reuse the authorization.
if [[ -n "$AGENT_ID" && "$AGENT_TYPE" == "memory-capture" && -f "$AUTH_FILE" ]]; then
    AUTH_STATE=$(cat "$AUTH_FILE" 2>/dev/null || true)
    if [[ "$AUTH_STATE" == "pending" ]]; then
        printf 'claimed:%s\n' "$AGENT_ID" > "$AUTH_FILE"
        exit 0
    fi
    if [[ "$AUTH_STATE" == "claimed:$AGENT_ID" ]]; then
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
