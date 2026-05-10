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
    emit_deny "WebFetch denied by context-mode routing. Use mcp__plugin_context-mode_context-mode__ctx_fetch_and_index(url, source) then ctx_search(queries) - raw HTML never enters context. Bypass (user-only): touch /tmp/ctx-bypass."
    ;;
  Grep)
    emit_deny "Grep denied by context-mode routing. Use mcp__plugin_context-mode_context-mode__ctx_execute(language: \"shell\", code: \"grep ...\") to run in the sandbox, or ctx_search after indexing. Bypass (user-only): touch /tmp/ctx-bypass."
    ;;
  Bash)
    COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
    [[ -z "$COMMAND" ]] && exit 0

    # Block curl/wget regardless of position in the command (they may
    # appear after a `cd && ...` chain).
    if printf '%s' "$COMMAND" | grep -Eq '(^|[[:space:];|&(`])(curl|wget)([[:space:]]|$)'; then
      emit_deny "curl/wget blocked by context-mode routing. Use mcp__plugin_context-mode_context-mode__ctx_fetch_and_index(url, source) - the page is indexed in the sandbox and only a 3KB preview enters context. Bypass (user-only): touch /tmp/ctx-bypass."
    fi

    # Block inline HTTP calls in JS/Python/Node snippets passed as -c/-e.
    if printf '%s' "$COMMAND" | grep -Eq "fetch\([\"']https?:|requests\.(get|post|put|delete|patch|head)|http\.(get|request)\("; then
      emit_deny "Inline HTTP call blocked by context-mode routing. Use ctx_execute(language, code) so only stdout enters context, or ctx_fetch_and_index for plain URL fetches. Bypass (user-only): touch /tmp/ctx-bypass."
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
        emit_deny "npm subcommand '$SECOND' denied by context-mode routing. Only 'npm install' (or 'npm i' / 'npm ci') is allowed in Bash. For everything else use ctx_execute(language: \"shell\", code: \"npm ...\"). Bypass (user-only): touch /tmp/ctx-bypass."
        ;;
      pip|pip3)
        SECOND=$(printf '%s' "$COMMAND" | sed -E 's/^[[:space:]]*//' | awk 'NR==1 {print $2; exit}')
        if [[ "$SECOND" == "install" ]]; then
          exit 0
        fi
        emit_deny "$FIRST subcommand '$SECOND' denied by context-mode routing. Only '$FIRST install' is allowed in Bash. Bypass (user-only): touch /tmp/ctx-bypass."
        ;;
    esac

    emit_deny "Bash command '$FIRST' denied by context-mode routing. Bash is allowed only for: git, mkdir, rm, mv, cd, ls, npm install, pip install. Use mcp__plugin_context-mode_context-mode__ctx_execute(language: \"shell\", code: \"...\") for one command or ctx_batch_execute(commands, queries) for multiple. Bypass (user-only): touch /tmp/ctx-bypass."
    ;;
  *)
    exit 0
    ;;
esac
