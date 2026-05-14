#!/usr/bin/env bash
# SessionStart hook (matcher: "startup") - inject knowledge-graph
# context if a graph exists in cwd. Implements REQ-AGENT-023 AC3.
#
# Two branches:
#
#   1. graphify-out/graph.json + GRAPH_REPORT.md present
#      -> inject a system reminder telling the agent to read
#         GRAPH_REPORT.md first and prefer mcp__graphify__* queries
#         over Grep for architecture questions.
#
#   2. cwd looks like a code repo but no graphify-out/
#      -> inject a short build-suggestion reminder. Never auto-builds.
#
# Fail-safe: any unexpected error -> exit 0 with no output. Sessions
# must never refuse to start because this hook misfired.
set +e

# Drain stdin so the hook does not SIGPIPE the parent.
INPUT=$(cat 2>/dev/null) || true

CWD=$(pwd 2>/dev/null) || exit 0
GRAPH="$CWD/graphify-out/graph.json"
REPORT="$CWD/graphify-out/GRAPH_REPORT.md"

emit_reminder() {
  # $1 = additionalContext string
  jq -n --arg ctx "$1" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: $ctx
    }
  }' 2>/dev/null || true
}

if [ -f "$GRAPH" ] && [ -f "$REPORT" ]; then
  emit_reminder "A graphify knowledge graph exists for this project at graphify-out/. Before answering architecture, dependency, or call-flow questions, read graphify-out/GRAPH_REPORT.md and use the graphify MCP tools (mcp__graphify__query_graph, mcp__graphify__get_node, mcp__graphify__get_neighbors, mcp__graphify__shortest_path) for focused lookups. Prefer focused MCP queries over broad Grep when the question is structural. If you have modified source files, run \`graphify update .\` to refresh the AST portion of the graph (free, no LLM cost) before answering."
  exit 0
fi

# No graph - only nudge if cwd looks like a code repo.
# 2s timeout: this hook runs on every SessionStart, must not stall the
# session on huge monorepos with deep directory trees. find exits early
# on first match (head -n 1) so the cap is just a safety net for trees
# with millions of files.
CODE_FILE=$(timeout 2 find "$CWD" -maxdepth 2 -type f \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
     -o -name '*.py' -o -name '*.go' -o -name '*.rs' -o -name '*.java' \
     -o -name '*.rb' -o -name '*.swift' -o -name '*.kt' -o -name '*.c' \
     -o -name '*.cc' -o -name '*.cpp' -o -name '*.h' \) \
  2>/dev/null | head -n 1)

if [ -n "$CODE_FILE" ]; then
  emit_reminder "No graphify knowledge graph for this project yet. If the user asks structural or architecture questions about this codebase, suggest building one with \`/graphify\` (one-time, writes graphify-out/ in the current directory). For repos with more than 2000 files, recommend \`graphify cluster-only . --no-viz\` (AST-only, no LLM extraction) as the safer first build."
fi

exit 0
