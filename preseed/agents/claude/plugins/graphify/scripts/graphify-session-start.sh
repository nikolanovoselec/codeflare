#!/usr/bin/env bash
# SessionStart hook (matcher: "startup") - inject knowledge-graph
# context from prior sessions. Implements REQ-AGENT-024 AC1.
#
# Three tiers of injection, cheapest first:
#
#   1. graphify-out/graph.json present
#      -> query the graph for god-nodes (highest-connectivity concepts)
#         and inject a compressed structural summary as additionalContext.
#         The agent sees architecture context before its first tool call.
#
#   2. graphify-out/ present but query fails
#      -> fall back to the GRAPH_REPORT.md preamble (first 80 lines).
#
#   3. cwd looks like a code repo but no graphify-out/
#      -> inject a short build-suggestion reminder. Never auto-builds.
#
# Fail-safe: any unexpected error -> exit 0 with no output. Sessions
# must never refuse to start because this hook misfired.
set +e

# Drain stdin so the hook does not SIGPIPE the parent.
INPUT=$(cat 2>/dev/null) || true

CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$CWD" ] && CWD=$(pwd 2>/dev/null)
[ -z "$CWD" ] && exit 0
# Reject path traversal in CWD
case "$CWD" in *..* ) exit 0 ;; esac
GRAPH="$CWD/graphify-out/graph.json"
REPORT="$CWD/graphify-out/GRAPH_REPORT.md"

emit_reminder() {
  jq -n --arg ctx "$1" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: $ctx
    }
  }' 2>/dev/null || true
}

if [ -f "$GRAPH" ]; then
  # Skip Tier 1 for graphs > 30MB (Python JSON parse too slow on resource-constrained container).
  GRAPH_SIZE=$(stat -c%s "$GRAPH" 2>/dev/null) || GRAPH_SIZE=0
  [ "$GRAPH_SIZE" -gt 31457280 ] && GRAPH_SIZE_SKIP=1 || GRAPH_SIZE_SKIP=0

  # Tier 1: compute god-nodes (highest-degree) from the raw graph JSON.
  # Pure Python - reads graph.json directly, no graphify CLI needed.
  # Budget: ~1500 tokens of context injected, enough for orientation
  # without bloating the system prompt.
  GOD_NODES=""
  if [ "$GRAPH_SIZE_SKIP" -eq 0 ] && command -v python3 >/dev/null 2>&1; then
    GOD_NODES=$(GRAPH_PATH="$GRAPH" timeout 10 python3 -c "
import json, sys
try:
    import os
    with open(os.environ['GRAPH_PATH']) as f:
        g = json.load(f)
    nodes = g.get('nodes', [])
    edges = g.get('edges', [])
    # Compute degree per node
    deg = {}
    for e in edges:
        s, t = str(e.get('source','')), str(e.get('target',''))
        deg[s] = deg.get(s, 0) + 1
        deg[t] = deg.get(t, 0) + 1
    # Build id->label map
    labels = {str(n['id']): n.get('label','') for n in nodes}
    # Top 15 by degree
    top = sorted(deg.items(), key=lambda x: -x[1])[:15]
    lines = []
    for nid, d in top:
        lbl = labels.get(nid, nid)
        lines.append(f'- {lbl} (degree {d})')
    stats = f'{len(nodes)} nodes, {len(edges)} edges'
    print(f'Graph: {stats}')
    print('Key concepts (highest connectivity):')
    print(chr(10).join(lines))
except Exception as e:
    print(f'graph-query-failed: {e}', file=sys.stderr)
    sys.exit(1)
" 2>/dev/null)
  fi

  if [ -n "$GOD_NODES" ]; then
    # Tier 1 success: real graph context + tool guidance
    CONTEXT="SessionStart hook additional context: $GOD_NODES

BEFORE responding, query the unified graph for context. Use mcp__graphify__query_graph (or mcp__graphify__get_node for a known concept) with terms from the user's message to surface prior decisions, vault notes, and per-repo references."
    emit_reminder "$CONTEXT"
    exit 0
  fi

  # Tier 2: graph exists but query failed - use report preamble
  if [ -f "$REPORT" ]; then
    PREAMBLE=$(head -80 "$REPORT" 2>/dev/null | head -c 3000)
    if [ -n "$PREAMBLE" ]; then
      CONTEXT="SessionStart hook additional context: Knowledge graph loaded.

$PREAMBLE

BEFORE responding, query the unified graph for context. Use mcp__graphify__query_graph (or mcp__graphify__get_node for a known concept) with terms from the user's message to surface prior decisions, vault notes, and per-repo references."
      emit_reminder "$CONTEXT"
      exit 0
    fi
  fi

  # Tier 2 fallback: graph exists but no report - still nudge
  emit_reminder "A graphify knowledge graph exists for this project at graphify-out/. Before answering architecture, dependency, or call-flow questions, use the graphify MCP tools (mcp__graphify__query_graph, mcp__graphify__get_node, mcp__graphify__get_neighbors, mcp__graphify__shortest_path) for focused lookups. Prefer focused MCP queries over broad Grep when the question is structural. If you have modified source files, run \`bash /home/user/.claude/plugins/graphify/scripts/safe-graphify-update.sh .\` to refresh the AST portion of the graph."
  exit 0
fi

# Tier 3: No graph - only nudge if cwd looks like a code repo.
PROJECT_MARKER=$(find "$CWD" -maxdepth 1 -type f \
  \( -name 'package.json' -o -name 'Cargo.toml' -o -name 'go.mod' \
     -o -name 'pyproject.toml' -o -name 'pom.xml' -o -name 'build.gradle' \
     -o -name 'Gemfile' -o -name 'composer.json' -o -name 'CMakeLists.txt' \
     -o -name 'mix.exs' -o -name 'deno.json' \) \
  2>/dev/null | head -n 1)

CODE_FILE=""
if [ -z "$PROJECT_MARKER" ]; then
  CODE_FILE=$(timeout 2 find "$CWD" -maxdepth 4 -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
       -o -name '*.py' -o -name '*.go' -o -name '*.rs' -o -name '*.java' \
       -o -name '*.rb' -o -name '*.swift' -o -name '*.kt' -o -name '*.c' \
       -o -name '*.cc' -o -name '*.cpp' -o -name '*.h' \) \
    2>/dev/null | head -n 1)
fi

if [ -n "$PROJECT_MARKER" ] || [ -n "$CODE_FILE" ]; then
  emit_reminder "No graphify knowledge graph for this project yet. If the user asks structural or architecture questions about this codebase, suggest building one with \`/graphify\` (one-time, writes graphify-out/ in the current directory). For repos with more than 2000 files, recommend \`graphify cluster-only . --no-viz\` (AST-only, no LLM extraction) as the safer first build."
fi

exit 0
