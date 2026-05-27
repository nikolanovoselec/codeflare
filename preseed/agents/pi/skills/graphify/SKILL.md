---
name: graphify
description: Pi-native Codeflare Graphify workflow. Build/query repository knowledge graphs without requiring headless DeepSeek extraction; AST runs locally and full semantic extraction uses Pi Agent subagents from the running session.
---

# Pi Graphify Workflow

Use this skill for `/graphify`, after repo clone prompts, and for natural-language requests to graph a project in Pi.

## Core rule

Do **not** use headless `graphify extract --backend deepseek` for normal interactive Codeflare/Pi graph builds. That path is for CI/headless API-key extraction. In Pi:

- AST/structural extraction is local and free.
- Full semantic extraction uses the running Pi session's `Agent` subagents in bounded waves.
- Query existing graphs with Pi native tools: `graphify_query`, `graphify_path`, `graphify_explain`.

## Triage

1. Resolve repo root. Prefer `/home/user/.cache/codeflare-hooks/graphify-active-cwd` when present; otherwise use the current git root.
2. Check `<repo>/graphify-out/graph.json`.
3. If graph exists:
   - Check freshness with `graphify check-update <repo>` or compare changed files since the graph build.
   - If stale, ask whether to run AST-only update or full semantic refresh.
   - If fresh, use graph query tools before broad grep/find.
4. If graph is missing, ask the user to choose:
   - **AST-only**: free/local/no LLM.
   - **Full semantic + AST**: local AST plus Pi Agent semantic subagents for docs/papers/images.

## AST-only build/update

Run from the repo root:

```bash
bash /home/user/.pi/agent/scripts/safe-graphify-update.sh .
graphify cluster-only .
```

The safe wrapper runs bounded local code extraction and avoids unbounded graphify subprocesses in the 1-CPU container. The follow-up clustering command intentionally generates `graphify-out/graph.html`; do not skip HTML visualization unless the user explicitly asks. This does not require any LLM API key. Use this by default for code-only repos or when the user chooses free/fast mode.

After graph creation/update, merge into the global graph when possible:

```bash
flock -w 5 /tmp/graphify-global.lock graphify global add graphify-out/graph.json --as "$(basename "$PWD")"
```

## Full semantic + AST build

Use this only after the user chooses Full.

1. Detect non-code files (docs, papers, images) and estimate subagent count.
2. Run AST extraction locally in parallel with the first semantic wave.
3. Dispatch semantic extraction with Pi `Agent` subagents in waves of at most `GRAPHIFY_SEMANTIC_MAX_PARALLEL` (default 10). Use `model: "sonnet"` when available for schema compliance. Do not use Opus.
4. Each subagent returns JSON graph fragments: nodes, edges, and hyperedges.
5. Cache semantic fragments, merge cached + new fragments, then merge AST + semantic output.
6. Build `graphify-out/graph.json`, run clustering/report generation, and merge into the global graph.

If semantic extraction fails for a chunk, warn and skip that chunk. Do not abort the whole AST graph.

## Querying

Use native Pi graphify tools:

- `graphify_query({ question, mode: "bfs" })` for broad context.
- `graphify_query({ question, mode: "dfs" })` or `graphify_path` for paths.
- `graphify_explain({ concept })` for a node and its neighbors.

If the graph is under a child repo while Pi cwd is `/home/user/workspace`, run from the repo root or pass the graph path via CLI (`graphify query ... --graph <repo>/graphify-out/graph.json`) until native tools resolve active repo automatically.
