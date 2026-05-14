# Graph-First Codebase Navigation

When `graphify-out/graph.json` exists in the current project root, treat the knowledge graph as the primary source of structural truth. Prefer focused MCP queries over broad Grep, Glob, or recursive Read for architecture, dependency, and call-flow questions.

## When to use the graph

- **Architecture questions** ("how does X connect to Y", "what touches Z"): use `mcp__graphify__shortest_path` or `mcp__graphify__get_neighbors`.
- **Locating definitions** ("where is function F defined", "show me the class hierarchy of C"): use `mcp__graphify__get_node` with the identifier.
- **Exploratory queries** ("show me the auth flow", "what depends on Db"): use `mcp__graphify__query_graph` with a focused natural-language phrase.
- **Top-level orientation on an unfamiliar repo**: read `graphify-out/GRAPH_REPORT.md` first. It lists god nodes (highest-fan-in nodes), communities (clusters of tightly-coupled files), and a set of starter questions the graph was optimised for.

## When NOT to use the graph

- File-level edits to known paths: just Read/Edit the file.
- Content searches inside a known file ("does this file mention X"): Grep is faster.
- Tests, configs, build files: graphify de-emphasises these by design.
- Anything written or modified in the current session since the last `graphify update`: the graph is eventually-consistent.
- Pure repo-state questions (`git status`, `git log`, `gh pr list`): tools own those, not the graph.

## Keeping the graph fresh

After modifying source files in a session, run `graphify update .` to rebuild the AST portion of the graph. This is free: tree-sitter only, no LLM extraction, no token cost. Skip it if the change was test-only, doc-only, or otherwise outside the graph's coverage.

The graph's doc/PDF/image nodes (the LLM-extracted portion) only refresh on a full `graphify .` rebuild, which DOES burn session tokens. Reach for the full rebuild sparingly.

## Large repos (more than 2000 files)

Skip LLM extraction entirely with `graphify cluster-only . --no-viz`. Pure AST graph, no doc/PDF extraction, no skill-subagent dispatch, no HTML visualisation. This is the recommended path for huge monorepos and the safe default outside the custom tier (where context-mode is not available to provide extra per-subagent savings).

## Reference

- Skill: `~/.claude/skills/graphify/SKILL.md` for the full command surface, flags, and tier-specific guidance.
- Build report: `graphify-out/GRAPH_REPORT.md` for the per-project god nodes and community map (read this first on any unfamiliar repo).
- Optional wiki: `graphify-out/wiki/` if present, per-community wiki articles.
