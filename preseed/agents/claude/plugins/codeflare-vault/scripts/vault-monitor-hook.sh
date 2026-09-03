#!/usr/bin/env bash
# UserPromptSubmit hook (REQ-MEMORY-102).
#
# Picks up the marker written by memory-capture.sh when a resumed-session or
# 20-prompt content-hash check finds Vault changes, then signals the main agent
# to spawn a background sonnet that runs vault-extract-prompt.md.
#
# Zero-cost on idle prompts: if the marker is missing (the common case,
# >99% of prompts) we exit 0 immediately with no output, so nothing is
# injected into the agent's context.
#
# Concurrency: the spawned sonnet deletes the marker as its first step
# (vault-extract-prompt.md Step 1) so a subsequent prompt arriving while
# extraction is in flight does not re-trigger. Failed work leaves the durable
# manifest unchanged and a later eligible hash check rediscovers it.
set -e

USER_HOME="${HOME:-/home/user}"
HOOK_CACHE="$USER_HOME/.cache/codeflare-hooks"
VARS_FILE="$HOOK_CACHE/vault-extract.vars"
LAST_MARKER="$HOOK_CACHE/vault-extract.last"
PROMPT_FILE="$USER_HOME/.claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md"

# Drain stdin (Claude Code sends JSON payload on UserPromptSubmit).
cat >/dev/null 2>&1 || true

# Fast path: no marker, nothing to do.
[ -f "$VARS_FILE" ] || exit 0

# Stale-marker guard. A later eligible prompt can hash-check while extraction
# is finishing and write a marker for bytes the successful manifest already
# covers. Once the agent advances LAST_MARKER, that older marker must not
# dispatch another no-op extraction.
#
# Invariant: VARS_FILE is only valid if it is newer than LAST_MARKER.
# When it is not, the work is already done; delete the stale marker and
# exit silently.
#
# Edge cases:
#   - First-ever boot: LAST_MARKER does not exist yet. The short-circuit
#     `[ -f "$LAST_MARKER" ]` skips this guard so the first real trigger
#     still fires.
#   - Mtime equality (same filesystem-second): `-nt` is strict newer-than,
#     so VARS_FILE touched in the same second as LAST_MARKER is stale. A later
#     eligible content-hash check rediscovers any uncommitted bytes.
#   - Producer atomicity: memory-capture.sh writes via a tempfile + `mv`, so
#     the hook never sees a partially-written marker.
if [ -f "$LAST_MARKER" ] && [ ! "$VARS_FILE" -nt "$LAST_MARKER" ]; then
    rm -f "$VARS_FILE" 2>/dev/null || true
    exit 0
fi

# In-flight guard: prevent re-emitting while an extraction agent is
# already running. Created here, deleted by the agent in step 7.
# 30-minute TTL: real extraction runs measured at ~18 min on large change
# sets (30+ files); the previous 5-minute TTL expired mid-run, so the hook
# treated a live run as crashed and dispatched a second concurrent agent
# that raced the first on the shared chunk file. A genuinely crashed run
# now delays re-extraction by up to 30 min; the daemon's high-water-mark
# re-detection makes that eventual, not lost.
IN_FLIGHT="$HOOK_CACHE/vault-extract.in-flight"
if [ -f "$IN_FLIGHT" ]; then
    IN_FLIGHT_AGE=$(($(date +%s) - $(stat -c %Y "$IN_FLIGHT" 2>/dev/null || echo 0)))
    if [ "$IN_FLIGHT_AGE" -lt 1800 ]; then
        exit 0
    fi
    rm -f "$IN_FLIGHT"
fi
touch "$IN_FLIGHT"

CONTEXT="Vault changes detected. Spawn the **vault-extract** subagent (Task tool with subagent_type=\"vault-extract\") in the background. Pass PROMPT_FILE=${PROMPT_FILE} and VARS_FILE=${VARS_FILE}."

jq -n --arg ctx "$CONTEXT" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
exit 0
