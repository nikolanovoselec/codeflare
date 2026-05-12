#!/usr/bin/env bash
# PreToolUse hook - denies tool calls that should route through context-mode.
#
# R2 preseed filter: this script ships only when the entire
# plugins/context-mode/ subtree is included for the user's tier+mode.
#
#   Bash whitelist:     git, mkdir, rm, mv, cd, ls, npm install, pip install
#   Tool block:         WebFetch, Grep
#
# Normalization pipeline before per-segment scan:
#   1. Extract $(...), <(...), >(...), and `...` substitutions as
#      additional segments joined by ';' (iterates to fixed point so
#      nested $($(...)) is fully unwrapped)
#   2. Strip heredoc bodies (lines between <<DELIM and matching DELIM)
#   3. Strip content inside '...' and "..." quoted regions
#   4. Split remaining text on shell chain operators (;, &&, ||, |, &)
#   5. Each segment's first word must be whitelisted
#
# Closes the following bypass vectors:
#   - 'cd /tmp && tail x' (chain bypass via first-word-only check)
#   - 'git x <<EOF\nbody\nEOF\n && curl evil' (heredoc bypass)
#   - 'git log $(curl evil)' (command substitution bypass)
#   - 'git diff <(curl a) <(curl b)' (process substitution bypass)
#   - 'git log `curl evil`' (backtick command substitution bypass)
#   - 'git log $(echo $(curl evil))' (nested substitution)
#   - 'git log -n $(($(curl evil) + 1))' (sub inside arithmetic)
#   - 'git log -n $((`curl evil` + 1))' (backtick inside arithmetic)
# And these false-positives:
#   - 'git log --grep="tail x ;"' (chain op inside quoted string)
#   - "git log --grep='$(curl x)'" (sub inside single-quoted literal)
#   - 'git log -n $((1+2))' (arithmetic expansion)
#   - 'git log $HOME' / 'git log ${HOME}' (parameter expansion)
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

# Extract $(...), <(...), >(...), and backtick command substitutions
# and emit them as additional ;-separated segments appended to the
# outer command. The outer occurrence is replaced with a single space
# so the surrounding tokens still parse. Rules:
#
#   - Single quotes ('...') suppress extraction; their content is a
#     literal string in bash so '$(...)' is not a command sub.
#   - Double quotes ("...") do NOT suppress extraction; "$(...)" is
#     executed at runtime.
#   - $((arith)) is arithmetic, not command substitution, but its
#     body IS recursively scanned for inner $(...) / backticks since
#     bash executes those at arithmetic-evaluation time and treats
#     their stdout as a numeric operand. Arithmetic-only bodies like
#     $((1+2)) stay allowed; $(($(curl x) + 1)) emits 'curl x' as a
#     separate segment that the first-word whitelist then denies.
#   - Backslash inside double quotes escapes the next character so
#     '\"' inside "..." is not a quote terminator.
#   - Iterates to a fixed point so nested $($(...)) and `` `$(...)` ``
#     are fully unwrapped into independently checkable segments.
#   - Multi-line substitutions (where $(... spans newlines) are an
#     acceptable false-negative; agent commands are single-line in
#     practice, the runtime would also reject malformed multi-line
#     subs at parse time.
#
# Output: one line per input line. If extractions were made, the line
# ends with ' ; <ext1>;<ext2>;...' so the chain-op splitter downstream
# pulls each extracted command out as its own segment.
extract_subs() {
  awk '
    function extract_pass(input,   out, extras, n, i, c, depth, j,
                                   content, in_sq, in_dq, inner_sq,
                                   inner_dq, cc, arith_body,
                                   saved_found) {
      out = ""
      extras = ""
      n = length(input)
      i = 1
      RESULT_FOUND = 0
      in_sq = 0
      in_dq = 0
      while (i <= n) {
        c = substr(input, i, 1)
        # Backslash escape inside double quotes
        if (in_dq && c == "\\" && i < n) {
          out = out c substr(input, i+1, 1)
          i += 2
          continue
        }
        # Single quote toggle (only outside double quotes)
        if (!in_dq && c == "\047") {
          in_sq = !in_sq
          out = out c
          i++
          continue
        }
        # Inside single quotes: pass through unchanged
        if (in_sq) {
          out = out c
          i++
          continue
        }
        # Double quote toggle (extraction stays active inside)
        if (c == "\"") {
          in_dq = !in_dq
          out = out c
          i++
          continue
        }
        # Arithmetic expansion $((...)) - keep the arithmetic shell
        # in place, but recursively scan its body for inner command
        # substitutions. Bash DOES execute $(cmd) and `cmd` inside
        # $((...)) - the inner stdout is parsed as numeric and used
        # as an operand. Without this recursion the body would be
        # opaque pass-through and an inner $(curl evil) would bypass
        # the first-word whitelist. Detection: $ followed by ( ( .
        if (c == "$" && i+2 <= n \
                     && substr(input, i+1, 1) == "(" \
                     && substr(input, i+2, 1) == "(") {
          depth = 2
          j = i + 3
          while (j <= n && depth > 0) {
            cc = substr(input, j, 1)
            if (cc == "(") depth++
            else if (cc == ")") depth--
            j++
          }
          if (depth == 0) {
            arith_body = substr(input, i+3, j - i - 5)
            saved_found = RESULT_FOUND
            extract_pass(arith_body)
            out = out "$((" RESULT_OUT "))"
            extras = extras RESULT_EXTRAS
            if (RESULT_FOUND) saved_found = 1
            RESULT_FOUND = saved_found
            i = j
            continue
          }
          # Unterminated arithmetic - bash rejects this at parse time,
          # but defensively recurse on the body anyway so any inner
          # terminated $(...) / backticks are still extracted as
          # denyable segments. The outer malformed prefix passes
          # through verbatim in `out` (irrelevant once the inner sub
          # is denied; bash never runs the command).
          arith_body = substr(input, i+3, j - i - 3)
          saved_found = RESULT_FOUND
          extract_pass(arith_body)
          out = out substr(input, i, j - i)
          extras = extras RESULT_EXTRAS
          if (RESULT_FOUND) saved_found = 1
          RESULT_FOUND = saved_found
          i = j
          continue
        }
        # Command/process substitution: $(...), <(...), >(...)
        if ((c == "$" || c == "<" || c == ">") \
             && i+1 <= n && substr(input, i+1, 1) == "(") {
          depth = 1
          j = i + 2
          content = ""
          inner_sq = 0
          inner_dq = 0
          while (j <= n && depth > 0) {
            cc = substr(input, j, 1)
            if (inner_dq && cc == "\\" && j < n) {
              content = content cc substr(input, j+1, 1)
              j += 2
              continue
            }
            if (!inner_dq && cc == "\047") {
              inner_sq = !inner_sq
            } else if (!inner_sq && cc == "\"") {
              inner_dq = !inner_dq
            } else if (!inner_sq && !inner_dq) {
              if (cc == "(") {
                depth++
              } else if (cc == ")") {
                depth--
                if (depth == 0) break
              }
            }
            content = content cc
            j++
          }
          if (depth == 0) {
            extras = extras content ";"
            out = out " "
            i = j + 1
            RESULT_FOUND = 1
            continue
          }
          # Unterminated - pass through unchanged
          out = out c
          i++
          continue
        }
        # Backtick command substitution
        if (c == "`") {
          j = i + 1
          content = ""
          while (j <= n) {
            cc = substr(input, j, 1)
            if (cc == "\\" && j < n) {
              content = content substr(input, j+1, 1)
              j += 2
              continue
            }
            if (cc == "`") break
            content = content cc
            j++
          }
          if (j <= n && substr(input, j, 1) == "`") {
            extras = extras content ";"
            out = out " "
            i = j + 1
            RESULT_FOUND = 1
            continue
          }
          # Unterminated - pass through
          out = out c
          i++
          continue
        }
        out = out c
        i++
      }
      RESULT_OUT = out
      RESULT_EXTRAS = extras
    }
    {
      line = $0
      extras_accum = ""
      # Repeatedly scan the outer line until no more subs found.
      while (1) {
        extract_pass(line)
        line = RESULT_OUT
        extras_accum = extras_accum RESULT_EXTRAS
        if (!RESULT_FOUND) break
      }
      # Then scan accumulated extras for nested subs to a fixed point.
      while (1) {
        if (length(extras_accum) == 0) break
        extract_pass(extras_accum)
        new_clean = RESULT_OUT
        new_extras = RESULT_EXTRAS
        if (!RESULT_FOUND) break
        extras_accum = new_clean new_extras
      }
      if (length(extras_accum) > 0) {
        print line " ; " extras_accum
      } else {
        print line
      }
    }
  '
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
      if (t == delim) {
        in_hd = 0; delim = ""; dash = 0
        # Emit a chain separator so a post-heredoc command becomes
        # its own segment. Closes the multi-line heredoc bypass:
        #   git x <<EOF
        #   body
        #   EOF
        #   curl evil
        # Without this, the post-EOF line concatenates into the
        # opener segment (first word git -> allowed) and curl
        # never gets checked.
        print ";"
      }
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
  first=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*//' | awk '{ if (NF > 0) { print $1; exit } }')
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
      second=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*//' | awk '{ if (NF > 0) { print $2; exit } }')
      if [[ "$second" == "install" || "$second" == "i" || "$second" == "ci" ]]; then
        return 0
      fi
      emit_deny "npm '$second' violates <context_window_protection> routing. Only 'npm install/i/ci' allowed in Bash; use ctx_execute for the rest. Bypass: ask user to run 'touch /tmp/ctx-bypass' - do not create yourself."
      ;;
    pip|pip3)
      local second
      second=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]*//' | awk '{ if (NF > 0) { print $2; exit } }')
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

    # Extract substitutions first: $(...), <(...), >(...), `...`.
    # These execute commands hidden inside argument expansion of an
    # outer whitelisted command, e.g. 'git log $(curl evil)'. Each
    # extracted body is appended as a ;-separated segment so the
    # per-segment scan below covers it.
    EXTRACTED=$(printf '%s' "$COMMAND" | extract_subs)

    # Normalize: strip heredoc bodies + quoted content, leaving only
    # shell-structural text. Chain operators inside quoted strings or
    # heredoc bodies are removed by this pass, so the per-segment scan
    # operates on real command boundaries.
    NORMALIZED=$(printf '%s' "$EXTRACTED" | normalize_command)

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
