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

6. **AskUserQuestion on clone - YES/NO only, NOT mode.** A PostToolUse hook (`graphify-clone-prompt.sh`) injects a directive after `git clone` / `gh repo clone`. At clone time you ask **one** yes/no question: "Build a graphify knowledge graph for `<dir>`?". Recommend YES for repos with more than 50 files. **Do NOT ask about build mode (AST-only vs Full) at clone time** - that question is owned by note #8 below and fires from inside the skill *after* it loads, when the corpus has actually been detected and the cost surface (file counts, image counts, agent count) can be surfaced in the prompt. Asking the mode question both at clone time AND inside the skill is a duplicate-question bug; the user sees the same prompt twice. Respect a NO without arguing.

7. **Discipline rule.** When `graphify-out/graph.json` exists, `~/.claude/rules/graph-first.md` applies: prefer focused MCP queries over Grep for architecture, dependency, and call-flow questions.

8. **Mandatory build-mode choice before any extraction.** Before dispatching Part B subagents (Step B2 of the upstream protocol), ALWAYS present the user with an `AskUserQuestion` offering exactly two modes:
   - **AST-only** - free, no token cost; code structure + call/import/contains edges only; no semantic concepts from docs / papers / images.
   - **Full (AST + semantic)** - AST plus N parallel Sonnet subagents extracting concepts from docs / papers / images. Include the actual subagent count (`ceil(uncached_doc_paper_files / 22) + uncached_image_count`) and a wall-time estimate (~45s per parallel batch).

   Choose by intent, not size. **AST-only** when testing the pipeline, exploring for a one-off question, or cost-capping. **Full** when this is a long-term project and the user wants semantic concepts from docs/images in MCP queries.

   Skip the question only when (a) the corpus has zero docs / papers / images (code-only fast path makes the choice moot), or (b) `--no-semantic` was passed explicitly. If AST-only is chosen, skip Part B entirely and treat AST as the full extraction (same flow as the code-only fast path).

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

**Before starting:** note whether `--mode deep` was given. You must pass `DEEP_MODE=true` to every subagent in Step B2 if it was. Track this from the original invocation - do not lose it.

This step has two parts: **structural extraction** (deterministic, free) and **semantic extraction** (Claude, costs tokens).

**Run Part A (AST) and Part B (semantic) in parallel. Start AST extraction in the same message as the FIRST semantic wave (Step B2). AST runs alongside the first wave; subsequent waves run after AST has already finished. Merge results in Part C as before.**

Note: Parallelizing AST + the first semantic wave saves 5-15s on large corpora. AST is deterministic and fast; start it while the first wave of subagents is processing docs/papers. Step B2 below describes the wave structure (cap at `GRAPHIFY_SEMANTIC_MAX_PARALLEL`, default 10) that prevents 100-subagent bursts from flooding Task-tool concurrency.

#### Part A - Structural extraction for code files

For any code files detected, run AST extraction in parallel with Part B subagents:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.extract import collect_files, extract
from pathlib import Path

code_files = []
detect = json.loads(Path('.graphify_detect.json').read_text())
for f in detect.get('files', {}).get('code', []):
 code_files.extend(collect_files(Path(f)) if Path(f).is_dir() else [Path(f)])

if code_files:
 result = extract(code_files)
 Path('.graphify_ast.json').write_text(json.dumps(result, indent=2))
 print(f'AST: {len(result[\"nodes\"])} nodes, {len(result[\"edges\"])} edges')
else:
 Path('.graphify_ast.json').write_text(json.dumps({'nodes':[],'edges':[],'input_tokens':0,'output_tokens':0}))
 print('No code files - skipping AST extraction')
"
```

#### Part B - Semantic extraction (parallel subagents)

**Fast path:** If detection found zero `document`, `paper`, and `image` files (code-only corpus), skip Part B entirely and go straight to Part C. AST handles code - there is nothing for semantic subagents to do.

**MANDATORY: You MUST use the Agent tool here. Reading files yourself one-by-one is forbidden - it is 5-10x slower. If you do not use the Agent tool you are doing this wrong.**

Before dispatching subagents, print a timing estimate:
- Load `total_words` and file counts from `.graphify_detect.json`
- Estimate agents needed: `ceil(uncached_doc_paper_files / 22) + uncached_image_count` (chunk size 20-25 for text; each image gets its own chunk)
- Read the parallelism cap: `parallel_limit = int(os.environ.get('GRAPHIFY_SEMANTIC_MAX_PARALLEL', '10'))`. Step B2 dispatches subagents in waves of at most this many at a time (see Step B2 for the why)
- Estimate time: ~45s per wave (each wave runs in parallel, so total is approximately 45s * ceil(agents/parallel_limit))
- Print: "Semantic extraction: ~N files -> X agents in W waves of up to parallel_limit, estimated ~Ys"

**Step B0 - Check extraction cache first**

Before dispatching any subagents, check which files already have cached extraction results:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.cache import check_semantic_cache
from pathlib import Path

detect = json.loads(Path('.graphify_detect.json').read_text())
non_code = [f for cat in ['document', 'paper', 'image'] for f in detect['files'].get(cat, [])]

cached_nodes, cached_edges, cached_hyperedges, uncached = check_semantic_cache(non_code)

if cached_nodes or cached_edges or cached_hyperedges:
 Path('.graphify_cached.json').write_text(json.dumps({'nodes': cached_nodes, 'edges': cached_edges, 'hyperedges': cached_hyperedges}))
Path('.graphify_uncached.txt').write_text('\n'.join(uncached))
print(f'Cache: {len(non_code)-len(uncached)} files hit, {len(uncached)} files need extraction')
"
```

Only dispatch subagents for files listed in `.graphify_uncached.txt`. If all files are cached, skip to Part C directly.

**Step B1 - Split into chunks**

Load files from `.graphify_uncached.txt`. Split into chunks of 20-25 files each. Each image gets its own chunk (vision needs separate context).

**Step B2 - Dispatch subagents in waves of at most `parallel_limit`**

Call the Agent tool multiple times IN THE SAME RESPONSE - one call per chunk within a wave. Subagents in the same message run in parallel. If you make one Agent call, wait, then make another inside the same wave, you are doing it sequentially and defeating the purpose.

**Wave structure (CRITICAL):** Do NOT fan out 100+ subagents at once. On a dense repo this floods Claude Code's Task-tool concurrency, can trip Anthropic API rate-limits, and risks a session timeout if the burst exceeds the per-minute token budget. Instead split chunks into **waves of at most `parallel_limit` subagents**, dispatch one wave per message, wait for the wave to complete, then dispatch the next wave. `parallel_limit` defaults to 10 and is overridable via `GRAPHIFY_SEMANTIC_MAX_PARALLEL`.

Concrete example for 3 chunks, parallel_limit=10:
```
[single message with 3 Agent tool calls: files 1-15, 16-30, 31-45]
```
All three fit in one wave because 3 is less than or equal to 10. Single message, dispatched in parallel.

Within a wave: all Agent calls in the same response. Between waves: sequential messages with full result aggregation in between.

Each subagent receives this exact prompt (substitute FILE_LIST, CHUNK_NUM, TOTAL_CHUNKS, and DEEP_MODE):

```
You are a graphify extraction subagent. Read the files listed and extract a knowledge graph fragment.
Output ONLY valid JSON matching the schema below - no explanation, no markdown fences, no preamble.

Files (chunk CHUNK_NUM of TOTAL_CHUNKS):
FILE_LIST

Rules:
- EXTRACTED: relationship explicit in source (import, call, citation, "see S3.2")
- INFERRED: reasonable inference (shared data structure, implied dependency)
- AMBIGUOUS: uncertain - flag for review, do not omit

Code files: focus on semantic edges AST cannot find (call relationships, shared data, arch patterns).
 Do not re-extract imports - AST already has those.
Doc/paper files: extract named concepts, entities, citations.
Image files: use vision to understand what the image IS - do not just OCR.
 UI screenshot: layout patterns, design decisions, key elements, purpose.
 Chart: metric, trend/insight, data source.
 Tweet/post: claim as node, author, concepts mentioned.
 Diagram: components and connections.
 Research figure: what it demonstrates, method, result.
 Handwritten/whiteboard: ideas and arrows, mark uncertain readings AMBIGUOUS.

DEEP_MODE (if --mode deep was given): be aggressive with INFERRED edges - indirect deps,
 shared assumptions, latent couplings. Mark uncertain ones AMBIGUOUS instead of omitting.

Semantic similarity: if two concepts in this chunk solve the same problem or represent the same idea without any structural link (no import, no call, no citation), add a `semantically_similar_to` edge marked INFERRED with a confidence_score reflecting how similar they are (0.6-0.95). Examples:
- Two functions that both validate user input but never call each other
- A class in code and a concept in a paper that describe the same algorithm
- Two error types that handle the same failure mode differently
Only add these when the similarity is genuinely non-obvious and cross-cutting. Do not add them for trivially similar things.

Hyperedges: if 3 or more nodes clearly participate together in a shared concept, flow, or pattern that is not captured by pairwise edges alone, add a hyperedge to a top-level `hyperedges` array. Examples:
- All classes that implement a common protocol or interface
- All functions in an authentication flow (even if they don't all call each other)
- All concepts from a paper section that form one coherent idea
Use sparingly - only when the group relationship adds information beyond the pairwise edges. Maximum 3 hyperedges per chunk.

If a file has YAML frontmatter (--- ... ---), copy source_url, captured_at, author,
 contributor onto every node from that file.

confidence_score rules:
- EXTRACTED edges: confidence_score must be 1.0
- INFERRED edges: score 0.4-0.9 based on how certain you are.
 Strong structural inference (e.g. two classes clearly share data): 0.8-0.9.
 Reasonable but not certain: 0.6-0.7. Weak inference: 0.4-0.5.
- AMBIGUOUS edges: score 0.1-0.3

Output exactly this JSON (no other text):
{"nodes":[{"id":"filestem_entityname","label":"Human Readable Name","file_type":"code|document|paper|image","source_file":"relative/path","source_location":null,"source_url":null,"captured_at":null,"author":null,"contributor":null}],"edges":[{"source":"node_id","target":"node_id","relation":"calls|implements|references|cites|conceptually_related_to|shares_data_with|semantically_similar_to","confidence":"EXTRACTED|INFERRED|AMBIGUOUS","confidence_score":1.0,"source_file":"relative/path","source_location":null,"weight":1.0}],"hyperedges":[{"id":"snake_case_id","label":"Human Readable Label","nodes":["node_id1","node_id2","node_id3"],"relation":"participate_in|implement|form","confidence":"EXTRACTED|INFERRED","confidence_score":0.75,"source_file":"relative/path"}],"input_tokens":0,"output_tokens":0}
```

**Step B3 - Collect, cache, and merge**

Wait for all subagents. For each result:
- If a subagent returned valid JSON with `nodes` and `edges`, include it and save each file's nodes/edges to the cache
- If a subagent failed or returned invalid JSON, print a warning and skip that chunk - do not abort

If more than half the chunks failed, stop and tell the user.

Save new results to cache:
```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.cache import save_semantic_cache
from pathlib import Path

new = json.loads(Path('.graphify_semantic_new.json').read_text()) if Path('.graphify_semantic_new.json').exists() else {'nodes':[],'edges':[],'hyperedges':[]}
saved = save_semantic_cache(new.get('nodes', []), new.get('edges', []), new.get('hyperedges', []))
print(f'Cached {saved} files')
"
```

Merge cached + new results into `.graphify_semantic.json`:
```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from pathlib import Path

cached = json.loads(Path('.graphify_cached.json').read_text()) if Path('.graphify_cached.json').exists() else {'nodes':[],'edges':[],'hyperedges':[]}
new = json.loads(Path('.graphify_semantic_new.json').read_text()) if Path('.graphify_semantic_new.json').exists() else {'nodes':[],'edges':[],'hyperedges':[]}

all_nodes = cached['nodes'] + new.get('nodes', [])
all_edges = cached['edges'] + new.get('edges', [])
all_hyperedges = cached.get('hyperedges', []) + new.get('hyperedges', [])
seen = set()
deduped = []
for n in all_nodes:
 if n['id'] not in seen:
 seen.add(n['id'])
 deduped.append(n)

merged = {
 'nodes': deduped,
 'edges': all_edges,
 'hyperedges': all_hyperedges,
 'input_tokens': new.get('input_tokens', 0),
 'output_tokens': new.get('output_tokens', 0),
}
Path('.graphify_semantic.json').write_text(json.dumps(merged, indent=2))
print(f'Extraction complete - {len(deduped)} nodes, {len(all_edges)} edges, {len(all_hyperedges)} hyperedges ({len(cached[\"nodes\"])} from cache, {len(new.get(\"nodes\",[]))} new)')
"
```
Clean up temp files: `rm -f .graphify_cached.json .graphify_uncached.txt .graphify_semantic_new.json`

#### Part C - Merge AST + semantic into final extraction

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from pathlib import Path

ast = json.loads(Path('.graphify_ast.json').read_text())
sem = json.loads(Path('.graphify_semantic.json').read_text())

# Merge: AST nodes first, semantic nodes deduplicated by id
seen = {n['id'] for n in ast['nodes']}
merged_nodes = list(ast['nodes'])
for n in sem['nodes']:
 if n['id'] not in seen:
 merged_nodes.append(n)
 seen.add(n['id'])

merged_edges = ast['edges'] + sem['edges']
merged_hyperedges = sem.get('hyperedges', [])

merged = {
 'nodes': merged_nodes,
 'edges': merged_edges,
 'hyperedges': merged_hyperedges,
 'input_tokens': sem.get('input_tokens', 0),
 'output_tokens': sem.get('output_tokens', 0),
}
Path('.graphify_extract.json').write_text(json.dumps(merged, indent=2))
total = len(merged_nodes)
edges = len(merged_edges)
print(f'Merged: {total} nodes, {edges} edges, {len(merged_hyperedges)} hyperedges ({len(ast[\"nodes\"])} AST + {len(sem[\"nodes\"])} semantic)')
"
```

### Step 3 - Build graph, cluster, analyze, generate outputs

```bash
mkdir -p graphify-out
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json
from pathlib import Path

extraction = json.loads(Path('.graphify_extract.json').read_text())
detection = json.loads(Path('.graphify_detect.json').read_text())

G = build_from_json(extraction)
communities = cluster(G)
cohesion = score_all(G, communities)
tokens = {'input': extraction.get('input_tokens', 0), 'output': extraction.get('output_tokens', 0)}
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
labels = {cid: 'Community ' + str(cid) for cid in communities}
# Placeholder questions - regenerated with real labels in Step 4
questions = suggest_questions(G, communities, labels)

report = generate(G, communities, cohesion, labels, gods, surprises, detection, tokens, 'INPUT_PATH', suggested_questions=questions)
Path('graphify-out/GRAPH_REPORT.md').write_text(report)
to_json(G, communities, 'graphify-out/graph.json')

analysis = {
 'communities': {str(k): v for k, v in communities.items()},
 'cohesion': {str(k): v for k, v in cohesion.items()},
 'gods': gods,
 'surprises': surprises,
 'questions': questions,
}
Path('.graphify_analysis.json').write_text(json.dumps(analysis, indent=2))
if G.number_of_nodes() == 0:
 print('ERROR: Graph is empty - extraction produced no nodes.')
 print('Possible causes: all files were skipped, binary-only corpus, or extraction failed.')
 raise SystemExit(1)
print(f'Graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {len(communities)} communities')
"
```

If this step prints `ERROR: Graph is empty`, stop and tell the user what happened - do not proceed to labeling or visualization.

Replace INPUT_PATH with the actual path.

### Step 4 - Label communities

Read `.graphify_analysis.json`. For each community key, look at its node labels and write a 2-5 word plain-language name (e.g. "Attention Mechanism", "Training Pipeline", "Data Loading").

Then regenerate the report and save the labels for the visualizer:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.build import build_from_json
from graphify.cluster import score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from pathlib import Path

extraction = json.loads(Path('.graphify_extract.json').read_text())
detection = json.loads(Path('.graphify_detect.json').read_text())
analysis = json.loads(Path('.graphify_analysis.json').read_text())

G = build_from_json(extraction)
communities = {int(k): v for k, v in analysis['communities'].items()}
cohesion = {int(k): v for k, v in analysis['cohesion'].items()}
tokens = {'input': extraction.get('input_tokens', 0), 'output': extraction.get('output_tokens', 0)}

# LABELS - replace these with the names you chose above
labels = LABELS_DICT

# Regenerate questions with real community labels (labels affect question phrasing)
questions = suggest_questions(G, communities, labels)

report = generate(G, communities, cohesion, labels, analysis['gods'], analysis['surprises'], detection, tokens, 'INPUT_PATH', suggested_questions=questions)
Path('graphify-out/GRAPH_REPORT.md').write_text(report)
Path('.graphify_labels.json').write_text(json.dumps({str(k): v for k, v in labels.items()}))
print('Report updated with community labels')
"
```

Replace `LABELS_DICT` with the actual dict you constructed (e.g. `{0: "Attention Mechanism", 1: "Training Pipeline"}`).
Replace INPUT_PATH with the actual path.

### Step 5 - Generate Obsidian vault + HTML

**Always generate the Obsidian vault and HTML** - they are the primary visualizations. Skip both if `--no-viz` (report + JSON only).

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.build import build_from_json
from graphify.export import to_obsidian, to_canvas
from pathlib import Path

extraction = json.loads(Path('.graphify_extract.json').read_text())
analysis = json.loads(Path('.graphify_analysis.json').read_text())
labels_raw = json.loads(Path('.graphify_labels.json').read_text()) if Path('.graphify_labels.json').exists() else {}

G = build_from_json(extraction)
communities = {int(k): v for k, v in analysis['communities'].items()}
cohesion = {int(k): v for k, v in analysis['cohesion'].items()}
labels = {int(k): v for k, v in labels_raw.items()}

n = to_obsidian(G, communities, 'graphify-out/obsidian', community_labels=labels or None, cohesion=cohesion)
print(f'Obsidian vault: {n} notes in graphify-out/obsidian/')

to_canvas(G, communities, 'graphify-out/obsidian/graph.canvas', community_labels=labels or None)
print('Canvas: graphify-out/obsidian/graph.canvas - open in Obsidian for structured community layout')
print()
print('Open graphify-out/obsidian/ as a vault in Obsidian.')
print(' Graph view - nodes colored by community (set automatically)')
print(' graph.canvas - structured layout with communities as groups')
print(' _COMMUNITY_* - overview notes with cohesion scores and dataview queries')
"
```

Also generate the HTML graph (always, unless `--no-viz`):

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.build import build_from_json
from graphify.export import to_html
from pathlib import Path

extraction = json.loads(Path('.graphify_extract.json').read_text())
analysis = json.loads(Path('.graphify_analysis.json').read_text())
labels_raw = json.loads(Path('.graphify_labels.json').read_text()) if Path('.graphify_labels.json').exists() else {}

G = build_from_json(extraction)
communities = {int(k): v for k, v in analysis['communities'].items()}
labels = {int(k): v for k, v in labels_raw.items()}

to_html(G, communities, 'graphify-out/graph.html', community_labels=labels or None)
print('graph.html written - open in any browser, no server needed')
"
```

### Step 6 - Token reduction benchmark (only if total_words > 5000)

If `total_words` from `.graphify_detect.json` is greater than 5,000, run:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.benchmark import run_benchmark, print_benchmark
from pathlib import Path

detection = json.loads(Path('.graphify_detect.json').read_text())
result = run_benchmark('graphify-out/graph.json', corpus_words=detection['total_words'])
print_benchmark(result)
"
```

Print the output directly in chat. If `total_words <= 5000`, skip silently - the graph value is structural clarity, not token compression, for small corpora.


### Step 7 - Save manifest, update cost tracker, clean up, and report

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from pathlib import Path
from datetime import datetime, timezone
from graphify.detect import save_manifest

# Save manifest for --update
detect = json.loads(Path('.graphify_detect.json').read_text())
save_manifest(detect['files'])

# Update cumulative cost tracker
extract = json.loads(Path('.graphify_extract.json').read_text())
input_tok = extract.get('input_tokens', 0)
output_tok = extract.get('output_tokens', 0)

cost_path = Path('graphify-out/cost.json')
if cost_path.exists():
 cost = json.loads(cost_path.read_text())
else:
 cost = {'runs': [], 'total_input_tokens': 0, 'total_output_tokens': 0}

cost['runs'].append({
 'date': datetime.now(timezone.utc).isoformat(),
 'input_tokens': input_tok,
 'output_tokens': output_tok,
 'files': detect.get('total_files', 0),
})
cost['total_input_tokens'] += input_tok
cost['total_output_tokens'] += output_tok
cost_path.write_text(json.dumps(cost, indent=2))

print(f'This run: {input_tok:,} input tokens, {output_tok:,} output tokens')
print(f'All time: {cost[\"total_input_tokens\"]:,} input, {cost[\"total_output_tokens\"]:,} output ({len(cost[\"runs\"])} runs)')
"
rm -f .graphify_detect.json .graphify_extract.json .graphify_ast.json .graphify_semantic.json .graphify_semantic_new.json .graphify_analysis.json .graphify_labels.json
rm -f .graphify_cached.json .graphify_uncached.txt .graphify_old.json .graphify_chunk_*.txt
rm -f graphify-out/.needs_update 2>/dev/null || true
```

Tell the user:
```
Graph complete. Outputs in graphify-out/:
 graphify-out/obsidian/ - open as a vault in Obsidian (File > Open Vault)
 graphify-out/GRAPH_REPORT.md - full audit report
 graphify-out/graph.json - persistent graph, queryable via MCP tools

Full path: PATH_TO_DIR/graphify-out/
```

Replace PATH_TO_DIR with the actual absolute path of the directory that was processed.

Then paste these sections from GRAPH_REPORT.md directly into the chat:
- God Nodes
- Surprising Connections
- Suggested Questions

Do NOT paste the full report - just those three sections. Keep it concise.

Then immediately offer to explore. Pick the single most interesting suggested question from the report - the one that crosses the most community boundaries or has the most surprising bridge node - and ask:

> "The most interesting question this graph can answer: **[question]**. Want me to trace it?"

If the user says yes, run the query on the graph using MCP tools and walk them through the answer using the graph structure - which nodes connect, which community boundaries get crossed, what the path reveals. Keep going as long as they want to explore. Each answer should end with a natural follow-up ("this connects to X - want to go deeper?") so the session feels like navigation, not a one-shot report.

The graph is the map. Your job after the pipeline is to be the guide.


## Incremental Updates

Three modes:
1. **AST-only** (default, free): `bash /home/user/.claude/plugins/graphify/scripts/safe-graphify-update.sh .` - re-extracts code structure only.
2. **Full semantic update**: Runs the full extraction pipeline on all uncached non-code files. See Recipe 2 in Quick Reference.
3. **Code-only fast path**: When `--update` detects only code file changes, semantic extraction is automatically skipped.

### --update procedure

Use when you've added or modified files since the last run. Only re-extracts changed files - saves tokens and time.

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.detect import detect_incremental, save_manifest
from pathlib import Path

result = detect_incremental(Path('INPUT_PATH'))
new_total = result.get('new_total', 0)
print(json.dumps(result, indent=2))
Path('.graphify_incremental.json').write_text(json.dumps(result))
if new_total == 0:
 print('No files changed since last run. Nothing to update.')
 raise SystemExit(0)
print(f'{new_total} new/changed file(s) to re-extract.')
"
```

If new files exist, first check whether all changed files are code files:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from pathlib import Path

result = json.loads(open('.graphify_incremental.json').read()) if Path('.graphify_incremental.json').exists() else {}
code_exts = {'.py','.ts','.js','.go','.rs','.java','.cpp','.c','.rb','.swift','.kt','.cs','.scala','.php','.cc','.cxx','.hpp','.h','.kts'}
new_files = result.get('new_files', {})
all_changed = [f for files in new_files.values() for f in files]
code_only = all(Path(f).suffix.lower() in code_exts for f in all_changed)
print('code_only:', code_only)
"
```

If `code_only` is True: print `[graphify update] Code-only changes detected - skipping semantic extraction (no LLM needed)`, run only Step 2A (AST) on the changed files, skip Step 2B entirely (no subagents), then go straight to merge and Steps 3-7.

If `code_only` is False (any changed file is a doc/paper/image): run the full Steps 2A-2C pipeline as normal.

Then:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.build import build_from_json
from graphify.export import to_json
from networkx.readwrite import json_graph
import networkx as nx
from pathlib import Path

# Load existing graph
existing_data = json.loads(Path('graphify-out/graph.json').read_text())
G_existing = json_graph.node_link_graph(existing_data, edges='links')

# Load new extraction
new_extraction = json.loads(Path('.graphify_extract.json').read_text())
G_new = build_from_json(new_extraction)

# Merge: new nodes/edges into existing graph
G_existing.update(G_new)
print(f'Merged: {G_existing.number_of_nodes()} nodes, {G_existing.number_of_edges()} edges')
" 
```

Then run Steps 3-7 on the merged graph as normal.

After Step 3, show the graph diff:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.analyze import graph_diff
from graphify.build import build_from_json
from networkx.readwrite import json_graph
import networkx as nx
from pathlib import Path

# Load old graph (before update) from backup written before merge
old_data = json.loads(Path('.graphify_old.json').read_text()) if Path('.graphify_old.json').exists() else None
new_extract = json.loads(Path('.graphify_extract.json').read_text())
G_new = build_from_json(new_extract)

if old_data:
 G_old = json_graph.node_link_graph(old_data, edges='links')
 diff = graph_diff(G_old, G_new)
 print(diff['summary'])
 if diff['new_nodes']:
 print('New nodes:', ', '.join(n['label'] for n in diff['new_nodes'][:5]))
 if diff['new_edges']:
 print('New edges:', len(diff['new_edges']))
"
```

Before the merge step, save the old graph: `cp graphify-out/graph.json .graphify_old.json`
Clean up after: `rm -f .graphify_old.json`


## For --cluster-only

Skip Steps 1-2. Load the existing graph from `graphify-out/graph.json` and re-run clustering:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python -c "
import json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections
from graphify.report import generate
from graphify.export import to_json
from networkx.readwrite import json_graph
import networkx as nx
from pathlib import Path

data = json.loads(Path('graphify-out/graph.json').read_text())
G = json_graph.node_link_graph(data, edges='links')

detection = {'total_files': 0, 'total_words': 99999, 'needs_graph': True, 'warning': None,
 'files': {'code': [], 'document': [], 'paper': []}}
tokens = {'input': 0, 'output': 0}

communities = cluster(G)
cohesion = score_all(G, communities)
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
labels = {cid: 'Community ' + str(cid) for cid in communities}

report = generate(G, communities, cohesion, labels, gods, surprises, detection, tokens, '.')
Path('graphify-out/GRAPH_REPORT.md').write_text(report)
to_json(G, communities, 'graphify-out/graph.json')

analysis = {
 'communities': {str(k): v for k, v in communities.items()},
 'cohesion': {str(k): v for k, v in cohesion.items()},
 'gods': gods,
 'surprises': surprises,
}
Path('.graphify_analysis.json').write_text(json.dumps(analysis, indent=2))
print(f'Re-clustered: {len(communities)} communities')
"
```

Then run Steps 4-7 as normal (label communities, generate viz, benchmark, clean up, report).


## Query, Path, Explain

For graph queries, use the MCP tools directly: `mcp__graphify__query_graph`, `mcp__graphify__get_node`, `mcp__graphify__get_neighbors`, `mcp__graphify__shortest_path`, `mcp__graphify__get_community`, `mcp__graphify__god_nodes`. These are always available when a graph exists.

For `/graphify add`, `--watch`, `graphify hook`, and `graphify claude` - see upstream graphify documentation (`graphify --help`). Neo4j (`--neo4j`), SVG (`--svg`), and GraphML (`--graphml`) export flags are supported but not documented here.


## Honesty Rules

- Never invent an edge. If unsure, use AMBIGUOUS.
- Never skip the corpus check warning.
- Always show token cost in the report.
- Never hide cohesion scores behind symbols - show the raw number.
- Never skip HTML viz. Codeflare sets `GRAPHIFY_VIZ_NODE_LIMIT=100000` globally in entrypoint.sh; if a build ever logs `Skipped graph.html`, re-export the limit and rebuild before reporting done.
