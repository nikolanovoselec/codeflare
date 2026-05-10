#!/usr/bin/env bash
# PreToolUse hook - denies tool calls that should route through context-mode.
#
# Implements REQ-AGENT-005 (strict routing variant). Tier-gated via the
# R2 preseed filter: this script ships only when the entire
# plugins/context-mode/ subtree is included for the user's tier+mode.
#
#   Bash whitelist:     git, mkdir, rm, mv, cd, ls, npm install, pip install
#   Tool block:         WebFetch, Grep
#
# Per-segment scanning: the command is split on shell chain operators
# (;, &&, ||, |, &) and EACH segment's first word must be whitelisted.
# Closes the bypass where 'cd /tmp && tail x' would pass because the
# first word is allowed but the chained command is not.
#
# Bypass (USER ONLY, never invoked by the assistant):
#   touch /tmp/ctx-bypass
#
# Known limitations (accept, document, work around with the bypass file):
#   - Heredoc bodies (<<EOF ... EOF) containing chain operators trigger
#     fallback to first-word-only check. Detected via '<<' prefix.
#   - Quoted strings containing chain operators (e.g. git commit -m
#     "use && for chaining") trigger false-split; first segment is
#     git (allowed) but the rest looks like a new command.
#   - Literal newlines mid-command are not treated as separators, so
#     'git status\ntail x' allows. Backslash-continued multi-line
#     commands work normally because they stay one segment.
#
# Fail-safe: any unexpected error returns exit 0 (no enforcement) so a
# malformed input or missing jq never locks the user out.

set -e

[[ -f "/tmp/ctx-bypass" ]] && exit 0

INPUT=$(cat)

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

# Check one command segment's first word against the whitelist.
# Strips env-var assignments and outer parens before extracting the
# first word. Calls emit_deny on violation; returns 0 on success.
check_segment() {
  local segment="$1"
  # Empty or whitespace-only segment - nothing to enforce.
  if [[ -z "${segment// }" ]]; then
    return 0
  fi
  # Strip outer parens for subshells: '(cmd args)' -> 'cmd args'.
  segment=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*\((.+)\)[[:space:]]*$/\1/')
  # Strip leading env-var assignments: 'FOO=bar BAZ=qux cmd' -> 'cmd'.
  segment=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)+//')
  local first
  first=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*//' | awk 'NR==1 {print $1; exit}')
  # An empty first word after stripping is treated as no-op (e.g. a
  # trailing separator like 'git log;').
  [[ -z "$first" ]] && return 0
  case "$first" in
    git|mkdir|rm|mv|cd|ls)
      return 0
      ;;
    curl|wget)
      emit_deny "Bash '$first' violates <context_window_protection> routing. For URL fetches use ctx_fetch_and_index(url, source) then ctx_search(queries) - the page is indexed in the sandbox and only a 3KB preview enters context. Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
      ;;
    npm)
      local second
      second=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*//' | awk 'NR==1 {print $2; exit}')
      if [[ "$second" == "install" || "$second" == "i" || "$second" == "ci" ]]; then
        return 0
      fi
      emit_deny "npm '$second' violates <context_window_protection> routing. Only 'npm install/i/ci' allowed in Bash; use ctx_execute for the rest. Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
      ;;
    pip|pip3)
      local second
      second=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*//' | awk 'NR==1 {print $2; exit}')
      if [[ "$second" == "install" ]]; then
        return 0
      fi
      emit_deny "$first '$second' violates <context_window_protection> routing. Only '$first install' allowed in Bash; use ctx_execute for the rest. Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
      ;;
  esac
  emit_deny "Bash '$first' violates <context_window_protection> routing. Use ctx_execute(language:\"shell\",code:\"...\") or ctx_batch_execute. Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
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
    if [[ -z "${COMMAND// }" ]]; then
      exit 0
    fi

    # Heredoc detection - if the command contains '<<' followed by a
    # non-whitespace delimiter, fall back to a single first-word check.
    # Chain operators inside the heredoc body would otherwise produce
    # spurious segments (commit messages, etc.).
    if printf '%s' "$COMMAND" | grep -qE '<<-?[^[:space:]]'; then
      check_segment "$COMMAND"
      exit 0
    fi

    # Split on shell chain operators. Use ASCII Unit Separator (\x1f)
    # as the delimiter so newlines inside the original command (from
    # backslash continuations or quoted strings) stay inside their
    # segment instead of splitting it. Longer alternatives must come
    # first so '&&' matches before '&' and '||' before '|'.
    SEP=$(printf '\x1f')
    SEGMENTS_STR=$(printf '%s' "$COMMAND" | sed -E "s/(&&|\\|\\||;|\\||&)/$SEP/g")
    mapfile -t -d "$SEP" SEGMENTS_ARR < <(printf '%s' "$SEGMENTS_STR")
    for SEGMENT in "${SEGMENTS_ARR[@]}"; do
      check_segment "$SEGMENT"
    done

    exit 0
    ;;
  *)
    exit 0
    ;;
esac
