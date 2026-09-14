# Query, path, explain

Load this when the user asks a question against an existing graph, or runs `/graphify path` or `/graphify explain`. The core skill's "Query workflow" section points here.

Use the first-party native Pi tools for every graphify query - repo, Vault, and cross-repo/global alike. They resolve the graph automatically (the active repo's `graphify-out/graph.json` when you are in a cloned repo, otherwise the merged global graph at `/home/user/.graphify/global-graph.json`, which holds the Vault plus every globally-added repo). You do not pass a graph path.

- Broad context: `graphify_query({ question, mode: "bfs" })` - "what is X connected to"
- Deeper exploration: `graphify_query({ question, mode: "dfs" })`. Graphify 0.9.56+ BFS/DFS explores connections in both directions while preserving actual edge directions. Neighborhood membership does not prove a directed path.
- Directed trace/path: `graphify_path` - "how does X reach Y"; an absent reverse path remains meaningful.
- Node details: `graphify_explain({ concept })`

Treat graph output as navigation evidence, not proof against current source. Quote `source_location` when citing a graph fact and preserve every edge direction. Verify relevant source before explaining implementation; discard paths contradicted by current source, even after a graph refresh. If evidence is insufficient, say so—do not invent edges.

A “no path” result is not a tool failure. Do not substitute an undirected BFS/DFS neighborhood as proof of a directed path; label exploratory connectivity explicitly.

For an unavailable native tool, activate its exact name through `capability` and use the exposed schema. Before any CLI fallback for a remaining execution error, read `graphify <command> --help` rather than guessing arguments, and supply an explicit `--graph`:

```bash
graphify query "<question>" --graph <repo>/graphify-out/graph.json         # active repo
graphify query "<question>" --graph /home/user/.graphify/global-graph.json # Vault / global
```

## Save the answer back (feedback loop)

After you answer from a `graphify_query` / `graphify_path` / `graphify_explain` result, persist the Q&A back into the graph with the `graphify save-result` CLI. This closes the feedback loop: the next graph update extracts this Q&A as a node in the graph, so future queries improve. The native tool returns the resolved graph path in its `details` (the `graph` field) - run `save-result` against the same graph (pass `--graph <path>` if you are not already in that repo's cwd).

For a `graphify_query` answer (`--type query`):

```
graphify save-result --question "QUESTION" --answer "ANSWER" --type query --nodes NODE1 NODE2
```

Replace `QUESTION` with the user's verbatim question, `ANSWER` with your full answer text, and `NODE1 NODE2` with the labels of the nodes you cited.

For a `graphify_path` answer (`--type path_query`):

```
graphify save-result --question "Path from NODE_A to NODE_B" --answer "ANSWER" --type path_query --nodes NODE_A NODE_B
```

After the trace, explain each hop in plain language - what each edge means and why the path is significant - then save it.

For a `graphify_explain` answer (`--type explain`):

```
graphify save-result --question "Explain NODE_NAME" --answer "ANSWER" --type explain --nodes NODE_NAME
```

Write a 3-5 sentence explanation of what the node is, what it connects to, and why those connections matter, using the source locations as citations - then save it.

## Work memory (self-improving loop)

When you save a result, append an `--outcome` so future sessions learn from this one - add `--outcome useful|dead_end|corrected` to the `save-result` command (and `--correction "the right answer"` when the saved answer was wrong):

- `useful` - the cited nodes answered the question well; they become *preferred sources* next time.
- `dead_end` - the question or path led nowhere; don't re-derive it.
- `corrected` - the answer was wrong; `--correction` records what was right.

At the **start** of graph work, refresh and read the lessons: run `graphify reflect --if-stale` (cheap, deterministic, no LLM; `--if-stale` is a no-op when `graphify-out/reflections/LESSONS.md` is already newer than every input), then read `graphify-out/reflections/LESSONS.md`. It lists **preferred sources** (start there), **known dead ends** (skip them), and prior **corrections**. Running `reflect` yourself keeps the lessons current even without the git hook installed.
