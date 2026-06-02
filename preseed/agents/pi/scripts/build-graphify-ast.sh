#!/usr/bin/env bash
# build-graphify-ast.sh - first-time AST-only graph build using upstream
# Graphify primitives only.
#
# This exists because upstream `graphify update` is incremental-only and needs an
# existing graph, while upstream `graphify extract` is the headless full-semantic
# path. For interactive Pi, semantic extraction is performed by Pi Agent
# subagents from the main session, so this script only runs Graphify's built-in
# detect/extract/build/cluster/report/export modules for the AST portion.
set -euo pipefail

TARGET="${1:-.}"
cd "$TARGET" 2>/dev/null || { echo "build-graphify-ast: target directory '$TARGET' does not exist" >&2; exit 1; }

export GRAPHIFY_MAX_WORKERS="${GRAPHIFY_MAX_WORKERS:-${GRAPHIFY_SAFE_WORKERS:-1}}"
export GRAPHIFY_VIZ_NODE_LIMIT="${GRAPHIFY_VIZ_NODE_LIMIT:-100000}"

CAP_KB="${GRAPHIFY_SAFE_RLIMIT_KB:-1500000}"
ulimit -v "$CAP_KB" || { echo "build-graphify-ast: cannot apply RLIMIT_AS cap ${CAP_KB}KB; aborting" >&2; exit 1; }

GRAPHIFY_PYTHON="${GRAPHIFY_PYTHON:-}"
if [ -z "$GRAPHIFY_PYTHON" ]; then
  for candidate in \
    /root/.local/share/uv/tools/graphifyy/bin/python \
    /home/user/.local/share/uv/tools/graphifyy/bin/python \
    /usr/local/share/uv/tools/graphifyy/bin/python; do
    if [ -x "$candidate" ]; then
      GRAPHIFY_PYTHON="$candidate"
      break
    fi
  done
fi
[ -n "$GRAPHIFY_PYTHON" ] || { echo "build-graphify-ast: graphify Python interpreter not found" >&2; exit 127; }

# Keep this Python block deliberately boring: all extraction/build behavior comes
# from graphify itself. Do not add Codeflare-specific suffix allowlists, import
# target rewrites, or edge normalization here.
timeout "${GRAPHIFY_BUILD_TIMEOUT:-240}" "$GRAPHIFY_PYTHON" - <<'PY'
import json
import os
from pathlib import Path

from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.build import build
from graphify.cluster import cluster, score_all
from graphify.detect import detect, save_manifest
from graphify.export import to_json
from graphify.extract import extract
from graphify.report import generate

ROOT = Path('.').resolve()
OUT = Path('graphify-out')
OUT.mkdir(exist_ok=True)
(OUT / '.graphify_root').write_text(str(ROOT), encoding='utf-8')

workers_raw = os.environ.get('GRAPHIFY_MAX_WORKERS')
try:
    max_workers = int(workers_raw) if workers_raw else None
except ValueError:
    max_workers = None

detection = detect(ROOT)
code_files = [Path(p) for p in detection.get('files', {}).get('code', [])]
if not code_files:
    raise SystemExit('build-graphify-ast: no code files detected by graphify.detect')

ast_kwargs = {'cache_root': ROOT}
if max_workers is not None and max_workers > 0:
    ast_kwargs['max_workers'] = max_workers

ast = extract(code_files, **ast_kwargs)
G = build([ast], dedup=True, root=ROOT)
if G.number_of_nodes() == 0:
    raise SystemExit('build-graphify-ast: graphify AST extraction produced an empty graph')

communities = cluster(G)
cohesion = score_all(G, communities)
labels = {cid: f'Community {cid}' for cid in communities}
tokens = {'input': ast.get('input_tokens', 0), 'output': ast.get('output_tokens', 0)}
try:
    gods = god_nodes(G)
except Exception:
    gods = []
try:
    surprises = surprising_connections(G, communities)
except Exception:
    surprises = []
questions = suggest_questions(G, communities, labels)
analysis = {
    'communities': {str(k): v for k, v in communities.items()},
    'cohesion': {str(k): v for k, v in cohesion.items()},
    'gods': gods,
    'surprises': surprises,
    'questions': questions,
    'tokens': tokens,
}
(OUT / '.graphify_analysis.json').write_text(json.dumps(analysis, indent=2), encoding='utf-8')

report = generate(
    G,
    communities,
    cohesion,
    labels,
    gods,
    surprises,
    detection,
    tokens,
    str(ROOT),
    suggested_questions=questions,
)
(OUT / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
to_json(G, communities, OUT / 'graph.json', force=True)
html = OUT / 'graph.html'
if html.exists():
    html.unlink()
callflow = OUT / 'callflow.html'
if callflow.exists():
    callflow.unlink()
print('build-graphify-ast: graph.html/callflow.html deferred until local labels are applied')

save_manifest(detection.get('files', {}), manifest_path=str(OUT / 'manifest.json'), kind='ast')
print(
    f'build-graphify-ast: graphify AST built {len(code_files)} code files -> '
    f'{G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {len(communities)} communities'
)
PY
