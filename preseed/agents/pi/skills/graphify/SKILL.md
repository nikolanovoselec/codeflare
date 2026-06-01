---
name: graphify
description: Graphify knowledge-graph workflow for Pi/Codeflare. Use for any request to build, refresh, query, explain, trace, or locate code/vault/session knowledge in graphs. Covers repo graphs, Vault graph, global graph, native Pi tools, CLI fallbacks, and using in-session Pi Agent subagents for interactive semantic extraction instead of headless/API-key extraction.
---

# Graphify in Pi / Codeflare

Use this skill whenever the user asks to:

- find or explain something with Graphify
- query remembered/session/vault context
- trace how concepts connect
- build or refresh a repo graph
- locate definitions/dependencies from a graph
- diagnose a missing/stale graph

## First decision: which graph?

| User intent | Graph to use | Best command/tool |
|---|---|---|
| Current repo/code question | `<repo>/graphify-out/graph.json` | native `graphify_query/path/explain` first |
| Vault note, memory capture, session history, remembered context | `/home/user/.graphify/global-graph.json` | CLI with explicit `--graph` |
| Cross-repo + vault context | `/home/user/.graphify/global-graph.json` | CLI with explicit `--graph` |
| Raw Vault-only inspection | `/home/user/Vault/graphify-out/graph.json` | CLI with explicit `--graph` |

Important paths:

```text
Repo graph:   <repo>/graphify-out/graph.json
Vault graph:  /home/user/Vault/graphify-out/graph.json
Global graph: /home/user/.graphify/global-graph.json
```

There is normally **no** graph at `/home/user/workspace/graphify-out/graph.json`.
If a wrapper looks there and fails, retry immediately with an explicit graph path.
Do not consult `graphify --help` for this.

## Query commands

### Repo/code queries

Use native Pi tools first when working inside a repo or when an active repo sentinel exists:

- Broad context: `graphify_query({ question, mode: "bfs" })`
- Path/trace: `graphify_query({ question, mode: "dfs" })` or `graphify_path`
- Node details: `graphify_explain({ concept })`

If the native tool fails because it looked under `/home/user/workspace/graphify-out`, resolve the repo and use CLI fallback:

```bash
graphify query "<question>" --graph <repo>/graphify-out/graph.json
graphify path "A" "B" --graph <repo>/graphify-out/graph.json
graphify explain "X" --graph <repo>/graphify-out/graph.json
```

Resolve `<repo>` by:

1. `/home/user/.cache/codeflare-hooks/graphify-active-cwd` if present.
2. `git rev-parse --show-toplevel` from the current directory.
3. The obvious child repo under `/home/user/workspace/`.

### Vault, memory, and cross-session queries

Always use the global graph explicitly:

```bash
graphify query "<question-or-concept>" --graph /home/user/.graphify/global-graph.json
graphify path "A" "B" --graph /home/user/.graphify/global-graph.json
graphify explain "X" --graph /home/user/.graphify/global-graph.json
```

Good search handles for memory captures are usually wikilink concepts from the note, not the full title. Example:

```bash
graphify query "PiClaudeParity" --graph /home/user/.graphify/global-graph.json
```

If the CLI returns the node but not the file path, inspect the graph JSON node only as a last step.

## Build / refresh repo graphs

### AST-only initial build — first-time graph creation

Use this when `graphify-out/graph.json` is missing. This mirrors Claude's first-build path: local file detection, deterministic AST extraction, graph build, clustering, report, and HTML visualization. It does **not** use an LLM or external API.

From the repo root:

```bash
bash /home/user/.pi/agent/scripts/build-graphify-ast.sh .
```

### AST-only refresh — existing graphs only

Use this when `graphify-out/graph.json` already exists and source changed. This mirrors Claude's safe update wrapper around `graphify update`; do not use it for first-time graph creation.

From the repo root:

```bash
bash /home/user/.pi/agent/scripts/safe-graphify-update.sh .
```

### Global merge and git persistence

After either initial build or refresh, merge into the global graph:

```bash
flock -w 5 /tmp/graphify-global.lock graphify global add graphify-out/graph.json --as "$(basename "$PWD")"
```

Then persist the durable graph outputs in git when the user owns or can push to the repo. Graph persistence lives with the repo, not R2.

Add or repair repo ignore rules so only regenerable cache/intermediate files are ignored:

```gitignore
# Graphify knowledge graph
# Commit graphify-out/graph.json, graphify-out/GRAPH_REPORT.md, and graphify-out/graph.html.
graphify-out/cache/
graphify-out/.cache/
graphify-out/.chunks/
graphify-out/manifest.json
graphify-out/.graphify_root
graphify-out/.graphify_labels.json
graphify-out/obsidian/
.graphify_ast.json
.graphify_semantic.json
.graphify_semantic_new.json
.graphify_extract.json
.graphify_detect.json
.graphify_analysis.json
.graphify_cached.json
.graphify_uncached.txt
.graphify_chunk_*.txt
.graphify_old.json
.graphify_root
.graphify_labels.json
```

If `.gitignore` or `.git/info/exclude` contains a blanket `graphify-out/`, remove it or replace it with the granular list above. Add the merge-driver wiring:

```gitattributes
graphify-out/graph.json merge=graphify
```

Commit these durable outputs after the first build or any meaningful refresh:

- `graphify-out/graph.json`
- `graphify-out/GRAPH_REPORT.md`
- `graphify-out/graph.html`
- optional `graphify-out/wiki/` if generated

Do not commit graphify caches, chunk files, manifests, `.graphify_*` intermediates, or Obsidian export unless the user explicitly asks. `graph.html` must always be generated; if it is missing, rerun the appropriate build/refresh command before reporting Graphify work complete.

Use AST-only initial build by default on a new repo and AST-only refresh by default after source edits. Both are local, bounded, and safe for the 1-CPU container.

### Full semantic + AST build/refresh — only when user wants semantic/docs extraction

For normal interactive Pi work, semantic extraction is done by **in-session Pi `Agent` subagents using the current main-session model by default**. Do not pass a `model` override unless the user explicitly asks. Do not run any headless/API-key extractor (`graphify extract --backend ...`) unless the user explicitly asks for CI/headless extraction.

Interactive full mode means:

1. Run the local AST path first: `build-graphify-ast.sh` for a missing graph, or `safe-graphify-update.sh` for an existing graph.
2. Split docs/non-code files into chunks.
3. Spawn Pi `Agent` subagents in bounded waves, default max parallel `2`, without a `model` override so they inherit the current main-session model.
4. Require each subagent to write a JSON chunk file under `<repo>/graphify-out/`.
5. Validate chunks, merge AST + semantic output, cluster, generate HTML, and global-add.

Use this only when the user explicitly chooses full semantic extraction or asks for docs/papers/images to be semantically represented.

## Freshness check

For repo graphs, compare graph commit metadata to `git rev-parse HEAD` when available.
If stale, say so and offer:

- AST-only initial build when missing: fast/local/default.
- AST-only refresh when stale: fast/local/default for existing graphs.
- Full semantic build/refresh: slower, uses Pi subagents with the current main-session model by default.

Do not silently rebuild unless the user asked to refresh/build/update.

## Rules

- Use explicit `--graph /home/user/.graphify/global-graph.json` for Vault/memory/session questions.
- Use native wrappers first only for repo/code graph questions.
- Never assume `/home/user/workspace/graphify-out/graph.json` exists.
- Interactive semantic extraction uses in-session Pi `Agent` subagents, not headless/API-key extractors.
- After source edits in a graphed repo, prefer the safe update wrapper before answering new structural graph questions.
- Persist repo graph outputs in git when push permission exists: `graphify-out/graph.json`, `graphify-out/GRAPH_REPORT.md`, and `graphify-out/graph.html`; ignore only caches/intermediates.
- Do not edit graph output JSON by hand except for diagnostic read-only inspection.
