# Step 2 - Extract entities and relationships

Load this for the full Step 2 extraction pipeline. The two codeflare overrides bind on top of it: the mandatory build-mode question (operational note 8) fires before Part B, and Part B subagents spawn with `model: "sonnet"` (operational note 9). Apply them even where the text below does not mention them.

**Before starting:** note whether `--mode deep` was given. You must pass `DEEP_MODE=true` to every subagent in Step B2 if it was. Track this from the original invocation - do not lose it.

This step has two parts: **structural extraction** (deterministic, free) and **semantic extraction** (Claude, costs tokens).

**Run Part A (AST) and Part B (semantic) in parallel. Start AST extraction in the same message as the FIRST semantic wave (Step B2). AST runs alongside the first wave; subsequent waves run after AST has already finished. Merge results in Part C as before.**

Note: Parallelizing AST + the first semantic wave saves 5-15s on large corpora. AST is deterministic and fast; start it while the first wave of subagents is processing docs/papers. Step B2 below describes the wave structure (cap at `GRAPHIFY_SEMANTIC_MAX_PARALLEL`, default 10) that prevents 100-subagent bursts from flooding Task-tool concurrency.

## Part A - Structural extraction for code files

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

## Part B - Semantic extraction (parallel subagents)

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

Call the Agent tool multiple times IN THE SAME RESPONSE - one call per chunk within a wave. Subagents in the same message run in parallel. If you make one Agent call, wait, then make another inside the same wave, you are doing it sequentially and defeating the purpose. Every `Task` call must include `model: "sonnet"` (operational note 9) - never escalate to Opus.

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

## Part C - Merge AST + semantic into final extraction

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

After Part C, continue with Steps 3-7 - see `references/build.md`.
