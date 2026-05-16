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

**Hard gate (codeflare advanced sessions only)**: after 3 structural searches (`grep`, `rg`, `ag`, `ack`, `git grep`, `find -name|-path|-iname|-ipath|-regex`, `awk /regex/`) in the same turn without a `mcp__graphify__*` call (or `graphify query|path|explain` CLI), the `enforce-graphify.sh` PreToolUse hook denies the next structural search. Bypass is USER-only: `skip graph` in a user message, or `touch /tmp/graphify-bypass` (one-shot, auto-deleted). The agent must never create the sentinel.

Mechanics, build/refresh commands, large-repo flags, persistence: see `~/.claude/skills/graphify/SKILL.md`.
