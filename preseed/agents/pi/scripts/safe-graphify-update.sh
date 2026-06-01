#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"
cd "$TARGET" 2>/dev/null || { echo "safe-graphify-update: target directory '$TARGET' does not exist" >&2; exit 1; }

# Existing-graph refresh only. First-time graph creation must use
# build-graphify-ast.sh so it follows detect -> AST extract -> build ->
# cluster -> report -> HTML instead of incremental update state.
if [ ! -s graphify-out/graph.json ]; then
  echo "safe-graphify-update: graphify-out/graph.json is missing; first-time graphs must use build-graphify-ast.sh" >&2
  exit 2
fi

export GRAPHIFY_MAX_WORKERS="${GRAPHIFY_MAX_WORKERS:-1}"
export GRAPHIFY_NO_SEMANTIC="${GRAPHIFY_NO_SEMANTIC:-1}"
# graph.html must always be generated; keep the viz node limit high even if the
# inherited process env was scrubbed by a sandboxed exec.
export GRAPHIFY_VIZ_NODE_LIMIT="${GRAPHIFY_VIZ_NODE_LIMIT:-100000}"

CAP_KB="${GRAPHIFY_SAFE_RLIMIT_KB:-1500000}"
ulimit -v "$CAP_KB" || { echo "safe-graphify-update: cannot apply RLIMIT_AS cap ${CAP_KB}KB; aborting" >&2; exit 1; }

command -v graphify >/dev/null 2>&1 || { echo "safe-graphify-update: graphify CLI not found on PATH" >&2; exit 127; }

backup_dir="$(mktemp -d)"
cleanup() { rm -rf "$backup_dir"; }
trap cleanup EXIT

cp -p graphify-out/graph.json "$backup_dir/graph.json"
[ -f graphify-out/GRAPH_REPORT.md ] && cp -p graphify-out/GRAPH_REPORT.md "$backup_dir/GRAPH_REPORT.md"
[ -f graphify-out/graph.html ] && cp -p graphify-out/graph.html "$backup_dir/graph.html"

restore_backup() {
  cp -p "$backup_dir/graph.json" graphify-out/graph.json
  [ -f "$backup_dir/GRAPH_REPORT.md" ] && cp -p "$backup_dir/GRAPH_REPORT.md" graphify-out/GRAPH_REPORT.md
  [ -f "$backup_dir/graph.html" ] && cp -p "$backup_dir/graph.html" graphify-out/graph.html
}

if ! timeout "${GRAPHIFY_UPDATE_TIMEOUT:-120}" graphify update .; then
  restore_backup
  echo "safe-graphify-update: graphify update failed; restored previous graph" >&2
  exit 1
fi

if ! timeout "${GRAPHIFY_CLUSTER_TIMEOUT:-120}" graphify cluster-only .; then
  restore_backup
  echo "safe-graphify-update: graphify cluster-only failed; restored previous graph" >&2
  exit 1
fi

if ! python3 - <<'PY'
import json
from collections import Counter, defaultdict, deque
from pathlib import Path

graph_path = Path('graphify-out/graph.json')
if not graph_path.is_file() or graph_path.stat().st_size == 0:
    raise SystemExit('safe-graphify-update: graph.json missing after update')

data = json.loads(graph_path.read_text())
nodes = data.get('nodes', [])
links = data.get('links', data.get('edges', []))
node_comm = {node.get('id'): node.get('community') for node in nodes if node.get('id')}
ids = set(node_comm)
adj = defaultdict(set)
cross = 0
internal = 0
for edge in links:
    source = edge.get('source')
    target = edge.get('target')
    if source not in ids or target not in ids:
        continue
    adj[source].add(target)
    adj[target].add(source)
    if node_comm[source] == node_comm[target]:
        internal += 1
    else:
        cross += 1
seen = set()
components = []
for node_id in ids:
    if node_id in seen:
        continue
    queue = deque([node_id])
    seen.add(node_id)
    size = 0
    while queue:
        current = queue.popleft()
        size += 1
        for neighbor in adj[current]:
            if neighbor not in seen:
                seen.add(neighbor)
                queue.append(neighbor)
    components.append(size)
communities = len(Counter(node_comm.values()))
largest = max(components, default=0)
print(
    'safe-graphify-update: graph health '
    f'nodes={len(nodes)} edges={len(links)} communities={communities} '
    f'cross_edges={cross} components={len(components)} largest_component={largest}'
)
if len(nodes) >= 100 and communities >= 5 and cross < max(5, communities // 10):
    raise SystemExit('safe-graphify-update: graph health check detected a source-file-sharded graph')
PY
then
  restore_backup
  echo "safe-graphify-update: restored previous graph after failed health check" >&2
  exit 1
fi

test -s graphify-out/graph.html || { restore_backup; echo "safe-graphify-update: graph.html missing after update; restored previous graph" >&2; exit 1; }
test -s graphify-out/GRAPH_REPORT.md || { restore_backup; echo "safe-graphify-update: GRAPH_REPORT.md missing after update; restored previous graph" >&2; exit 1; }
