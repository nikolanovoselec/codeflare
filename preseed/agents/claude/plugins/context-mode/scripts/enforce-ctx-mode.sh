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
# Normalization pipeline before per-segment scan:
#   1. Strip heredoc bodies (lines between <<DELIM and matching DELIM)
#   2. Strip content inside '...' and "..." quoted regions
#   3. Split remaining text on shell chain operators (;, &&, ||, |, &)
#   4. Each segment's first word must be whitelisted
#
# Closes two bypass vectors:
#   - 'cd /tmp && tail x' (chain bypass via first-word-only check)
#   - 'git x <<EOF\nbody\nEOF\n && curl evil' (heredoc bypass)
# And one false-positive:
#   - 'git log --grep="tail x ;"' (chain op inside quoted string)
#
# Bypass (USER ONLY, never invoked by the assistant):
#   touch /tmp/ctx-bypass
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

# Strip heredoc bodies and quoted content via awk state machine.
# Reads command on stdin, writes normalized command to stdout.
normalize_command() {
  awk '
    BEGIN { in_hd = 0; delim = ""; dash = 0 }
    in_hd {
      t = $0
      if (dash) sub(/^[ \t]+/, "", t)
      if (t == delim) { in_hd = 0; delim = ""; dash = 0 }
      next
    }
    {
      line = $0
      if (match(line, /<<-?[\047"]?[A-Za-z_][A-Za-z0-9_]*[\047"]?/)) {
        marker = substr(line, RSTART, RLENGTH)
        before = substr(line, 1, RSTART - 1)
        after = substr(line, RSTART + RLENGTH)
        dash = (substr(marker, 1, 3) == "<<-") ? 1 : 0
        d = marker
        sub(/^<<-?[\047"]?/, "", d)
        sub(/[\047"]?$/, "", d)
        delim = d
        in_hd = 1
        line = before " " after
      }
      out = ""
      n = length(line)
      i = 1
      while (i <= n) {
        c = substr(line, i, 1)
        if (c == "\047") {
          j = i + 1
          while (j <= n && substr(line, j, 1) != "\047") j++
          out = out "QQ"
          if (j > n) break
          i = j + 1
        } else if (c == "\"") {
          j = i + 1
          while (j <= n) {
            cj = substr(line, j, 1)
            if (cj == "\\") { j += 2; continue }
            if (cj == "\"") break
            j++
          }
          out = out "QQ"
          if (j > n) break
          i = j + 1
        } else {
          out = out c
          i++
        }
      }
      print out
    }
  '
}

# Check one command segment's first word against the whitelist.
# Strips env-var assignments and outer parens before extracting the
# first word. Calls emit_deny on violation; returns 0 on success.
check_segment() {
  local segment="$1"
  if [[ -z "${segment// }" ]]; then
    return 0
  fi
  segment=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*\((.+)\)[[:space:]]*$/\1/')
  segment=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)+//')
  local first
  first=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*//' | awk 'NR==1 {print $1; exit}')
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

    # Normalize: strip heredoc bodies + quoted content, leaving only
    # shell-structural text. Chain operators inside quoted strings or
    # heredoc bodies are removed by this pass, so the per-segment scan
    # operates on real command boundaries.
    NORMALIZED=$(printf '%s' "$COMMAND" | normalize_command)

    SEP=$(printf '\x1f')
    SEGMENTS_STR=$(printf '%s' "$NORMALIZED" | sed -E "s/(&&|\\|\\||;|\\||&)/$SEP/g")
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
