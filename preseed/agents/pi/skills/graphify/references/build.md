# Full build/update without provider LLMs

Load this for the Full repo semantic flow: Pi `subagent` tool calls produce semantic chunks for docs/papers/images, then Graphify consumes the local semantic fragments and rebuilds locally. Use this only after the user has chosen Full repo semantic (see the core skill's "Mandatory graph refresh choice") and the post-detection cost/count confirmation has passed.

The AST-only and Architecture builds do not need this file - they run `build-graphify-ast.sh` / `build-graphify-architecture.sh` directly (see the core skill). This file is for the semantic merge on top of an AST baseline.

## Step 1 — create semantic file list

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
print(f"Semantic cache: {len(files) - len(uncached)} hit, {len(uncached)} need Pi subagent extraction")
PY
```

## Step 2 — dispatch Pi semantic subagents for uncached files

Split `graphify-out/.graphify_uncached.txt` into chunks:

- text docs/papers: 20–25 files per chunk
- images: one per chunk, only when included
- launch chunks with `run_in_background: true`; Pi queues beyond its concurrency limit

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

## Step 3 — merge chunks into Graphify semantic cache and local fragment

Use Graphify's cache API; do not hand-edit graph output JSON:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python - <<'PY'
import glob
import json
from pathlib import Path
from graphify.cache import save_semantic_cache
root = Path('.').resolve()
out = Path('graphify-out')
cached = json.loads((out / '.graphify_cached.json').read_text()) if (out / '.graphify_cached.json').exists() else {'nodes': [], 'edges': [], 'hyperedges': []}
new = {'nodes': [], 'edges': [], 'hyperedges': [], 'input_tokens': 0, 'output_tokens': 0}
for name in sorted(glob.glob('graphify-out/.graphify_chunk_*.json')):
    chunk = json.loads(Path(name).read_text())
    new['nodes'].extend(chunk.get('nodes', []))
    new['edges'].extend(chunk.get('edges', []))
    new['hyperedges'].extend(chunk.get('hyperedges', []))
    new['input_tokens'] += int(chunk.get('input_tokens', 0) or 0)
    new['output_tokens'] += int(chunk.get('output_tokens', 0) or 0)
(out / '.graphify_semantic_new.json').write_text(json.dumps(new, ensure_ascii=False, indent=2), encoding='utf-8')
uncached = [line for line in (out / '.graphify_uncached.txt').read_text(encoding='utf-8').splitlines() if line]
saved = save_semantic_cache(
    new['nodes'],
    new['edges'],
    new['hyperedges'],
    root=root,
    allowed_source_files=uncached,
)
semantic = {
    'nodes': cached.get('nodes', []) + new['nodes'],
    'edges': cached.get('edges', []) + new['edges'],
    'hyperedges': cached.get('hyperedges', []) + new['hyperedges'],
    'input_tokens': new['input_tokens'],
    'output_tokens': new['output_tokens'],
}
(out / '.graphify_semantic.json').write_text(json.dumps(semantic, ensure_ascii=False, indent=2), encoding='utf-8')
print(f"Semantic cache saved for {saved} files; local semantic fragment has {len(semantic['nodes'])} nodes")
PY
```

Re-run Step 1's cache check. If any selected semantic files are still uncached, stop and fix the failed chunks. Do not run `graphify extract` to fill misses.

## Step 4 — local graph rebuild/merge from cached semantic

Recreate the AST baseline first, even when `graphify-out/graph.json` already exists:

```bash
bash /home/user/.pi/agent/scripts/build-graphify-ast.sh .
```

Full semantic merge must start from an AST-only graph. Do not merge cached semantic data into a previously semantic graph, because stale semantic nodes from changed docs can linger when their replacement chunks use different IDs.

Then merge the local semantic fragment into the graph with Graphify modules:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python - <<'PY'
import json
import os
from pathlib import Path
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.build import build_merge
from graphify.cluster import cluster, score_all
from graphify.detect import save_manifest
from graphify.export import to_html, to_json
from graphify.report import generate
root = Path('.').resolve()
out = Path('graphify-out')
sem = json.loads((out / '.graphify_semantic.json').read_text()) if (out / '.graphify_semantic.json').exists() else {'nodes': [], 'edges': [], 'hyperedges': []}
detect_result = json.loads(Path('.graphify_detect.json').read_text())
# Merge cached/new semantic data into the existing AST graph. Do not pass
# semantic source files as prune_sources here: build_merge prunes after adding,
# so doing that deletes the semantic nodes that were just merged.
G = build_merge([sem], graph_path=out / 'graph.json', prune_sources=None, dedup=True, root=root)
communities = cluster(G)
cohesion = score_all(G, communities)
# A rebuild may change community IDs, so its initial report must never reuse a
# labels file from an earlier clustering. Optional labels are validated and
# applied only through local-graphify-labels.sh after this baseline is complete.
labels = {cid: f'Community {cid}' for cid in communities}
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
questions = suggest_questions(G, communities, labels)
tokens = {'input': sem.get('input_tokens', 0), 'output': sem.get('output_tokens', 0)}
(out / 'GRAPH_REPORT.md').write_text(generate(G, communities, cohesion, labels, gods, surprises, detect_result, tokens, str(root), suggested_questions=questions), encoding='utf-8')
to_json(G, communities, out / 'graph.json', force=True)
try:
    viz_node_limit = int(os.environ.get('GRAPHIFY_VIZ_NODE_LIMIT', '100000'))
    if viz_node_limit < 1:
        raise ValueError
except ValueError:
    raise SystemExit('GRAPHIFY_VIZ_NODE_LIMIT must be a positive integer')
to_html(G, communities, out / 'graph.html', community_labels=None, node_limit=viz_node_limit)
callflow = out / 'callflow.html'
if callflow.exists():
    callflow.unlink()
print('Official graph.html generated; callflow export follows the optional-label decision')
save_manifest(detect_result.get('files', {}), manifest_path=str(out / 'manifest.json'), kind='both', root=root)
print(f"Graph refreshed locally: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {len(communities)} communities")
PY
```

If the user requests community labels, use **Optional local main-session community labels** (see `references/labels.md`). Otherwise retain Graphify's official report/html, export `callflow.html`, and publish without `.graphify_labels.json`.
