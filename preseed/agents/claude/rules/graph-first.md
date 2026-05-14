# Graph-First

When `graphify-out/graph.json` exists in the current project root:

MUST use `mcp__graphify__*` tools for:
- "how does X connect to Y" / "what depends on Z" / "what calls F"
- Locating definitions across files (`mcp__graphify__get_node`)
- Orientation on an unfamiliar repo (read `graphify-out/GRAPH_REPORT.md` first)

MUST NOT use the graph for:
- Editing a file at a known path
- String search inside a single file
- Code written or modified this session (graph is eventually-consistent)
- Pure repo-state questions (`git status`, `git log`, `gh pr list`)

After source edits: run `graphify update .` (AST-only, free) before answering further structural questions.

Mechanics, build/refresh commands, large-repo flags, persistence: see `~/.claude/skills/graphify/SKILL.md`.
