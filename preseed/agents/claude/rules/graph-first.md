# Graph-First

When `graphify-out/graph.json` exists in the project root, prefer `mcp__graphify__*` over Grep for structural lookups.

**Use the graph for:**
- "how does X connect to Y" / "what depends on Z" / "what calls F"
- Locating definitions across files (`get_node`)
- Orientation on an unfamiliar repo (read `graphify-out/GRAPH_REPORT.md` first)

**Do NOT use the graph for:**
- Editing a file at a known path
- String search inside a single file
- Code written or modified this session (graph is eventually-consistent)
- Pure repo-state questions (`git status`, `git log`, `gh pr list`)

After source edits, run `graphify update .` before answering further structural questions.

**Route:** invoke the `graphify` skill for mechanics, build/refresh commands, large-repo flags, persistence, and the codeflare PreToolUse enforcement gate.
