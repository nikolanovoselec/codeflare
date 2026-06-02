#!/usr/bin/env bash
# local-graphify-labels.sh - prepare/apply community labels produced by the Pi main session.
#
# This script deliberately cannot call Graphify provider labeling. It never uses
# `graphify label`, `--backend`, Gemini, OpenAI, or any external LLM. The Pi main
# session reads the prepared worklist and writes graphify-out/.graphify_labels.json;
# this script validates that file, regenerates GRAPH_REPORT.md/graph.html from
# the graph's existing community assignments, and exports callflow.html.
set -euo pipefail

MODE="${1:-}"
TARGET="${2:-.}"
if [ -z "$MODE" ] || [ "$MODE" = "-h" ] || [ "$MODE" = "--help" ]; then
  cat >&2 <<'USAGE'
Usage:
  local-graphify-labels.sh prepare [repo]
  local-graphify-labels.sh apply [repo]

prepare: write graphify-out/.graphify_community_label_worklist.json and
         graphify-out/.graphify_community_label_batches/*.md for the Pi main
         session to label.
apply:   validate graphify-out/.graphify_labels.json, regenerate
         GRAPH_REPORT.md/graph.html locally from existing graph communities,
         and export graphify-out/callflow.html.
USAGE
  exit 2
fi

cd "$TARGET" 2>/dev/null || { echo "local-graphify-labels: target '$TARGET' does not exist" >&2; exit 1; }

PY="${GRAPHIFY_PYTHON:-}"
if [ -z "$PY" ]; then
  for candidate in \
    /root/.local/share/uv/tools/graphifyy/bin/python \
    /home/user/.local/share/uv/tools/graphifyy/bin/python \
    /usr/local/share/uv/tools/graphifyy/bin/python; do
    if [ -x "$candidate" ]; then
      PY="$candidate"
      break
    fi
  done
fi
[ -n "$PY" ] || { echo "local-graphify-labels: graphify Python interpreter not found" >&2; exit 127; }

validate_labels() {
  "$PY" - <<'PY'
import json
import re
from collections import Counter
from pathlib import Path

out = Path('graphify-out')
graph_path = out / 'graph.json'
labels_path = out / '.graphify_labels.json'
if not graph_path.exists():
    raise SystemExit('local-graphify-labels: graphify-out/graph.json is missing')
if not labels_path.exists():
    raise SystemExit('local-graphify-labels: .graphify_labels.json is missing; run prepare and have the Pi main session write labels first')

data = json.loads(graph_path.read_text(encoding='utf-8'))
communities = sorted({str(n.get('community')) for n in data.get('nodes', []) if n.get('community') is not None}, key=lambda x: int(x) if x.isdigit() else 10**9)
labels = json.loads(labels_path.read_text(encoding='utf-8'))
if not isinstance(labels, dict):
    raise SystemExit('local-graphify-labels: .graphify_labels.json must be a JSON object')
missing = [cid for cid in communities if cid not in labels]
blank = [cid for cid in communities if not isinstance(labels.get(cid), str) or not labels.get(cid, '').strip()]
placeholder = [cid for cid in communities if re.fullmatch(r'Community\s+\d+', str(labels.get(cid, '')).strip())]
ordered = {cid: labels[cid].strip() for cid in communities if cid in labels and isinstance(labels.get(cid), str)}
label_counts = Counter(v.casefold() for v in ordered.values())
duplicate_exact = [label for label in ordered.values() if label_counts[label.casefold()] > 1]

def base_label(label: str) -> str:
    return re.sub(r'\s+\d+$', '', label).strip().casefold()

base_counts = Counter(base_label(v) for v in ordered.values())
numbered_duplicate = [
    label
    for label in ordered.values()
    if re.search(r'\s+\d+$', label) and base_counts[base_label(label)] > 1
]
duplicate_base = [
    label
    for label in ordered.values()
    if base_counts[base_label(label)] > 1 and base_label(label) != label.casefold()
]
if missing or blank or placeholder or duplicate_exact or numbered_duplicate or duplicate_base:
    problems = []
    if missing:
        problems.append(f"missing={missing[:20]}{'...' if len(missing) > 20 else ''}")
    if blank:
        problems.append(f"blank={blank[:20]}{'...' if len(blank) > 20 else ''}")
    if placeholder:
        problems.append(f"placeholder={placeholder[:20]}{'...' if len(placeholder) > 20 else ''}")
    if duplicate_exact:
        problems.append(f"duplicate_exact={duplicate_exact[:20]}{'...' if len(duplicate_exact) > 20 else ''}")
    if numbered_duplicate:
        problems.append(f"numbered_duplicate={numbered_duplicate[:20]}{'...' if len(numbered_duplicate) > 20 else ''}")
    if duplicate_base:
        problems.append(f"duplicate_base={duplicate_base[:20]}{'...' if len(duplicate_base) > 20 else ''}")
    raise SystemExit(
        'local-graphify-labels: invalid labels: ' + '; '.join(problems) +
        '. Main-session labels must be unique semantic names, not numeric suffixes; add a source/domain qualifier instead.'
    )
labels_path.write_text(json.dumps(ordered, ensure_ascii=False, indent=2), encoding='utf-8')
print(f"local-graphify-labels: validated {len(ordered)} labels")
PY
}

case "$MODE" in
  prepare)
    "$PY" - <<'PY'
import json
from collections import Counter, defaultdict
from pathlib import Path

out = Path('graphify-out')
graph_path = out / 'graph.json'
if not graph_path.exists():
    raise SystemExit('local-graphify-labels: graphify-out/graph.json is missing')

data = json.loads(graph_path.read_text(encoding='utf-8'))
nodes = data.get('nodes', [])
links = data.get('links', data.get('edges', []))
by_comm: dict[str, list[dict]] = defaultdict(list)
for node in nodes:
    cid = node.get('community')
    if cid is not None:
        by_comm[str(cid)].append(node)

edge_counts: Counter[str] = Counter()
for edge in links:
    edge_counts[str(edge.get('source'))] += 1
    edge_counts[str(edge.get('target'))] += 1

items = []
for cid, members in sorted(by_comm.items(), key=lambda item: (-len(item[1]), int(item[0]) if str(item[0]).isdigit() else 10**9)):
    ranked = sorted(
        members,
        key=lambda n: (-edge_counts.get(str(n.get('id')), 0), str(n.get('label') or n.get('id') or '')),
    )
    labels = []
    for node in ranked[:18]:
        label = str(node.get('label') or node.get('id') or '').strip()
        if label and label not in labels:
            labels.append(label)
    sources = []
    for node in ranked:
        src = str(node.get('source_file') or '').strip()
        if src and src not in sources:
            sources.append(src)
        if len(sources) >= 12:
            break
    types = Counter(str(node.get('file_type') or 'unknown') for node in members)
    member_ids = {m.get('id') for m in members}
    rels = Counter(
        str(edge.get('relation') or 'related')
        for edge in links
        if edge.get('source') in member_ids or edge.get('target') in member_ids
    ).most_common(8)
    items.append({
        'community': cid,
        'size': len(members),
        'file_types': dict(types.most_common()),
        'top_nodes': labels,
        'top_sources': sources,
        'top_relations': dict(rels),
    })

worklist = {
    'instructions': [
        'Local Pi main session only: do not call graphify label, --backend, Gemini, OpenAI, or external LLM providers.',
        'Write graphify-out/.graphify_labels.json as a JSON object mapping every community id string to a concise human label.',
        'Labels must be unique 2-6 word semantic names. Do not use placeholders, repeated generic labels, or numeric suffixes like PR Review Workflow 77.',
    ],
    'community_count': len(items),
    'communities': items,
}
out.mkdir(exist_ok=True)
(out / '.graphify_community_label_worklist.json').write_text(json.dumps(worklist, ensure_ascii=False, indent=2), encoding='utf-8')

batch_dir = out / '.graphify_community_label_batches'
if batch_dir.exists():
    for old in batch_dir.glob('*.md'):
        old.unlink()
else:
    batch_dir.mkdir(parents=True)

batch_size = 40
for i in range(0, len(items), batch_size):
    batch = items[i:i + batch_size]
    lines = [
        '# Graphify community labels batch',
        '',
        'Local Pi main session only. Do not call external LLM providers.',
        'For each community, choose a unique concise 2-6 word semantic label. Do not use numeric suffixes; qualify by source/domain instead.'
        '',
    ]
    for item in batch:
        lines.append(f"## {item['community']} ({item['size']} nodes)")
        lines.append(f"Types: {item['file_types']}")
        if item['top_nodes']:
            lines.append('Top nodes: ' + '; '.join(item['top_nodes']))
        if item['top_sources']:
            lines.append('Sources: ' + '; '.join(item['top_sources']))
        lines.append('')
    (batch_dir / f'batch_{i // batch_size + 1:03d}.md').write_text('\n'.join(lines), encoding='utf-8')

print(f"local-graphify-labels: prepared {len(items)} communities")
print(f"worklist: {out / '.graphify_community_label_worklist.json'}")
print(f"batches:  {batch_dir}")
PY
    ;;
  apply)
    validate_labels
    "$PY" - <<'PY'
import json
from collections import defaultdict
from pathlib import Path
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.build import build_from_json
from graphify.cluster import score_all
from graphify.export import to_html
from graphify.report import generate

root = Path('.').resolve()
out = Path('graphify-out')
graph_path = out / 'graph.json'
labels_path = out / '.graphify_labels.json'
raw = json.loads(graph_path.read_text(encoding='utf-8'))
labels = {int(k): v for k, v in json.loads(labels_path.read_text(encoding='utf-8')).items()}
G = build_from_json(raw, directed=bool(raw.get('directed', False)), root=root)
communities_map: dict[int, list[str]] = defaultdict(list)
next_cid = 0
for node in raw.get('nodes', []):
    node_id = node.get('id')
    if node_id is None:
        continue
    cid = node.get('community')
    if cid is None:
        while next_cid in communities_map:
            next_cid += 1
        cid = next_cid
        next_cid += 1
    communities_map[int(cid)].append(node_id)
communities = {cid: sorted(nodes) for cid, nodes in sorted(communities_map.items())}
cohesion = score_all(G, communities)
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
questions = suggest_questions(G, communities, labels)
if Path('.graphify_detect.json').exists():
    detection = json.loads(Path('.graphify_detect.json').read_text(encoding='utf-8'))
else:
    detection = {'warning': 'label apply mode — file stats not available'}
tokens = {'input': raw.get('input_tokens', 0), 'output': raw.get('output_tokens', 0)}
report = generate(
    G,
    communities,
    cohesion,
    labels,
    gods,
    surprises,
    detection,
    tokens,
    str(root),
    suggested_questions=questions,
    built_at_commit=raw.get('built_at_commit'),
)
(out / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
try:
    to_html(G, communities, out / 'graph.html', community_labels=labels or None)
except ValueError as exc:
    html = out / 'graph.html'
    if html.exists():
        html.unlink()
    print(f'local-graphify-labels: skipped graph.html: {exc}')
print(f"local-graphify-labels: applied labels to {len(communities)} communities")
PY
    graphify export callflow-html --graph graphify-out/graph.json --output graphify-out/callflow.html
    validate_labels
    ;;
  *)
    echo "local-graphify-labels: unknown mode '$MODE'" >&2
    exit 2
    ;;
esac
