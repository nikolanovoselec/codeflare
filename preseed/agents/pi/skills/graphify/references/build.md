# Full build/update without provider LLMs

Load this for the Full repo semantic flow: Pi `Agent` subagents produce semantic chunks for docs/papers/images, then Graphify consumes the local semantic fragments and rebuilds locally. Use this only after the user has chosen Full repo semantic (see the core skill's "Mandatory graph refresh choice") and the post-detection cost/count confirmation has passed.

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
print(f"Semantic cache: {len(files) - len(uncached)} hit, {len(uncached)} need Pi Agent extraction")
PY
```

## Step 2 — dispatch Pi Agent semantic subagents for uncached files

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
saved = save_semantic_cache(new['nodes'], new['edges'], new['hyperedges'], root=root)
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
from pathlib import Path
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.build import build_merge
from graphify.cluster import cluster, score_all
from graphify.detect import save_manifest
from graphify.export import to_json
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
labels_path = out / '.graphify_labels.json'
if labels_path.exists():
    labels = {int(k): v for k, v in json.loads(labels_path.read_text(encoding='utf-8')).items()}
else:
    labels = {cid: f'Community {cid}' for cid in communities}
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
questions = suggest_questions(G, communities, labels)
tokens = {'input': sem.get('input_tokens', 0), 'output': sem.get('output_tokens', 0)}
(out / 'GRAPH_REPORT.md').write_text(generate(G, communities, cohesion, labels, gods, surprises, detect_result, tokens, str(root), suggested_questions=questions), encoding='utf-8')
to_json(G, communities, out / 'graph.json', force=True)
for deferred in (out / 'graph.html', out / 'callflow.html'):
    if deferred.exists():
        deferred.unlink()
print('HTML outputs deferred until local labels are applied')
save_manifest(detect_result.get('files', {}), manifest_path=str(out / 'manifest.json'), kind='both')
print(f"Graph refreshed locally: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {len(communities)} communities")
PY
```

Then label communities using the **Local main-session community labels** section (see `references/labels.md`).
