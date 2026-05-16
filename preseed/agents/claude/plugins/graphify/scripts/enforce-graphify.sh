#!/usr/bin/env bash
# PreToolUse hook - HARD-BLOCK structural searches after 3 grep-class
# tool calls without consulting the graphify knowledge graph in the
# same turn. Complements the existing soft-nudge (graph-first-nudge.sh):
# the nudge asks politely on every grep; this gate forces the issue
# once the agent has demonstrated it is going to keep grepping without
# the graph.
#
# Matcher coverage (registered in entrypoint.sh):
#   - Grep                                                 (non-custom tier)
#   - Bash                                                 (both tiers, parsed)
#   - mcp__context-mode__ctx_execute                       (custom tier, parsed)
#   - mcp__context-mode__ctx_batch_execute                 (custom tier, parsed)
#   - mcp__context-mode__ctx_execute_file                  (custom tier, parsed)
#
# Tier coverage rationale:
#   - Non-ctx tiers: Grep fires natively. Bash with `grep ...` fires too.
#   - Custom tier: ctx-enforce denies native Grep; greps route through
#     ctx_execute*. Same shell parser handles both Bash and ctx_execute*.
#
# Structural-search classifier (per shell segment, first word):
#   grep | rg | ag | ack                  -> SEARCH
#   git grep                              -> SEARCH
#   find ... -name|-path|-iname|-ipath|-regex -> SEARCH
#   awk with /regex/ body                 -> SEARCH (heuristic)
# Native Grep tool                        -> SEARCH (no parsing)
#
# Counter (walked backward from current line in transcript to the last
# real user prompt, same discriminator as memory-capture.sh):
#   SEARCH_COUNT   = structural-search tool_use entries
#   GRAPHIFY_COUNT = mcp__graphify__* tool_use entries
#                  + Bash/ctx_execute "graphify (query|path|explain)" CLI
#
# Block decision:
#   if THIS call is SEARCH and SEARCH_COUNT >= 3 and GRAPHIFY_COUNT == 0
#     -> emit hookSpecificOutput.permissionDecision = "deny" with reason
#   else -> exit 0
#
# Bypass (USER-ONLY - agent must never invoke):
#   1. /tmp/graphify-bypass         (one-shot sentinel, auto-deleted)
#   2. "skip graph" in latest user message (case-insensitive)
#
# Gating:
#   - graphify-out/graph.json absent in active repo -> exit 0
#   - any unexpected error                          -> exit 0 (fail-safe)
#
# Active repo resolution (codeflare layout, where session cwd is always
# the parent ~/workspace and never a sub-repo):
#   1. ~/.cache/codeflare-hooks/graphify-active-cwd   (sentinel written by
#      graphify-active-repo.sh on every Bash/Edit/Write/ctx_execute tool
#      call - reflects the repo the user is currently working in)
#   2. .cwd from tool-call envelope                   (vanilla graphify
#      usage outside codeflare)
# The hook is intentionally silent on greps outside any graphified repo:
# vault-only-in-global is NOT enforcement-eligible. Only per-repo graphs
# trigger the gate, and only when one is the user's currently active repo.
set +e

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD="$PWD"

ACTIVE_REPO=""
ACTIVE_SENTINEL="${HOME:-/home/user}/.cache/codeflare-hooks/graphify-active-cwd"
# Racy-by-design read: graphify-active-repo.sh writes the sentinel via
# `printf > $SENTINEL` (single open+write+close); a torn read here just
# yields an empty string or a malformed path, both of which fall through
# to the CWD fallback below. We deliberately do not flock the read - a
# stale-by-one-tick sentinel resolves on the next tool call.
if [ -f "$ACTIVE_SENTINEL" ]; then
  # `read -r` consumes exactly the first line without a trailing newline,
  # preserving any path characters (including spaces) verbatim.
  # Newline contract: relies on graphify-active-repo.sh writing the
  # sentinel via `printf '%s\n'` (with trailing newline). Without the
  # newline, `read -r` returns non-zero on EOF and the `||` clause
  # clobbers the value to "". Writer must keep `\n`.
  read -r ACTIVE_REPO < "$ACTIVE_SENTINEL" || ACTIVE_REPO=""
fi
[ -n "$ACTIVE_REPO" ] && [ -d "$ACTIVE_REPO" ] || ACTIVE_REPO="$CWD"
[ -f "$ACTIVE_REPO/graphify-out/graph.json" ] || exit 0

# Bypass 1: one-shot sentinel (USER-only; auto-deleted on use)
if [ -f "/tmp/graphify-bypass" ]; then
  rm -f "/tmp/graphify-bypass" 2>/dev/null || true
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
TRANSCRIPT="${TRANSCRIPT/#\~/$HOME}"
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

# ---------------------------------------------------------------------------
# Parser primitives (mirror enforce-ctx-mode.sh): extract command/process/
# backtick substitutions, strip heredoc bodies and quoted content, split
# on shell chain operators. First-word per segment is the command word
# the structural-search classifier checks.
# ---------------------------------------------------------------------------
extract_subs() {
  awk '
    function extract_pass(input,   out, extras, n, i, c, depth, j,
                                   content, in_sq, in_dq, inner_sq,
                                   inner_dq, cc) {
      out = ""; extras = ""; n = length(input); i = 1
      RESULT_FOUND = 0; in_sq = 0; in_dq = 0
      while (i <= n) {
        c = substr(input, i, 1)
        if (in_dq && c == "\\" && i < n) { out = out c substr(input, i+1, 1); i += 2; continue }
        if (!in_dq && c == "\047") { in_sq = !in_sq; out = out c; i++; continue }
        if (in_sq) { out = out c; i++; continue }
        if (c == "\"") { in_dq = !in_dq; out = out c; i++; continue }
        if ((c == "$" || c == "<" || c == ">") && i+1 <= n && substr(input, i+1, 1) == "(") {
          depth = 1; j = i + 2; content = ""; inner_sq = 0; inner_dq = 0
          while (j <= n && depth > 0) {
            cc = substr(input, j, 1)
            if (inner_dq && cc == "\\" && j < n) { content = content cc substr(input, j+1, 1); j += 2; continue }
            if (!inner_dq && cc == "\047") inner_sq = !inner_sq
            else if (!inner_sq && cc == "\"") inner_dq = !inner_dq
            else if (!inner_sq && !inner_dq) {
              if (cc == "(") depth++
              else if (cc == ")") { depth--; if (depth == 0) break }
            }
            content = content cc; j++
          }
          if (depth == 0) { extras = extras content ";"; out = out " "; i = j + 1; RESULT_FOUND = 1; continue }
          out = out c; i++; continue
        }
        if (c == "`") {
          j = i + 1; content = ""
          while (j <= n) {
            cc = substr(input, j, 1)
            if (cc == "\\" && j < n) { content = content substr(input, j+1, 1); j += 2; continue }
            if (cc == "`") break
            content = content cc; j++
          }
          if (j <= n && substr(input, j, 1) == "`") { extras = extras content ";"; out = out " "; i = j + 1; RESULT_FOUND = 1; continue }
          out = out c; i++; continue
        }
        out = out c; i++
      }
      RESULT_OUT = out; RESULT_EXTRAS = extras
    }
    {
      line = $0; extras_accum = ""
      while (1) { extract_pass(line); line = RESULT_OUT; extras_accum = extras_accum RESULT_EXTRAS; if (!RESULT_FOUND) break }
      while (1) {
        if (length(extras_accum) == 0) break
        extract_pass(extras_accum); new_clean = RESULT_OUT; new_extras = RESULT_EXTRAS
        if (!RESULT_FOUND) break
        extras_accum = new_clean new_extras
      }
      if (length(extras_accum) > 0) print line " ; " extras_accum
      else print line
    }
  '
}

normalize_command() {
  awk '
    BEGIN { in_hd = 0; delim = ""; dash = 0; in_sq = 0; in_dq = 0 }
    in_hd {
      t = $0
      if (dash) sub(/^[ \t]+/, "", t)
      if (t == delim) { in_hd = 0; delim = ""; dash = 0; print ";" }
      next
    }
    {
      line = $0; out = ""; n = length(line); i = 1
      while (i <= n) {
        c = substr(line, i, 1)
        if (in_sq) { if (c == "\047") { out = out "QQ"; in_sq = 0 } i++; continue }
        if (in_dq) {
          if (c == "\\") { i += 2; continue }
          if (c == "\"") { out = out "QQ"; in_dq = 0 }
          i++; continue
        }
        if (c == "\047") { in_sq = 1; i++; continue }
        if (c == "\"") { in_dq = 1; i++; continue }
        if (c == "<" && i < n && substr(line, i+1, 1) == "<") {
          ps = i + 2; pd = 0
          if (ps <= n && substr(line, ps, 1) == "-") { pd = 1; ps++ }
          pq = ""
          if (ps <= n && (substr(line, ps, 1) == "\047" || substr(line, ps, 1) == "\"")) { pq = substr(line, ps, 1); ps++ }
          d = ""
          while (ps <= n) { ch = substr(line, ps, 1); if (ch ~ /[A-Za-z0-9_]/) { d = d ch; ps++ } else break }
          if (length(d) > 0) {
            if (pq != "" && ps <= n && substr(line, ps, 1) == pq) ps++
            delim = d; dash = pd; in_hd = 1; i = ps; continue
          }
        }
        out = out c; i++
      }
      print out
    }
  '
}

# Classify one shell segment. Returns 0 (SEARCH) or 1 (not search).
is_search_segment() {
  local segment="$1"
  [[ -z "${segment// }" ]] && return 1
  # Strip wrapping subshell parens and env-var assignments.
  segment=$(printf '%s' "$segment" | awk '{ sub(/^[[:space:]]*\(+[[:space:]]*/,""); sub(/[[:space:]]*\)+[[:space:]]*$/,""); print }')
  segment=$(printf '%s' "$segment" | awk '{ while (match($0,/^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+/)) $0=substr($0,RLENGTH+1); print }')
  local first second rest
  first=$(printf '%s' "$segment" | awk '{ if (NF>0) { print $1; exit } }')
  second=$(printf '%s' "$segment" | awk '{ if (NF>1) { print $2; exit } }')
  rest=$(printf '%s' "$segment" | awk '{ for (i=2;i<=NF;i++) printf "%s ", $i; print "" }')
  case "$first" in
    grep|rg|ag|ack) return 0 ;;
    git)
      [[ "$second" == "grep" ]] && return 0
      ;;
    find)
      printf '%s' "$rest" | grep -qE -- '(^|[[:space:]])-(name|path|iname|ipath|regex)([[:space:]]|$)' && return 0
      ;;
    awk)
      printf '%s' "$rest" | grep -qE '/[^/]+/' && return 0
      ;;
  esac
  return 1
}

# Classify one shell segment as a graphify CLI invocation that should
# count toward GRAPHIFY (graphify query/path/explain are answer-class
# operations against the graph, equivalent to MCP queries).
is_graphify_cli_segment() {
  local segment="$1"
  [[ -z "${segment// }" ]] && return 1
  segment=$(printf '%s' "$segment" | awk '{ sub(/^[[:space:]]*\(+[[:space:]]*/,""); sub(/[[:space:]]*\)+[[:space:]]*$/,""); print }')
  segment=$(printf '%s' "$segment" | awk '{ while (match($0,/^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+/)) $0=substr($0,RLENGTH+1); print }')
  local first second
  first=$(printf '%s' "$segment" | awk '{ if (NF>0) { print $1; exit } }')
  second=$(printf '%s' "$segment" | awk '{ if (NF>1) { print $2; exit } }')
  if [[ "$first" == "graphify" ]] && [[ "$second" == "query" || "$second" == "path" || "$second" == "explain" ]]; then
    return 0
  fi
  return 1
}

# Decompose a Bash/ctx command string into segments; return 0 if any
# segment is a SEARCH, otherwise 1. Sets _IS_GRAPHIFY_CLI=1 if any
# segment is a graphify CLI answer-class invocation.
_IS_GRAPHIFY_CLI=0
decompose_and_classify() {
  local cmd="$1"
  [[ -z "${cmd// }" ]] && return 1
  local extracted normalized sep segments_str segment found_search=0
  extracted=$(printf '%s' "$cmd" | extract_subs)
  normalized=$(printf '%s' "$extracted" | normalize_command)
  normalized=$(printf '%s' "$normalized" | awk '{ gsub(/[0-9]*[<>]&[0-9]+|[0-9]*[<>]&-|&>>?|&\|/," "); print }')
  sep=$(printf '\x1f')
  segments_str=$(printf '%s' "$normalized" | awk -v sep="$sep" '{ gsub(/&&|\|\||;|\||&/, sep); print }')
  # Here-string (not process substitution): some hook runners do not
  # have /dev/fd/<N> mappings available, which makes `< <(...)` fail
  # with the cryptic "/dev/fd/63: No such file or directory" error.
  while IFS= read -r -d "$sep" segment || [[ -n "$segment" ]]; do
    if is_search_segment "$segment"; then found_search=1; fi
    if is_graphify_cli_segment "$segment"; then _IS_GRAPHIFY_CLI=1; fi
  done <<< "$segments_str"
  [[ $found_search -eq 1 ]]
}

# ---------------------------------------------------------------------------
# Bypass 2: magic phrase in the latest real user message.
# Real user message discriminator (mirrors memory-capture.sh):
#   "role":"user","content":"[^<]    (excludes tool_result wrappers and
#                                     slash-command/task-notification synth)
# ---------------------------------------------------------------------------
LAST_USER_LINE=$(grep -n '"role":"user","content":"[^<]' "$TRANSCRIPT" 2>/dev/null | tail -1 | cut -d: -f1)
if [ -n "$LAST_USER_LINE" ]; then
  LAST_USER_TEXT=$(awk -v n="$LAST_USER_LINE" 'NR==n' "$TRANSCRIPT" 2>/dev/null)
  if printf '%s' "$LAST_USER_TEXT" | grep -qiE '\bskip[[:space:]]+graph\b'; then
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Classify THIS call. If not SEARCH, exit 0.
# ---------------------------------------------------------------------------
THIS_IS_SEARCH=0
case "$TOOL_NAME" in
  Grep)
    THIS_IS_SEARCH=1
    ;;
  Bash)
    CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
    decompose_and_classify "$CMD" && THIS_IS_SEARCH=1
    ;;
  mcp__context-mode__ctx_execute|mcp__context-mode__ctx_execute_file)
    LANG=$(echo "$INPUT" | jq -r '.tool_input.language // empty' 2>/dev/null)
    if [[ "$LANG" == "shell" || "$LANG" == "bash" || "$LANG" == "sh" ]]; then
      CODE=$(echo "$INPUT" | jq -r '.tool_input.code // empty' 2>/dev/null)
      decompose_and_classify "$CODE" && THIS_IS_SEARCH=1
    fi
    ;;
  mcp__context-mode__ctx_batch_execute)
    # Iterate per-entry commands. tool_input.commands is an array of {label, command}.
    # Here-string instead of process substitution for the same portability
    # reason as the other read loops in this file.
    while IFS= read -r CMD; do
      [ -z "$CMD" ] && continue
      decompose_and_classify "$CMD" && THIS_IS_SEARCH=1
    done <<< "$(echo "$INPUT" | jq -r '.tool_input.commands[]?.command // empty' 2>/dev/null)"
    ;;
  *)
    exit 0
    ;;
esac

[ "$THIS_IS_SEARCH" -eq 0 ] && exit 0

# ---------------------------------------------------------------------------
# Count structural-search and graphify entries since the last real user
# prompt. Both sides walk the same transcript slice.
# ---------------------------------------------------------------------------
START_LINE="${LAST_USER_LINE:-1}"
SINCE=$(awk -v n="$START_LINE" 'NR>n' "$TRANSCRIPT" 2>/dev/null)

SEARCH_COUNT=0
GRAPHIFY_COUNT=0

# Native Grep tool_use entries. `grep -c` prints the count and exits 1
# when there are zero matches; the `|| true` suppresses the exit code
# without appending a stray `0` to the captured value (which would
# poison the integer comparison below).
SEARCH_COUNT=$(printf '%s' "$SINCE" | grep -c '"name":"Grep"' 2>/dev/null || true)
[ -z "$SEARCH_COUNT" ] && SEARCH_COUNT=0

# Bash and ctx_execute* tool_use lines: re-parse to count SEARCH segments
while IFS= read -r CMD_OR_CODE; do
  [ -z "$CMD_OR_CODE" ] && continue
  _IS_GRAPHIFY_CLI=0
  if decompose_and_classify "$CMD_OR_CODE"; then
    SEARCH_COUNT=$((SEARCH_COUNT + 1))
  fi
  if [ "$_IS_GRAPHIFY_CLI" -eq 1 ]; then
    GRAPHIFY_COUNT=$((GRAPHIFY_COUNT + 1))
  fi
done <<< "$(printf '%s' "$SINCE" | awk '
  /"name":"Bash"/ {
    if (match($0, /"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) {
      s = substr($0, RSTART+11, RLENGTH-12)
      print s
    }
  }
  /"name":"mcp__context-mode__ctx_execute"/ || /"name":"mcp__context-mode__ctx_execute_file"/ {
    if (match($0, /"code"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) {
      s = substr($0, RSTART+8, RLENGTH-9)
      print s
    }
  }
  /"name":"mcp__context-mode__ctx_batch_execute"/ {
    n = 0
    rest = $0
    while (match(rest, /"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) {
      s = substr(rest, RSTART+11, RLENGTH-12)
      print s
      rest = substr(rest, RSTART+RLENGTH)
      n++
      if (n > 50) break
    }
  }
')"

# mcp__graphify__* tool_use entries - always count toward GRAPHIFY.
# Same `grep -c` exit-code quirk as above; `|| true` keeps the captured
# value purely numeric.
MCP_GRAPHIFY=$(printf '%s' "$SINCE" | grep -c '"name":"mcp__graphify__' 2>/dev/null || true)
[ -z "$MCP_GRAPHIFY" ] && MCP_GRAPHIFY=0
GRAPHIFY_COUNT=$((GRAPHIFY_COUNT + MCP_GRAPHIFY))

# ---------------------------------------------------------------------------
# Block decision
# ---------------------------------------------------------------------------
if [ "$SEARCH_COUNT" -ge 3 ] && [ "$GRAPHIFY_COUNT" -eq 0 ]; then
  REASON="BLOCKED: ${SEARCH_COUNT} structural searches since last user prompt, 0 graphify queries. Use mcp__graphify__query_graph or mcp__graphify__get_node first. Bypass: say 'skip graph' in your next user message, or USER touches /tmp/graphify-bypass (do not create yourself)."
  jq -n --arg reason "$REASON" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }' 2>/dev/null
fi

exit 0
