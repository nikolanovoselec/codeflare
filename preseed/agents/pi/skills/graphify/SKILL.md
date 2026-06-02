---
name: graphify
description: Graphify workflow for Pi/Codeflare. Build, refresh, query, explain, trace, or locate repo/Vault/session knowledge. Uses official Graphify CLI flows for AST/build/cluster/label, and Pi Agent subagents only to produce semantic cache chunks.
---

# Graphify in Pi / Codeflare

Use this skill for Graphify build, refresh, query, explain, path, and repo/Vault/global graph work.

Hard rules:

- **Use official Graphify flows** for AST detection/extraction, graph build/merge, clustering, community labeling, report, and HTML generation.
- **Do not hand-edit graph JSON.** Do not add Codeflare-specific AST allowlists, import rewrites, or graph normalization.
- **Interactive semantic extraction uses Pi `Agent` subagents from this running session.** Do not run headless semantic extraction for uncached docs/images.
- Community labeling is a separate official Graphify label step. It is not semantic extraction.

## Graph paths

```text
Repo graph:   <repo>/graphify-out/graph.json
Vault graph:  /home/user/Vault/graphify-out/graph.json
Global graph: /home/user/.graphify/global-graph.json
```

There is normally no `/home/user/workspace/graphify-out/graph.json`.

## Query workflow

For repo/code questions, use native Pi tools first:

- Broad context: `graphify_query({ question, mode: "bfs" })`
- Trace/path: `graphify_query({ question, mode: "dfs" })` or `graphify_path`
- Node details: `graphify_explain({ concept })`

If the native tool resolves the workspace root instead of the active repo, use CLI fallback:

```bash
graphify query "<question>" --graph <repo>/graphify-out/graph.json
graphify path "A" "B" --graph <repo>/graphify-out/graph.json
graphify explain "X" --graph <repo>/graphify-out/graph.json
```

For Vault/session/cross-repo memory, use the global graph explicitly:

```bash
graphify query "<question>" --graph /home/user/.graphify/global-graph.json
```

## Clone-time triage

Clone-time prompt is YES/NO only: “Build a graphify knowledge graph for `<repo>`?”

Do **not** ask AST-only vs Full at clone time. This skill owns the mode choice after Graphify detection has real corpus counts.

## Detect corpus

From the repo root:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python - <<'PY'
import json
from pathlib import Path
from graphify.detect import detect
Path('.graphify_detect.json').write_text(json.dumps(detect(Path('.').resolve()), indent=2), encoding='utf-8')
PY
/root/.local/share/uv/tools/graphifyy/bin/python - <<'PY'
import json
from pathlib import Path
result = json.loads(Path('.graphify_detect.json').read_text())
print(f"Corpus: {result.get('total_files', 0)} files · ~{result.get('total_words', 0)} words")
for key in ['code', 'document', 'paper', 'image', 'video']:
    count = len(result.get('files', {}).get(key, []))
    if count:
        print(f"  {key}: {count}")
PY
```

If the user asks to ignore a file class (for example images), pass matching `--exclude` flags to official Graphify commands. Do not alter code detection.

## Mandatory mode choice

After detection, ask the user to choose exactly one mode unless there are zero docs/papers/images:

1. **AST-only** — official Graphify AST/code graph, free/local.
2. **Full (AST + semantic)** — Pi Agent subagents produce semantic chunks for docs/papers/images, then official Graphify consumes the semantic cache and builds/labels the graph.

## AST-only initial build

Use this only when `graphify-out/graph.json` is missing:

```bash
bash /home/user/.pi/agent/scripts/build-graphify-ast.sh .
graphify label . --backend=gemini
```

The script uses Graphify’s own `detect`, `extract`, `build`, `cluster`, `report`, and `export` modules only. It does not rewrite Graphify output.

If `graphify label` cannot label communities because credentials are unavailable, continue with the graph but tell the user communities remain placeholders.

## AST-only refresh for an existing graph

Use this when `graphify-out/graph.json` exists and source code changed:

```bash
bash /home/user/.pi/agent/scripts/safe-graphify-update.sh .
graphify label . --backend=gemini
```

The safety wrapper only sets `GRAPHIFY_MAX_WORKERS`, applies `ulimit -v`, and execs upstream `graphify update`.

## Full build/update without headless semantic extraction

### Step 1 — create semantic file list

Use Graphify detection. Include documents, papers, and images unless the user explicitly excludes images.

```bash
/root/.local/share/uv/tools/graphifyy/bin/python - <<'PY'
import json
from pathlib import Path
from graphify.cache import check_semantic_cache
root = Path('.').resolve()
detect_result = json.loads(Path('.graphify_detect.json').read_text())
skip_images = Path('graphify-out/.graphify_skip_images').exists()
categories = ['document', 'paper'] + ([] if skip_images else ['image'])
files = [f for cat in categories for f in detect_result.get('files', {}).get(cat, [])]
Path('graphify-out').mkdir(exist_ok=True)
Path('graphify-out/.graphify_semantic_files.txt').write_text('\n'.join(files), encoding='utf-8')
cached_nodes, cached_edges, cached_hyperedges, uncached = check_semantic_cache(files, root=root)
Path('graphify-out/.graphify_cached.json').write_text(json.dumps({'nodes': cached_nodes, 'edges': cached_edges, 'hyperedges': cached_hyperedges}, ensure_ascii=False), encoding='utf-8')
Path('graphify-out/.graphify_uncached.txt').write_text('\n'.join(uncached), encoding='utf-8')
print(f"Semantic cache: {len(files) - len(uncached)} hit, {len(uncached)} need Pi Agent extraction")
PY
```

### Step 2 — dispatch Pi Agent semantic subagents for uncached files

Split `graphify-out/.graphify_uncached.txt` into chunks:

- text docs/papers: 20–25 files per chunk
- images: one per chunk, only when included
- launch all chunks with `run_in_background: true`; Pi queues beyond its concurrency limit

Do not pass a model override. The subagents use the running session model.

Each subagent must write one JSON file under `graphify-out/.graphify_chunk_NNN.json` matching Graphify schema:

```json
{"nodes":[],"edges":[],"hyperedges":[],"input_tokens":0,"output_tokens":0}
```

Rules for subagents:

- Read only the assigned files.
- Use repo-relative `source_file` values.
- Valid `file_type`: `code`, `document`, `paper`, `image`, `rationale`, `concept`.
- Valid `confidence`: `EXTRACTED`, `INFERRED`, `AMBIGUOUS`.
- Every edge needs `confidence_score`.
- Do not invent unreadable files or facts.

### Step 3 — merge chunks into Graphify semantic cache

Use Graphify's cache API; do not hand-edit graph output JSON:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python - <<'PY'
import glob
import json
from pathlib import Path
from graphify.cache import save_semantic_cache
root = Path('.').resolve()
merged = {'nodes': [], 'edges': [], 'hyperedges': [], 'input_tokens': 0, 'output_tokens': 0}
for name in sorted(glob.glob('graphify-out/.graphify_chunk_*.json')):
    chunk = json.loads(Path(name).read_text())
    merged['nodes'].extend(chunk.get('nodes', []))
    merged['edges'].extend(chunk.get('edges', []))
    merged['hyperedges'].extend(chunk.get('hyperedges', []))
    merged['input_tokens'] += int(chunk.get('input_tokens', 0) or 0)
    merged['output_tokens'] += int(chunk.get('output_tokens', 0) or 0)
Path('graphify-out/.graphify_semantic_new.json').write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding='utf-8')
saved = save_semantic_cache(merged['nodes'], merged['edges'], merged['hyperedges'], root=root)
print(f"Semantic cache saved for {saved} files")
PY
```

Re-run Step 1's cache check. If any selected semantic files are still uncached, stop and fix the failed chunks. Do not let official `graphify extract` perform semantic extraction for misses.

### Step 4 — official Graphify build from AST + cached semantic

Now run official Graphify extraction. Because the semantic cache is complete, this performs AST extraction and consumes cached semantic chunks.

Use image excludes if the user asked to skip images:

```bash
GRAPHIFY_MAX_WORKERS=1 graphify extract . --backend=gemini --max-workers 1
# example when skipping images:
GRAPHIFY_MAX_WORKERS=1 graphify extract . --backend=gemini --max-workers 1 \
  --exclude '*.png' --exclude '*.jpg' --exclude '*.jpeg' --exclude '*.gif' --exclude '*.webp' --exclude '*.svg'
```

The output must say semantic cache hits and zero misses, for example:

```text
[graphify extract] semantic cache: N hit / 0 miss
[graphify extract] semantic cache: N cached, 0 re-extracted
```

If Gemini credentials are unavailable, stop and tell the user the final official extract step needs credentials even though cache misses must be zero. If it reports semantic extraction on uncached files, stop; do not continue.

### Step 5 — official community labeling and outputs

Run official label/report/html generation:

```bash
graphify label . --backend=gemini
```

Then generate callflow when requested:

```bash
graphify export callflow-html --graph graphify-out/graph.json --output graphify-out/callflow.html
```

If the `graphify export callflow-html` CLI form is unavailable, use the Pi `graphify_export_callflow` tool with explicit paths.

## Validation checklist

After build/refresh, verify:

- `graphify-out/graph.json` exists
- `graphify-out/GRAPH_REPORT.md` exists
- `graphify-out/graph.html` exists
- node/edge counts are nonzero
- duplicate IDs = 0
- dangling edges = 0
- semantic cache was preserved for Full mode
- communities are named; if many remain `Community N`, report that labeling was incomplete

## Global merge and git persistence

Merge into the global graph:

```bash
flock -w 5 /tmp/graphify-global.lock graphify global add graphify-out/graph.json --as "$(basename "$PWD")"
```

Commit only durable outputs when the user can push:

- `graphify-out/graph.json`
- `graphify-out/GRAPH_REPORT.md`
- `graphify-out/graph.html`
- optional `graphify-out/callflow.html`
- optional `graphify-out/wiki/`

Do not commit caches, manifests, chunks, or `.graphify_*` intermediates unless explicitly asked.

Ensure `.gitattributes` contains:

```gitattributes
graphify-out/graph.json merge=graphify
```
