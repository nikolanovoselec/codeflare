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

# Strip heredoc bodies and quoted content via a char-by-char awk
# state machine. Quote state (in_sq, in_dq) persists across lines so
# multi-line quoted strings are handled correctly. Heredoc openers
# are recognized ONLY when scanned outside any active quote - this
# closes the bypass where '<<EOF' appearing inside a quoted argument
# would otherwise enter heredoc mode and eat subsequent lines.
normalize_command() {
  awk '
    BEGIN { in_hd = 0; delim = ""; dash = 0; in_sq = 0; in_dq = 0 }
    in_hd {
      t = $0
      if (dash) sub(/^[ \t]+/, "", t)
      if (t == delim) { in_hd = 0; delim = ""; dash = 0 }
      next
    }
    {
      line = $0
      out = ""
      n = length(line)
      i = 1
      while (i <= n) {
        c = substr(line, i, 1)
        if (in_sq) {
          if (c == "\047") { out = out "QQ"; in_sq = 0 }
          i++
          continue
        }
        if (in_dq) {
          if (c == "\\") { i += 2; continue }
          if (c == "\"") { out = out "QQ"; in_dq = 0 }
          i++
          continue
        }
        if (c == "\047") { in_sq = 1; i++; continue }
        if (c == "\"") { in_dq = 1; i++; continue }
        if (c == "<" && i < n && substr(line, i+1, 1) == "<") {
          ps = i + 2
          pd = 0
          if (ps <= n && substr(line, ps, 1) == "-") { pd = 1; ps++ }
          pq = ""
          if (ps <= n && (substr(line, ps, 1) == "\047" || substr(line, ps, 1) == "\"")) {
            pq = substr(line, ps, 1); ps++
          }
          d = ""
          while (ps <= n) {
            ch = substr(line, ps, 1)
            if (ch ~ /[A-Za-z0-9_]/) { d = d ch; ps++ } else { break }
          }
          if (length(d) > 0) {
            if (pq != "" && ps <= n && substr(line, ps, 1) == pq) ps++
            delim = d
            dash = pd
            in_hd = 1
            i = ps
            continue
          }
        }
        out = out c
        i++
      }
      # If we ended the line still inside a quoted region, the quote
      # spans multiple lines - keep state for next record. Otherwise
      # emit any final placeholder for the closed region.
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
  # Strip leading and trailing subshell-group parens. Handles both the
  # wrapped form '(cmd args)' and the split-by-chain-op form where
  # '(cmd1; cmd2)' becomes segments '(cmd1' and ' cmd2)'.
  segment=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*\(+[[:space:]]*//')
  segment=$(printf '%s' "$segment" | sed -E 's/[[:space:]]*\)+[[:space:]]*$//')
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

    # Neutralize file-descriptor redirects so embedded '&' is not
    # mistaken for a background-or-chain operator. Covers 2>&1, >&3,
    # <&0, >&-, &>file, &>>file, &|. Replaced with spaces (preserves
    # spacing so per-segment first-word extraction is unaffected).
    NORMALIZED=$(printf '%s' "$NORMALIZED" | sed -E 's/[0-9]*[<>]&[0-9]+|[0-9]*[<>]&-|&>>?|&\|/ /g')

    SEP=$(printf '\x1f')
    SEGMENTS_STR=$(printf '%s' "$NORMALIZED" | sed -E "s/(&&|\\|\\||;|\\||&)/$SEP/g")
    # Portable to Bash 3.2 (no mapfile -d). The trailing OR test
    # ensures we still process the segment after the final SEP.
    SEGMENTS_ARR=()
    while IFS= read -r -d "$SEP" SEGMENT || [[ -n "$SEGMENT" ]]; do
      SEGMENTS_ARR+=("$SEGMENT")
    done < <(printf '%s' "$SEGMENTS_STR")
    for SEGMENT in "${SEGMENTS_ARR[@]}"; do
      check_segment "$SEGMENT"
    done

    exit 0
    ;;
  *)
    exit 0
    ;;
esac
