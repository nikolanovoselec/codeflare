#!/usr/bin/env bash
# PreToolUse hook -- unconditional HARD BLOCK while the memory-capture
# .vars directive is undrained. The one permitted spawn authorizes only its
# capture child; parent and unrelated child tools remain blocked.
#
# Companion to memory-capture.sh (UserPromptSubmit). When that hook fires
# and delta >= 15 it writes a .vars file at /tmp/.memory-counter/<session>.vars.
# The main agent MUST spawn `subagent_type: memory-capture` in the
# background; the exact harness-correlated child claims a session-local
# authorization and the publish transaction removes .vars only after success.
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
# No bypass file. The block clears when successful publication removes .vars.
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

HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null) || true
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
AUTH_LOCK="$COUNTER_DIR/${SESSION_ID}.capture-auth.lock"
AUTH_TTL_SEC=600
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || true
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null) || true
TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null) || true

safe_correlation_id() {
    local value="$1"
    case "$value" in
      *..* | */* | *\\*) return 0 ;;
    esac
    if [[ "$value" =~ ^[a-zA-Z0-9_-]+$ ]]; then printf '%s' "$value"; fi
    return 0
}
AGENT_ID=$(safe_correlation_id "$AGENT_ID")
TOOL_USE_ID=$(safe_correlation_id "$TOOL_USE_ID")

# Common case: no deferred capture. Remove only this session's ephemeral
# authorization; correlation never leaves the session-local counter directory.
if [[ ! -f "$VARS_FILE" ]]; then
    rm -f "$AUTH_FILE" "$AUTH_LOCK"
    exit 0
fi

# Every create/bind/claim/expiry transition is serialized. PreToolUse records
# the parent spawn's tool_use_id; the authoritative SubagentStart event binds
# that pending invocation to the actual child agent_id. No identifier-equality
# assumption, prompt token, or first-arriving-child guess authorizes a caller.
exec 9>"$AUTH_LOCK"
AUTH_LOCKED=0
flock -w 2 -x 9 || AUTH_LOCKED=$?

write_auth() {
    local state="$1" temporary="${AUTH_FILE}.tmp.$$"
    (umask 077; printf '%s\n' "$state" > "$temporary") && mv -f "$temporary" "$AUTH_FILE"
}

if (( AUTH_LOCKED == 0 )) && [[ -f "$AUTH_FILE" ]]; then
    AUTH_AGE=$(($(date +%s) - $(stat -c %Y "$AUTH_FILE" 2>/dev/null || echo 0)))
    if (( AUTH_AGE >= AUTH_TTL_SEC )); then
        rm -f "$AUTH_FILE"
    fi
fi

# Exactly one harness-identified memory-capture spawn may create the pending
# authorization. Missing identity, replay and concurrent contenders fail closed.
if (( AUTH_LOCKED == 0 )) && [[ "$TOOL_NAME" == "Task" || "$TOOL_NAME" == "Agent" ]]; then
    SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null) || true
    if [[ "$SUBAGENT_TYPE" == "memory-capture" && -n "$TOOL_USE_ID" && ! -f "$AUTH_FILE" ]]; then
        write_auth "pending:$TOOL_USE_ID"
        exit 0
    fi
fi

# Bind the actual child only from the authoritative child-start event. The
# event carries both the parent invocation and the newly assigned child id.
if [[ "$HOOK_EVENT" == "SubagentStart" ]]; then
    if (( AUTH_LOCKED == 0 )) && [[ -n "$TOOL_USE_ID" && -n "$AGENT_ID" && "$AGENT_TYPE" == "memory-capture" && -f "$AUTH_FILE" ]]; then
        AUTH_STATE=$(cat "$AUTH_FILE" 2>/dev/null || true)
        if [[ "$AUTH_STATE" == "pending:$TOOL_USE_ID" ]]; then
            write_auth "bound:$AGENT_ID"
        fi
    fi
    exit 0
fi

# The child may claim only its exact bound identity. Atomic lock ownership
# prevents two first calls or an unrelated capture child from racing the
# transition. Subsequent calls require the exact consumed claim.
if (( AUTH_LOCKED == 0 )) && [[ -n "$AGENT_ID" && "$AGENT_TYPE" == "memory-capture" && -f "$AUTH_FILE" ]]; then
    AUTH_STATE=$(cat "$AUTH_FILE" 2>/dev/null || true)
    if [[ "$AUTH_STATE" == "bound:$AGENT_ID" ]]; then
        write_auth "claimed:$AGENT_ID"
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
automatically only after the subagent's merge/publication transaction removes .vars.

  Task tool:
    subagent_type: "memory-capture"
    run_in_background: true
    description: "Drain deferred memory capture"
    prompt: |
      PROMPT_FILE=$PROMPT_FILE
      VARS_FILE=$VARS_FILE

The subagent retains $VARS_FILE until one locked command merges and publishes
the graph, then removes the carrier. Frontmatter pins the model to sonnet
(AD58); do NOT pass a model override.
EOF
exit 2
