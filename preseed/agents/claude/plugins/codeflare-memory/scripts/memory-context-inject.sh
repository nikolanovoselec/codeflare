#!/usr/bin/env bash
# UserPromptSubmit hook - proactive memory injection on first prompt.
#
# On the FIRST user message of a session (counter file absent), queries
# the unified graphify graph with keywords from the user's prompt and
# injects matched context as additionalContext. The agent sees relevant
# prior decisions, vault notes, and code references BEFORE responding -
# no explicit tool call needed.
#
# Subsequent prompts (counter file present): exit silently. The memory-
# capture.sh hook handles the ongoing 15-prompt capture cadence.
#
# Fail-safe: any error -> exit 0 with no output. Never block a session.
set +e

USER_HOME="${HOME:-/home/user}"
COUNTER_DIR="${MEMCAP_COUNTER_DIR:-/tmp/.memory-counter}"
mkdir -p "$COUNTER_DIR" 2>/dev/null || true

INPUT=$(cat 2>/dev/null) || true

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || true
[ -z "$SESSION_ID" ] && exit 0

# Sanitize session_id: UUID format only, reject path traversal.
case "$SESSION_ID" in
  *..* | */* | *\\*) exit 0 ;;
esac
[[ "$SESSION_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 0

# Check sentinel EXISTENCE first (fast path for 2nd+ prompts).
INJECT_SENTINEL="$COUNTER_DIR/${SESSION_ID}.inject-lock"
[ -d "$INJECT_SENTINEL" ] && exit 0

# Extract and validate prompt BEFORE claiming the sentinel.
# This ensures short/empty prompts don't permanently disable injection.
PROMPT_TEXT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null) || true
[ -z "$PROMPT_TEXT" ] && exit 0

PROMPT_LEN=${#PROMPT_TEXT}
[ "$PROMPT_LEN" -lt 20 ] && exit 0

# Extract keywords: take the first 200 chars, strip punctuation, take
# unique words >= 4 chars. This gives graphify enough signal without
# sending the full prompt.
KEYWORDS=$(printf '%s' "$PROMPT_TEXT" | head -c 200 \
  | tr '[:upper:]' '[:lower:]' \
  | tr -cs '[:alnum:]' ' ' \
  | tr ' ' '\n' \
  | awk 'length >= 4' \
  | sort -u \
  | head -10 \
  | tr '\n' ' ')

[ -z "$KEYWORDS" ] && exit 0

# Check if the unified global graph exists.
GLOBAL_GRAPH="$USER_HOME/.graphify/global-graph.json"
if [ ! -f "$GLOBAL_GRAPH" ]; then
  # Fall back to per-repo graph in cwd.
  CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
  [ -z "$CWD" ] && CWD=$(pwd 2>/dev/null)
  case "$CWD" in *..* ) exit 0 ;; esac
  GLOBAL_GRAPH="$CWD/graphify-out/graph.json"
  [ ! -f "$GLOBAL_GRAPH" ] && exit 0
fi

# Skip graphs > 30MB (Python JSON parse too slow on resource-constrained container).
# Both checks are deterministic per session, so safe before sentinel.
GRAPH_SIZE=$(stat -c%s "$GLOBAL_GRAPH" 2>/dev/null) || GRAPH_SIZE=0
[ "$GRAPH_SIZE" -gt 31457280 ] && exit 0
command -v python3 >/dev/null 2>&1 || exit 0

MATCHED_CONTEXT=$(GRAPH_PATH="$GLOBAL_GRAPH" QUERY_KEYWORDS="$KEYWORDS" timeout 8 python3 -c "
import json, sys, os

try:
    with open(os.environ['GRAPH_PATH']) as f:
        g = json.load(f)

    nodes = g.get('nodes', [])
    keywords = os.environ.get('QUERY_KEYWORDS', '').split()

    if not keywords:
        sys.exit(0)

    scored = []
    for n in nodes:
        label = (n.get('label', '') or '').lower()
        desc = (n.get('description', '') or '').lower()
        source = (n.get('source', '') or '').lower()
        score = 0
        for kw in keywords:
            if kw in label:
                score += 10
            elif kw in desc:
                score += 3
            elif kw in source:
                score += 1
        if score > 0:
            scored.append((score, n))

    if not scored:
        sys.exit(0)

    scored.sort(key=lambda x: -x[0])
    top = scored[:10]

    lines = []
    for score, n in top:
        label = n.get('label', '?')
        src = n.get('source', '')
        desc = n.get('description', '')
        entry = f'- {label}'
        if src:
            entry += f' [{src}]'
        if desc and len(desc) < 150:
            entry += f': {desc}'
        lines.append(entry)

    vault_hits = [n for _, n in top if 'vault/' in (n.get('source', '') or '').lower()]

    print('Prior context matching your query:')
    print(chr(10).join(lines))
    if vault_hits:
        print(f'({len(vault_hits)} vault note(s) matched - consider reading them for detailed context)')

except Exception as e:
    print(f'memory-inject-failed: {e}', file=sys.stderr)
    sys.exit(0)
" 2>/dev/null)

[ -z "$MATCHED_CONTEXT" ] && exit 0

# Claim the sentinel AFTER a successful query. mkdir is POSIX-atomic:
# it either creates (we won) or fails (concurrent claim). Placed here
# so failed/empty queries don't permanently disable injection.
mkdir "$INJECT_SENTINEL" 2>/dev/null || exit 0

# Inject as additionalContext - the agent sees this before responding.
CONTEXT="$MATCHED_CONTEXT

Use mcp__graphify__query_graph or mcp__graphify__get_node to drill into any of these for more detail."

jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}' 2>/dev/null || true

exit 0
