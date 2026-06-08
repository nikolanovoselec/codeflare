# Query, path, explain

Load this when the user asks a question against an existing graph, or runs `/graphify path` or `/graphify explain`. The core skill's "Query workflow" section points here.

Use the first-party native Pi tools for every graphify query - repo, Vault, and cross-repo/global alike. They resolve the graph automatically (the active repo's `graphify-out/graph.json` when you are in a cloned repo, otherwise the merged global graph at `/home/user/.graphify/global-graph.json`, which holds the Vault plus every globally-added repo). You do not pass a graph path.

- Broad context: `graphify_query({ question, mode: "bfs" })` - "what is X connected to"
- Trace/path: `graphify_query({ question, mode: "dfs" })` or `graphify_path` - "how does X reach Y"
- Node details: `graphify_explain({ concept })`

Answer using **only** what the tool output contains. Quote `source_location` when citing a specific fact. If the graph lacks enough information, say so - do not hallucinate edges.

CLI fallback - only if a native tool returns an error, rerun it with an explicit `--graph`:

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
