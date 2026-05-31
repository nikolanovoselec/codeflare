# Graphify First

MUST use Graphify before broad repo search, architecture/dependency/call-flow lookup, or “where is X implemented?” when an active repo has `graphify-out/graph.json`. Query first with Graphify tools (Claude: `mcp__graphify__query_graph` / `get_node` / `shortest_path`; Pi: `graphify_query` / `graphify_explain` / `graphify_path`), then read only the files it identifies.

MUST NOT use the graph for exact known-file edits, git/CI state, single-file string search, or code changed this session. If skipping Graphify, say why briefly.

After source edits, refresh with `safe-graphify-update.sh` before further structural questions. Use `skills/graphify/SKILL.md` for mechanics, build/refresh commands, large-repo flags, persistence, and enforcement details.
