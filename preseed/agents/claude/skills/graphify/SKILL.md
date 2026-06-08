---
name: graphify
description: Build and query knowledge graphs from any folder (code + docs + PDFs + images). MCP-backed. Activates on /graphify and on natural-language requests to graph a project.
trigger: /graphify
---

# /graphify (Codeflare-managed skill)

This skill drives `/graphify` knowledge-graph extraction inside the Codeflare container. The `graphifyy` Python tool is pre-installed at build time (`uv tool install graphifyy[mcp,sql,pdf]`); the `graphify` CLI is on PATH at `/root/.local/bin/graphify` and the MCP server is pre-registered in `~/.claude.json` as `/root/.local/share/uv/tools/graphifyy/bin/python -m graphify.serve`. You do not need to install or wire anything.

## Quick Reference

**Python interpreter:** All `python3` code blocks in this skill must use graphify's own interpreter: `/root/.local/share/uv/tools/graphifyy/bin/python`. System `python3` cannot import graphify. The CLI at `/root/.local/bin/graphify` is on PATH.

### Recipe 1: AST-only update (free, no tokens)
```
bash /home/user/.claude/plugins/graphify/scripts/safe-graphify-update.sh .
```
Re-extracts code structure only. Use after source code changes. Memory-safe (OOM-guarded).

### Recipe 2: Full semantic update (existing repo)
1. Detect files (Step 1 below)
2. Check semantic cache (Step B0) - note cached vs uncached counts
3. Present AskUserQuestion: AST-only vs Full (Note 8). Include subagent count: `ceil(uncached_doc_paper_files / 22) + uncached_image_count` (images get own chunk)
4. If Full chosen: start AST (Part A) in background, dispatch first semantic wave in parallel
5. Split uncached non-code files into chunks of 22 (images get own chunk)
6. Dispatch waves of at most 10 Sonnet subagents (Note 9: `model: "sonnet"`). All agents in one wave go in a SINGLE message. Wait for wave completion before next wave.
7. Collect results, save to cache, merge cached + new (Step B3)
8. Merge AST + semantic (Part C)
9. Build, cluster, label communities (Steps 3-4)
10. Generate HTML + Obsidian vault (Step 5)
11. Benchmark + manifest + cleanup (Steps 6-7)
12. Commit `graphify-out/graph.json`, `GRAPH_REPORT.md`, `graph.html` + merge into global graph (Note 3)

**If interrupted mid-wave:** re-run from step 2. Cache (Step B0) skips already-extracted files. Only uncached files get re-dispatched.

### Recipe 3: First-time build on new repo
Follow the full canonical protocol below (Steps 1-7). Note 8 fires to ask build mode. After build, set up `.gitignore` and `.gitattributes` per Note 3.

### Recipe 4: Re-cluster existing graph
```
graphify cluster-only .
```
Reruns community detection on existing `graph.json`. No extraction, no tokens.

### Recipe 5: Name/relabel communities and show labels in the HTML viz (in-session, NO backend)
**NEVER run `graphify label` and NEVER pass `--backend`.** That command calls an external LLM provider (openai/gemini/deepseek - none configured here, so it silently falls back to `Community N` placeholders) AND it re-clusters, which renumbers communities and wipes existing labels. Community naming is done by THIS session reading the member nodes. The only correct path:

1. **Prepare** a worklist from the graph's existing community assignments (no recluster, no LLM):
   ```
   bash /home/user/.claude/plugins/graphify/scripts/local-graphify-labels.sh prepare .
   ```
   Writes `graphify-out/.graphify_community_label_worklist.json` and `graphify-out/.graphify_community_label_batches/batch_*.md` (40 communities/batch), each community listed with its top member node labels + source files.
2. **Name** every community in `graphify-out/.graphify_labels.json` as `{"<id>":"<Name>"}`. Infer each name from that community's top nodes/sources. For a large graph, fan out one subagent per `batch_*.md` (Agent tool, `run_in_background: true`) and merge their `{id:name}` maps. Rules: unique, specific, 2-6 words, Title Case; NO placeholders (`Community 12`), NO numeric suffixes (`Auth 2`) - qualify by source/domain instead (`Vault Crypto`, `Vault Proxy Routing`). Every current community id must be present.
3. **Apply** (validates uniqueness, regenerates `GRAPH_REPORT.md` + `graph.html` with `community_labels` + `callflow.html` from existing communities - no recluster, no backend):
   ```
   bash /home/user/.claude/plugins/graphify/scripts/local-graphify-labels.sh apply .
   ```
   The labeled `graph.html` is where names appear in the viz. If apply reports `duplicate_exact` / `numbered_duplicate` / `duplicate_base` / `placeholder`, fix those ids in `.graphify_labels.json` and re-run apply.
4. **Merge into the global graph** (so cross-repo MCP queries see this repo's nodes/edges), then commit:
   ```
   flock -w 5 /tmp/graphify-global.lock graphify global add graphify-out/graph.json --as "$(basename "$PWD")"
   ```
   `global add` is hash-keyed on node/edge content, so it no-ops when only labels changed - that is expected, not a failure. Community **names** live in `graphify-out/.graphify_labels.json` and the regenerated `graph.html`, NOT in the global graph: `graph_stats` reporting `Communities: 0` for the global graph is its normal state and is not "fixed" by labeling. Commit only `graph.json`, `GRAPH_REPORT.md`, `graph.html`, `callflow.html`, and `.graphify_labels.json`.

## Codeflare-specific operational notes

1. **MCP query tools are always available.** Even before any graph is built, you can call `mcp__graphify__query_graph`, `mcp__graphify__get_node`, `mcp__graphify__get_neighbors`, and `mcp__graphify__shortest_path`. They return useful errors when no graph is present. After a build, point them at `graphify-out/graph.json` in the current cwd.

2. **Never use an external LLM backend; never run `graphify label`.** Do NOT pass `--backend openai` (or `--backend gemini` / `--backend deepseek`) to any command, and NEVER run `graphify label` - it requires a provider backend AND re-clusters, which renumbers communities and discards existing labels. Codeflare configures no third-party LLM API keys. Semantic extraction uses in-session Claude subagents (the chunking model below); community naming uses the in-session `local-graphify-labels.sh` flow (Recipe 5). Both are the canonical paths.

3. **Persistence lives in git, not R2.** The graph travels with the repo. After your first `/graphify` build in a repo the user has push permission to:
   - Add to the repo's `.gitignore` (create if absent):
     ```
     graphify-out/cache/
     graphify-out/.cache/
     graphify-out/.chunks/
     graphify-out/manifest.json
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
     .graphify_community_label_worklist.json
     .graphify_community_label_batches/
     .graphify_root
     /.graphify_labels.json
     ```
     All patterns are regenerable; only `graph.json`, `GRAPH_REPORT.md`, `graph.html`, `callflow.html`, and `.graphify_labels.json` are committed (plus optional `wiki/`). The leading `/` on `/.graphify_labels.json` ignores only a stray root-level marker, never the committed `graphify-out/.graphify_labels.json`. The `local-graphify-labels.sh prepare` worklist + batches are working intermediates - never commit them.
   - Add to the repo's `.gitattributes` (create if absent):
     ```
     graphify-out/graph.json merge=graphify
     ```
     This wires the graphify semantic merge driver for `graph.json`. The driver itself is registered globally in the container image, so this `.gitattributes` line is the only per-repo setup needed. Without it, concurrent edits produce corrupt JSON on merge.
   - Stage and commit `graphify-out/graph.json`, `GRAPH_REPORT.md`, `graph.html`, `callflow.html`, `.graphify_labels.json`, and optionally `wiki/`.
   - For repos the user does NOT have push permission to (cloned open-source projects, read-only forks): graphify-out/ stays in the working tree only, ephemeral, no R2 fallback. Do not try to persist via bisync.
   - **Before the commit step, merge this repo's graph into the unified global graph** so `mcp__graphify__*` tool calls see it alongside the vault and any other active repos: `flock -w 5 /tmp/graphify-global.lock graphify global add graphify-out/graph.json --as <repo-basename>`. Hash-keyed and idempotent. The `flock -w 5` serialises against the capture agent and the vault-extract agent; the 5s timeout prevents a wedged writer from blocking the queue.

4. **Bias toward `--update` and `cluster-only` for repeat runs.** Full LLM extraction is expensive. After the first build:
 - For source changes: `bash /home/user/.claude/plugins/graphify/scripts/safe-graphify-update.sh .` (AST-only, free, no token cost; wraps `graphify update` with `GRAPHIFY_MAX_WORKERS=1` + `ulimit -v 1500000` so a runaway rebuild on a large repo cannot OOM-kill the codeflare session).
 - For repos larger than 2000 files: `graphify cluster-only . --no-viz` (AST-only first build).

5. **Context boundedness.** Graphify's own subagent-chunking model bounds the main session context, so extraction works without context-mode or `ctx_*` tools. No per-tier branching is needed in this skill.

6. **AskUserQuestion on clone - never auto-update.** A PostToolUse hook (`graphify-clone-prompt.sh`) injects a directive after `git clone` / `gh repo clone`. At clone time, if no graph exists, ask the user which graph action they want before running any build: **AST-only**, **Full semantic**, or **No graph action**. If an existing graph is stale/unknown, ask before running any update and offer **Use existing graph as-is**, **AST-only update**, or **Full semantic refresh**. If an existing graph is fresh, only print an informational note and use it. A clone-time AST-only choice is a final build-mode choice for this skill after detection. A clone-time Full semantic choice is intent only: after detection, show the actual uncached file/subagent counts and ask for confirmation before dispatching semantic subagents. Respect a NO without arguing.

7. **Discipline rule.** When `graphify-out/graph.json` exists, `~/.claude/rules/graph-first.md` applies: prefer focused MCP queries over Grep for architecture, dependency, and call-flow questions.

8. **Mandatory build-mode choice before any extraction.** Before dispatching Part B subagents (Step B2 of the upstream protocol), ALWAYS present the user with an `AskUserQuestion` offering exactly two modes unless the user already chose AST-only in the current clone-time triage prompt. If the clone-time triage captured Full semantic intent, do not dispatch semantic subagents yet; after detection, present a confirmation with the same Full-mode cost/count details below:
   - **AST-only** - free, no token cost; code structure + call/import/contains edges only; no semantic concepts from docs / papers / images.
   - **Full (AST + semantic)** - AST plus N parallel Sonnet subagents extracting concepts from docs / papers / images. Include the actual subagent count (`ceil(uncached_doc_paper_files / 22) + uncached_image_count`) and a wall-time estimate (~45s per parallel batch).

   Choose by intent, not size. **AST-only** when testing the pipeline, exploring for a one-off question, or cost-capping. **Full** when this is a long-term project and the user wants semantic concepts from docs/images in MCP queries.

   Skip the mode question only when (a) the corpus has zero docs / papers / images (code-only fast path makes the choice moot), (b) `--no-semantic` was passed explicitly, or (c) the user already chose AST-only in the current clone-time triage prompt. If AST-only is chosen, skip Part B entirely and treat AST as the full extraction (same flow as the code-only fast path). If Full semantic was chosen at clone time, ask only the post-detection cost/count confirmation; a Yes proceeds to Part B, and a No falls back to AST-only/no graph per the user's answer.

   This choice is separate from the "split by subfolder" question the upstream protocol asks on > 200 files - ask both in sequence (subfolder first, then build mode against the chosen scope).

9. **Spawn Part B semantic subagents with `model: "sonnet"`.** Graphify semantic extraction requires reliable schema compliance - each subagent must emit valid JSON with correct `id`, `source_file`, and `confidence_score` fields. Haiku produced 57% malformed nodes on the codeflare corpus (288/504 dropped during post-filter); Sonnet's structured-output fidelity eliminates this waste. The `Task` calls in Step B2 must include `model: "sonnet"`. Never escalate to Opus from this skill.

---

The upstream graphify extraction pipeline is reproduced below in full. It is the canonical algorithm; do not improvise on it. The two operational notes above (#8 mandatory build-mode question, #9 Sonnet subagents) are codeflare-specific overrides that bind on top of the upstream Step 1 + Step B2 below - apply them even where the upstream text does not mention them.

---

graphify turns any folder of files into a navigable knowledge graph with community detection, an honest audit trail, and three outputs: interactive HTML, GraphRAG-ready JSON, and a plain-language GRAPH_REPORT.md.

## What You Must Do When Invoked

If no path was given, use `.` (current directory). Do not ask the user for a path.

Follow these steps in order. Do not skip steps.

### Step 1 - Detect files

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.detect import detect
from pathlib import Path
result = detect(Path('INPUT_PATH'))
print(json.dumps(result))
" > .graphify_detect.json
```

Replace INPUT_PATH with the actual path the user provided. Do NOT cat or print the JSON - read it silently and present a clean summary instead:

```
Corpus: X files ~ ~Y words
 code: N files (.py .ts .go ...)
 document: N files (.md .txt ...)
 paper: N files (.pdf ...)
 image: N files
```

Then act on it:
- If `total_files` is 0: stop with "No supported files found in [path]."
- If `skipped_sensitive` is non-empty: mention file count skipped, not the file names.
- If `total_words` > 2,000,000 OR `total_files` > 200: show the warning and the top 5 subdirectories by file count, then ask which subfolder to run on. Wait for the user's answer before proceeding.
- Otherwise: proceed directly to Step 2 - no need to ask anything.

### Step 2 - Extract entities and relationships

This step runs structural (AST, free) and semantic (Claude subagents, costs tokens) extraction in parallel, then merges them. The two codeflare overrides bind here: the mandatory build-mode question (operational note 8) before Part B, and `model: "sonnet"` subagents (operational note 9). For the full Part A / Part B / Part C pipeline, the wave structure, the exact subagent prompt, and the extraction JSON schema, see `references/extraction-spec.md`.

### Steps 3-7 - Build, cluster, label, visualize, report

After extraction produces `.graphify_extract.json`, build the graph, cluster it, label communities, generate the Obsidian vault + HTML, benchmark (only if `total_words > 5000`), save the manifest, clean up, and report. See `references/build.md` for all five steps.

## Incremental Updates and --cluster-only

For repeat runs, bias toward `--update` (re-extracts only new/changed files) and `cluster-only` (reruns clustering on the existing graph) over a full LLM rebuild (operational note 4). The cheap AST-only refresh is `bash /home/user/.claude/plugins/graphify/scripts/safe-graphify-update.sh .` (wraps `graphify update`). For the full `--update` procedure (code-only fast path, merge, graph diff) and the `--cluster-only` flow, see `references/update.md`.

## Query, Path, Explain

For graph queries, prefer the MCP tools directly (`mcp__graphify__query_graph`, `mcp__graphify__get_node`, `mcp__graphify__get_neighbors`, `mcp__graphify__shortest_path`, `mcp__graphify__get_community`, `mcp__graphify__god_nodes`) - always available when a graph exists. After answering a query, path, or explain, persist the Q&A back into the graph with `graphify save-result` so the next update extracts it as a node. For the save-result feedback loop (`--type query` / `path_query` / `explain`), the CLI/NetworkX fallback, and the `/graphify add`, `--watch`, and export flows, see `references/query.md`.


## Honesty Rules

- Never invent an edge. If unsure, use AMBIGUOUS.
- Never skip the corpus check warning.
- Always show token cost in the report.
- Never hide cohesion scores behind symbols - show the raw number.
- Never skip HTML viz. Codeflare sets `GRAPHIFY_VIZ_NODE_LIMIT=100000` globally in entrypoint.sh; if a build ever logs `Skipped graph.html`, re-export the limit and rebuild before reporting done.
