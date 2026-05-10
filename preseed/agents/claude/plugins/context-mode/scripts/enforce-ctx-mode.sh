#!/usr/bin/env bash
# PreToolUse hook - denies tool calls that should route through context-mode.
#
# Implements REQ-AGENT-005 (strict routing variant). Tier-gated via the
# R2 preseed filter: this script ships only when the entire
# plugins/context-mode/ subtree is included for the user's tier+mode.
#
#   Bash whitelist:     git, mkdir, rm, mv, cd, ls, npm install, pip install
#   Bash content block: curl, wget, inline fetch/requests/http calls
#   Tool block:         WebFetch, Grep
#
# Bypass (USER ONLY, never invoked by the assistant):
#   touch /tmp/ctx-bypass
#
# Fail-safe: any unexpected error returns exit 0 (no enforcement) so a
# malformed input or missing jq never locks the user out.

set -e

# Bypass sentinel - user-only escape hatch.
[[ -f "/tmp/ctx-bypass" ]] && exit 0

INPUT=$(cat)

# jq missing or malformed input - fail open.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0

emit_deny() {
  jq -n --arg reason "$1" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $reason
    }
  }'
  exit 0
}

case "$TOOL_NAME" in
  WebFetch)
    emit_deny "WebFetch violates <context_window_protection> routing. Use ctx_fetch_and_index(url, source) then ctx_search(queries). Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
    ;;
  Grep)
    emit_deny "Grep violates <context_window_protection> routing. Use ctx_execute(language:\"shell\",code:\"grep ...\") or ctx_search. Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
    ;;
  Bash)
    COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
    [[ -z "$COMMAND" ]] && exit 0

    # Block curl/wget regardless of position in the command (they may
    # appear after a `cd && ...` chain).
    if printf '%s' "$COMMAND" | grep -Eq '(^|[[:space:];|&(`])(curl|wget)([[:space:]]|$)'; then
      emit_deny "curl/wget violates <context_window_protection> routing. Use ctx_fetch_and_index(url, source). Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
    fi

    # Block inline HTTP calls in JS/Python/Node snippets passed as -c/-e.
    if printf '%s' "$COMMAND" | grep -Eq "fetch\([\"']https?:|requests\.(get|post|put|delete|patch|head)|http\.(get|request)\("; then
      emit_deny "Inline HTTP violates <context_window_protection> routing. Use ctx_execute(language, code) or ctx_fetch_and_index. Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
    fi

    # Extract the first command word (strip leading whitespace, take
    # text up to the first whitespace).
    FIRST=$(printf '%s' "$COMMAND" | sed -E 's/^[[:space:]]*//' | awk 'NR==1 {print $1; exit}')

    case "$FIRST" in
      git|mkdir|rm|mv|cd|ls)
        exit 0
        ;;
      npm)
        SECOND=$(printf '%s' "$COMMAND" | sed -E 's/^[[:space:]]*//' | awk 'NR==1 {print $2; exit}')
        if [[ "$SECOND" == "install" || "$SECOND" == "i" || "$SECOND" == "ci" ]]; then
          exit 0
        fi
        emit_deny "npm '$SECOND' violates <context_window_protection> routing. Only 'npm install/i/ci' allowed in Bash; use ctx_execute for the rest. Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
        ;;
      pip|pip3)
        SECOND=$(printf '%s' "$COMMAND" | sed -E 's/^[[:space:]]*//' | awk 'NR==1 {print $2; exit}')
        if [[ "$SECOND" == "install" ]]; then
          exit 0
        fi
        emit_deny "$FIRST '$SECOND' violates <context_window_protection> routing. Only '$FIRST install' allowed in Bash; use ctx_execute for the rest. Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
        ;;
    esac

    emit_deny "Bash '$FIRST' violates <context_window_protection> routing. Use ctx_execute(language:\"shell\",code:\"...\") or ctx_batch_execute. Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
    ;;
  *)
    exit 0
    ;;
esac
