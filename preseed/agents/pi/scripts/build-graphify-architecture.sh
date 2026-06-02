#!/usr/bin/env bash
# build-graphify-architecture.sh - architecture-focused module graph build.
#
# Local Pi workflow only. Uses upstream Graphify detection/extraction/build, then
# projects the detailed symbol graph to a file/module dependency graph so the
# result is human-browsable. Tests, fixtures, generated files, docs/spec bulk,
# config noise, and build artifacts are excluded. Final graph.html/callflow.html
# are deferred until local community labels are applied.
set -euo pipefail

TARGET="${1:-.}"
cd "$TARGET" 2>/dev/null || { echo "build-graphify-architecture: target directory '$TARGET' does not exist" >&2; exit 1; }

export GRAPHIFY_MAX_WORKERS="${GRAPHIFY_MAX_WORKERS:-${GRAPHIFY_SAFE_WORKERS:-1}}"
export GRAPHIFY_VIZ_NODE_LIMIT="${GRAPHIFY_VIZ_NODE_LIMIT:-100000}"

CAP_KB="${GRAPHIFY_SAFE_RLIMIT_KB:-1500000}"
ulimit -v "$CAP_KB" || { echo "build-graphify-architecture: cannot apply RLIMIT_AS cap ${CAP_KB}KB; aborting" >&2; exit 1; }

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
[ -n "$GRAPHIFY_PYTHON" ] || { echo "build-graphify-architecture: graphify Python interpreter not found" >&2; exit 127; }

timeout "${GRAPHIFY_BUILD_TIMEOUT:-240}" "$GRAPHIFY_PYTHON" - <<'PY'
import json
import os
import shlex
from collections import Counter, defaultdict
from pathlib import Path

import networkx as nx
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
(OUT / '.graphify_scope').write_text('architecture\n', encoding='utf-8')

ARCH_EXCLUDES = [
    # tests, fixtures, mocks, examples intended for tests (root + nested forms)
    '__tests__/**', 'tests/**', 'test/**', 'spec/**', 'specs/**', 'e2e/**',
    'fixtures/**', 'fixture/**', 'mocks/**', 'mock/**', 'snapshots/**',
    '**/__tests__/**', '**/__mocks__/**', '**/tests/**', '**/test/**',
    '**/spec/**', '**/specs/**', '**/e2e/**', '**/fixtures/**',
    '**/fixture/**', '**/mocks/**', '**/mock/**', '**/snapshots/**',
    '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*Test.*', '**/*Tests.*',
    '**/*.snap',

    # generated/build/vendor/cache outputs
    'generated/**', 'gen/**', 'dist/**', 'build/**', 'coverage/**', 'target/**',
    'vendor/**', 'node_modules/**',
    '**/generated/**', '**/gen/**', '**/*.generated.*', '**/*generated*',
    '**/dist/**', '**/build/**', '**/coverage/**', '**/.next/**', '**/.nuxt/**',
    '**/.svelte-kit/**', '**/.turbo/**', '**/.cache/**', '**/target/**',
    '**/vendor/**', '**/node_modules/**', '**/.venv/**', '**/venv/**',
    '**/Pods/**', '**/.build/**',

    # config/package/dotfile noise that creates isolated pseudo-modules
    'package.json', '**/package.json', 'tsconfig*.json', '**/tsconfig*.json',
    '*.config.*', '**/*.config.*', '.*.json', '**/.*.json', 'knip.json', '**/knip.json',
    'wrangler.toml.bak',
    '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lockb',
    '**/go.sum', '**/Cargo.lock', '**/Podfile.lock', '**/Gemfile.lock',

    # prose/spec bulk; architecture graph is runtime-source-first
    'README.md', 'CHANGELOG.md', 'LICENSE*', 'docs/**', 'documentation/**', 'sdd/**',
    '**/README.md', '**/CHANGELOG.md', '**/LICENSE*', '**/docs/**',
    '**/documentation/**', '**/sdd/**', '**/*.md', '**/*.mdx',

    # graphify artifacts
    'graphify-out/**', '.graphify_*',
]
extra_raw = os.environ.get('GRAPHIFY_ARCH_EXTRA_EXCLUDES', '').strip()
if extra_raw:
    ARCH_EXCLUDES.extend(shlex.split(extra_raw))

workers_raw = os.environ.get('GRAPHIFY_MAX_WORKERS')
try:
    max_workers = int(workers_raw) if workers_raw else None
except ValueError:
    max_workers = None

full_detection = detect(ROOT)
architecture_detection = detect(ROOT, extra_excludes=ARCH_EXCLUDES)
code_files = [Path(p) for p in architecture_detection.get('files', {}).get('code', [])]
if not code_files:
    raise SystemExit('build-graphify-architecture: no architecture code files detected after filters')

ast_kwargs = {'cache_root': ROOT}
if max_workers is not None and max_workers > 0:
    ast_kwargs['max_workers'] = max_workers

ast = extract(code_files, **ast_kwargs)
detail_graph = build([ast], dedup=True, root=ROOT)
if detail_graph.number_of_nodes() == 0:
    raise SystemExit('build-graphify-architecture: graphify AST extraction produced an empty graph')

module_graph = nx.Graph()
node_to_file: dict[str, str] = {}
file_symbols: dict[str, Counter[str]] = defaultdict(Counter)

for node_id, data in detail_graph.nodes(data=True):
    source_file = data.get('source_file')
    if not source_file:
        continue
    rel_source = str(source_file)
    file_id = 'file:' + rel_source
    node_to_file[node_id] = file_id
    module_graph.add_node(
        file_id,
        id=file_id,
        label=rel_source,
        file_type='code',
        source_file=rel_source,
        source_location=None,
    )
    label = str(data.get('label') or '').strip()
    if label and label != Path(rel_source).name:
        file_symbols[file_id][label] += 1

for source, target, data in detail_graph.edges(data=True):
    source_file = node_to_file.get(source)
    target_file = node_to_file.get(target)
    if not source_file or not target_file or source_file == target_file:
        continue
    relation = str(data.get('relation') or 'depends_on')
    if module_graph.has_edge(source_file, target_file):
        edge = module_graph[source_file][target_file]
        edge['weight'] = edge.get('weight', 1) + 1
        relations = edge.setdefault('relations', {})
        relations[relation] = relations.get(relation, 0) + 1
    else:
        module_graph.add_edge(
            source_file,
            target_file,
            relation='depends_on',
            confidence='EXTRACTED',
            confidence_score=1.0,
            weight=1,
            source_file=None,
            source_location=None,
            relations={relation: 1},
        )

for file_id, counter in file_symbols.items():
    if file_id in module_graph:
        module_graph.nodes[file_id]['top_symbols'] = ', '.join(label for label, _ in counter.most_common(8))

keep_isolates = os.environ.get('GRAPHIFY_ARCH_KEEP_ISOLATES', '').lower() in {'1', 'true', 'yes'}
omitted_isolates = 0
if not keep_isolates:
    isolates = [node for node, degree in module_graph.degree() if degree == 0]
    omitted_isolates = len(isolates)
    module_graph.remove_nodes_from(isolates)
    # For very small/disconnected repos, don't produce an empty graph just because
    # every file is isolated.
    if module_graph.number_of_nodes() == 0 and isolates:
        for file_id in isolates:
            src = file_id.removeprefix('file:')
            module_graph.add_node(
                file_id,
                id=file_id,
                label=src,
                file_type='code',
                source_file=src,
                source_location=None,
            )
        omitted_isolates = 0

if module_graph.number_of_nodes() == 0:
    raise SystemExit('build-graphify-architecture: module projection produced an empty graph')

communities = cluster(module_graph)
cohesion = score_all(module_graph, communities)
labels = {cid: f'Community {cid}' for cid in communities}
tokens = {'input': ast.get('input_tokens', 0), 'output': ast.get('output_tokens', 0)}
try:
    gods = god_nodes(module_graph)
except Exception:
    gods = []
try:
    surprises = surprising_connections(module_graph, communities)
except Exception:
    surprises = []
questions = suggest_questions(module_graph, communities, labels)
analysis = {
    'scope': 'architecture',
    'granularity': 'module',
    'communities': {str(k): v for k, v in communities.items()},
    'cohesion': {str(k): v for k, v in cohesion.items()},
    'gods': gods,
    'surprises': surprises,
    'questions': questions,
    'tokens': tokens,
    'excluded_patterns': ARCH_EXCLUDES,
    'full_corpus_total_files': full_detection.get('total_files', 0),
    'architecture_code_files': len(code_files),
    'detail_nodes': detail_graph.number_of_nodes(),
    'detail_edges': detail_graph.number_of_edges(),
    'omitted_isolates': omitted_isolates,
}
(OUT / '.graphify_analysis.json').write_text(json.dumps(analysis, indent=2), encoding='utf-8')
(OUT / '.graphify_architecture_excludes.json').write_text(json.dumps(ARCH_EXCLUDES, indent=2), encoding='utf-8')

report_detection = dict(architecture_detection)
report_detection['warning'] = (
    'Architecture graph mode: tests, fixtures, generated files, docs/spec bulk, '
    'config noise, isolated leaves, and build artifacts were excluded before visualization.'
)
report_detection['full_corpus_total_files'] = full_detection.get('total_files', 0)
report_detection['architecture_code_files'] = len(code_files)
report_detection['architecture_modules'] = module_graph.number_of_nodes()
report_detection['architecture_omitted_isolates'] = omitted_isolates
report = generate(
    module_graph,
    communities,
    cohesion,
    labels,
    gods,
    surprises,
    report_detection,
    tokens,
    str(ROOT),
    suggested_questions=questions,
)
(OUT / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
to_json(module_graph, communities, OUT / 'graph.json', force=True)

for deferred in (OUT / 'graph.html', OUT / 'callflow.html'):
    if deferred.exists():
        deferred.unlink()
print('build-graphify-architecture: graph.html/callflow.html deferred until local labels are applied')

save_manifest(architecture_detection.get('files', {}), manifest_path=str(OUT / 'manifest.json'), kind='ast')
print(
    'build-graphify-architecture: module architecture graph built '
    f'{len(code_files)} code files (from {full_detection.get("total_files", 0)} detected full-corpus files) -> '
    f'{module_graph.number_of_nodes()} modules, {module_graph.number_of_edges()} dependencies, '
    f'{len(communities)} communities; omitted {omitted_isolates} isolated file(s)'
)
PY
