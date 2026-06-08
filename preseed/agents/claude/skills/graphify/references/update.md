# Incremental Updates and --cluster-only

Load this for the `--update` and `--cluster-only` flows. Both are non-default subcommands; `--update` re-extracts only new or changed files, `--cluster-only` reruns clustering on the existing graph. For repeat runs, bias toward these over a full LLM rebuild (operational note 4).

## Incremental Updates

Three modes:
1. **AST-only** (default, free): `bash /home/user/.claude/plugins/graphify/scripts/safe-graphify-update.sh .` - re-extracts code structure only.
2. **Full semantic update**: Runs the full extraction pipeline on all uncached non-code files. See Recipe 2 in the core skill's Quick Reference.
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

Then run Steps 3-7 on the merged graph as normal (see `references/build.md`).

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

Then run Steps 4-7 as normal (label communities, generate viz, benchmark, clean up, report) - see `references/build.md`.
