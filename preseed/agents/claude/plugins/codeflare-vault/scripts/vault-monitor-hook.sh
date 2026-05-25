#!/usr/bin/env bash
# UserPromptSubmit hook (REQ-MEMORY-102).
#
# Picks up the marker file written by the vault-monitor daemon
# (entrypoint.sh:start_vault_monitor_daemon) and signals the main agent
# to spawn a background sonnet that runs vault-extract-prompt.md.
#
# Zero-cost on idle prompts: if the marker is missing (the common case,
# >99% of prompts) we exit 0 immediately with no output, so nothing is
# injected into the agent's context.
#
# Concurrency: the spawned sonnet deletes the marker as its first step
# (vault-extract-prompt.md Step 1) so a subsequent prompt arriving while
# extraction is in flight does not re-trigger. If the sonnet crashes
# before deleting, the next daemon tick (60s) will re-detect the same
# changes and rewrite the marker - eventual consistency, no work lost.
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

# Stale-marker guard. The daemon ticks every 60s; an extraction run
# typically takes 30-60s on sonnet. The overlap window can still occur:
# during a run the daemon's `[ -f VARS_FILE ]` check sees the file
# deleted (sonnet step 1) and `find -newer LAST_MARKER` still returns
# the original files (sonnet hasn't touched LAST_MARKER yet), so the
# daemon writes a fresh VARS_FILE. When the sonnet eventually finishes
# and touches LAST_MARKER, that VARS_FILE is left behind - older than
# LAST_MARKER - and would trigger a spurious additional sonnet on the
# next user prompt with nothing new to extract.
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
#     so VARS_FILE touched in the same second as LAST_MARKER is treated
#     as stale. Worst case is one missed extraction tick; the daemon will
#     re-discover the same files on the next 60s tick and rewrite the
#     marker with a fresh mtime. No data loss.
#   - Daemon atomicity: the daemon writes VARS_FILE via a tempfile + `mv`
#     in entrypoint.sh:start_vault_monitor_daemon, so the hook never sees
#     a partially-written marker.
if [ -f "$LAST_MARKER" ] && [ ! "$VARS_FILE" -nt "$LAST_MARKER" ]; then
    rm -f "$VARS_FILE" 2>/dev/null || true
    exit 0
fi

# In-flight guard: prevent re-emitting while an extraction agent is
# already running. Created here, deleted by the agent in step 7.
# 5-minute TTL covers the longest reasonable extraction run.
IN_FLIGHT="$HOOK_CACHE/vault-extract.in-flight"
if [ -f "$IN_FLIGHT" ]; then
    IN_FLIGHT_AGE=$(($(date +%s) - $(stat -c %Y "$IN_FLIGHT" 2>/dev/null || echo 0)))
    if [ "$IN_FLIGHT_AGE" -lt 300 ]; then
        exit 0
    fi
    rm -f "$IN_FLIGHT"
fi
touch "$IN_FLIGHT"

CONTEXT="Vault changes detected. Spawn the **vault-extract** subagent (Task tool with subagent_type=\"vault-extract\") in the background. Pass PROMPT_FILE=${PROMPT_FILE} and VARS_FILE=${VARS_FILE}."

jq -n --arg ctx "$CONTEXT" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
exit 0
