# Steps 3-7 - Build, cluster, label, visualize, report

Load this after extraction (Step 2 / `references/extraction-spec.md`) produces `.graphify_extract.json`. These steps build the graph, cluster it, label communities, generate the Obsidian vault + HTML, benchmark, save the manifest, and report.

## Step 3 - Build graph, cluster, analyze, generate outputs

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

## Step 4 - Label communities

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

## Step 5 - Generate Obsidian vault + HTML

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

## Step 6 - Token reduction benchmark (only if total_words > 5000)

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

## Step 7 - Save manifest, update cost tracker, clean up, and report

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
