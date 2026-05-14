#!/usr/bin/env bash
# PreToolUse hook - soft-nudge toward mcp__graphify__* when the agent is
# about to grep/glob in a repo that has a graphify knowledge graph.
# Implements REQ-AGENT-023 graph-first discipline. Never blocks; always
# exits 0. Tool call runs normally either way - this only injects an
# additionalContext system reminder appended to the tool result.
#
# Matcher coverage (registered in entrypoint.sh):
#   - Grep, Glob                                       (non-custom tier)
#   - mcp__context-mode__ctx_search                    (custom tier, grep-equivalent)
#   - mcp__context-mode__ctx_batch_execute             (custom tier, may bundle greps)
#
# Tier rationale: context-mode (custom tier only) denies Grep/Glob/Read
# via enforce-ctx-mode.sh, so the agent uses ctx_search / ctx_batch_execute
# instead. Hooks must cover both paths to fire in both tiers. ctx_execute
# is the general-purpose escape hatch and not in scope (false-positive
# rate too high - mostly used for non-grep processing); Read is "about to
# Edit," not a grep substitute.
#
# Fail-safe: any unexpected error -> exit 0 with no output. A noisy or
# crashing PreToolUse hook would break every grep call in the session.
# Every command below has an explicit `|| exit 0` / `|| true` guard
# (jq failures, missing stdin, etc.); no ERR trap needed under set +e.
set +e

INPUT=$(cat 2>/dev/null) || exit 0

# Determine cwd at the moment of the tool call. Hook stdin includes the
# cwd field; fall back to $PWD if missing.
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD="$PWD"

# Only nudge if a graph actually exists in the project root the agent is
# operating from. Without a graph there is nothing to suggest.
[ -f "$CWD/graphify-out/graph.json" ] || exit 0

# Extract tool name to tailor the inject phrasing. ctx_batch_execute is
# fuzzier (may bundle unrelated commands) so the inject is hedged.
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

case "$TOOL" in
  mcp__context-mode__ctx_batch_execute)
    MSG="A graphify knowledge graph exists at \`graphify-out/graph.json\`. If any of these searches are structural (\"how does X connect\", \"what depends on Y\", \"locate definition of Z\"), prefer \`mcp__graphify__query_graph\` / \`get_node\` / \`get_neighbors\` / \`shortest_path\` instead. Content searches inside known files are fine to keep as-is."
    ;;
  mcp__context-mode__ctx_search|Grep|Glob)
    MSG="A graphify knowledge graph exists at \`graphify-out/graph.json\`. If this search is structural (\"how does X connect\", \"what depends on Y\", \"locate definition of Z\"), prefer \`mcp__graphify__query_graph\` / \`get_node\` / \`get_neighbors\` / \`shortest_path\` over text search. If you are searching for a string inside a known file, this Grep is fine."
    ;;
  *)
    # Defensive: matcher mismatched somehow. No inject.
    exit 0
    ;;
esac

jq -n --arg msg "$MSG" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $msg
  }
}' 2>/dev/null || true

exit 0
