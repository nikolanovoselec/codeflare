# Query, Path, Explain

Load this when the user asks a question against an existing graph, or runs `/graphify path` or `/graphify explain`. The core skill's "Query, Path, Explain" stub points here.

For graph queries, prefer the MCP tools directly - they are always available when a graph exists and resolve the active repo's `graphify-out/graph.json` (or the merged global graph) automatically:

- `mcp__graphify__query_graph` - broad context / BFS-style "what is X connected to"
- `mcp__graphify__shortest_path` - trace a chain between two named concepts
- `mcp__graphify__get_node`, `mcp__graphify__get_neighbors` - node details and immediate edges
- `mcp__graphify__get_community`, `mcp__graphify__god_nodes` - community membership and hubs

Answer using **only** what the tool output contains. Quote `source_location` when citing a specific fact. If the graph lacks enough information, say so - do not hallucinate edges.

CLI fallback (only if the MCP tools are unavailable): `graphify query "<question>"`, optionally `--dfs` for chain-tracing and `--budget 3000` to cap traversal size. If the `graphify` CLI is also unavailable, run an inline NetworkX traversal of `graphify-out/graph.json`.

## Save the answer back (feedback loop)

codeflare installs graphify as a CLI on PATH, so after you answer a query persist the Q&A back into the graph. This closes the feedback loop: the next graph update extracts this Q&A as a node in the graph, so future queries improve.

For `/graphify query` (`--type query`):

```
graphify save-result --question "QUESTION" --answer "ANSWER" --type query --nodes NODE1 NODE2
```

Replace `QUESTION` with the user's verbatim question, `ANSWER` with your full answer text, and `NODE1 NODE2` with the labels of the nodes you cited.

For `/graphify path` (`--type path_query`):

```
graphify save-result --question "Path from NODE_A to NODE_B" --answer "ANSWER" --type path_query --nodes NODE_A NODE_B
```

After running `mcp__graphify__shortest_path` (or the CLI), explain each hop in plain language - what each edge means and why the path is significant - then save it.

For `/graphify explain` (`--type explain`):

```
graphify save-result --question "Explain NODE_NAME" --answer "ANSWER" --type explain --nodes NODE_NAME
```

After running `mcp__graphify__get_node` / `get_neighbors` (or the CLI), write a 3-5 sentence explanation of what the node is, what it connects to, and why those connections matter, using the source locations as citations - then save it.

## Work memory (self-improving loop)

When you save a result, append an `--outcome` so future sessions learn from this one - add `--outcome useful|dead_end|corrected` to the `save-result` command (and `--correction "the right answer"` when the saved answer was wrong):

- `useful` - the cited nodes answered the question well; they become *preferred sources* next time.
- `dead_end` - the question or path led nowhere; don't re-derive it.
- `corrected` - the answer was wrong; `--correction` records what was right.

At the **start** of graph work, refresh and read the lessons: run `graphify reflect --if-stale` (cheap, deterministic, no LLM; `--if-stale` is a no-op when `graphify-out/reflections/LESSONS.md` is already newer than every input), then read `graphify-out/reflections/LESSONS.md`. It lists **preferred sources** (start there), **known dead ends** (skip them), and prior **corrections**. Running `reflect` yourself keeps the lessons current even without the git hook installed.

## Other flows

For `/graphify add`, `--watch`, `graphify hook`, and `graphify claude` - see upstream graphify documentation (`graphify --help`). Neo4j (`--neo4j`), SVG (`--svg`), and GraphML (`--graphml`) export flags are supported but not documented here.
