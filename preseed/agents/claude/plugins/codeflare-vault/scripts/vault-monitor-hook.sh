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
# changes and rewrite the marker — eventual consistency, no work lost.
set -e

USER_HOME="${HOME:-/home/user}"
HOOK_CACHE="$USER_HOME/.cache/codeflare-hooks"
VARS_FILE="$HOOK_CACHE/vault-extract.vars"
PROMPT_FILE="$USER_HOME/.claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md"

# Drain stdin (Claude Code sends JSON payload on UserPromptSubmit).
cat >/dev/null 2>&1 || true

# Fast path: no marker, nothing to do.
[ -f "$VARS_FILE" ] || exit 0

CONTEXT="Vault changes detected. Spawn a background sonnet agent to read ${PROMPT_FILE} and ${VARS_FILE}, then execute the 5-step contract. The sonnet deletes ${VARS_FILE} as its first step. If you have already spawned this agent in the current turn, do nothing."

jq -n --arg ctx "$CONTEXT" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
exit 0
