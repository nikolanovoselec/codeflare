#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"
cd "$TARGET" 2>/dev/null || { echo "build-graphify-ast: target directory '$TARGET' does not exist" >&2; exit 1; }

# First-time AST-only graph build for Pi. Mirrors Claude's initial Graphify
# pipeline: detect -> AST extract -> build -> cluster -> report -> HTML.
# Do not use graphify update for first builds; update is incremental-only and
# can produce source-file-sharded graphs on some Dart/Flutter repos.
export GRAPHIFY_MAX_WORKERS="${GRAPHIFY_MAX_WORKERS:-1}"
export GRAPHIFY_NO_SEMANTIC="${GRAPHIFY_NO_SEMANTIC:-1}"
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

timeout "${GRAPHIFY_BUILD_TIMEOUT:-180}" "$GRAPHIFY_PYTHON" - <<'PY'
import json
import os
import re
from collections import Counter, OrderedDict, defaultdict, deque
from pathlib import Path

from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.detect import detect, save_manifest
from graphify.export import to_html, to_json
from graphify.extract import collect_files, extract
from graphify.report import generate
from networkx.readwrite import json_graph

ROOT = Path('.')
ROOT_ABS = ROOT.resolve()
OUT = Path('graphify-out')
OUT.mkdir(exist_ok=True)

SKIP_PARTS = {'node_modules', 'build', 'dist', '.dart_tool', '.git', 'graphify-out'}
CODE_SUFFIXES = {'.dart', '.kt', '.kts', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.swift', '.json', '.yaml', '.yml', '.gradle'}

def repo_relative(path: Path) -> Path | None:
    try:
        rel = path.resolve().relative_to(ROOT_ABS)
    except ValueError:
        return None
    if rel.parts and rel.parts[0].startswith('.'):
        return None
    if any(part in SKIP_PARTS for part in rel.parts):
        return None
    return rel

def detect_code_files() -> tuple[dict, list[Path]]:
    detection = detect(ROOT)
    code_files: list[Path] = []
    for entry in detection.get('files', {}).get('code', []):
        path = Path(entry)
        candidates = collect_files(path) if path.is_dir() else [path]
        for candidate in candidates:
            if not candidate.exists() or candidate.suffix.lower() not in CODE_SUFFIXES:
                continue
            rel = repo_relative(candidate)
            if rel is not None:
                code_files.append(rel)
    code_files = sorted(set(code_files), key=lambda p: str(p))
    return detection, code_files

def write_base_graph(code_files: list[Path]) -> None:
    extraction = extract(code_files)
    graph = build_from_json(extraction)
    if graph.number_of_nodes() == 0:
        raise SystemExit('build-graphify-ast: AST extraction produced an empty graph')
    communities = cluster(graph)
    graph_json = OUT / 'graph.json'
    graph_json.unlink(missing_ok=True)
    to_json(graph, communities, graph_json)
    print(f'build-graphify-ast: AST extracted {len(code_files)} files -> {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges')

def slug(label: str) -> str:
    return re.sub(r'[^a-zA-Z0-9]+', '_', label.strip().lower()).strip('_') or 'import'

# Source extensions that count as a real file extension on an import label, so a
# dotted namespace (com.foo.Bar) is split into a path while a real filename
# (foo.dart) is left intact.
IMPORT_EXTS = {'dart', 'kt', 'kts', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'go',
               'rs', 'java', 'swift', 'h', 'hpp', 'hh', 'hxx', 'cc', 'cpp',
               'cxx', 'c', 'cs', 'rb', 'php', 'scala', 'm', 'mm'}

def build_suffix_index(file_by_path: dict[str, str]) -> dict[str, set[str]]:
    # Index every path-tail of every local file -> the node_ids sharing it, both
    # with and without the trailing extension, so an import that omits the
    # extension (Java/C#/Dart namespaces) still matches a real file.
    idx: dict[str, set[str]] = defaultdict(set)
    for path, node_id in file_by_path.items():
        variants = {path}
        if '.' in path.rsplit('/', 1)[-1]:
            variants.add(path.rsplit('.', 1)[0])
        for variant in variants:
            parts = variant.split('/')
            for i in range(len(parts)):
                idx['/'.join(parts[i:])].add(node_id)
    return idx

def label_to_candidate(label: str) -> str | None:
    # Normalize any import label to a path-like candidate, language-agnostically:
    # strip a `scheme:` prefix (package:/dart:/node:/file:), strip include
    # punctuation, and convert dotted namespaces (Java/Kotlin/C#) to slash paths.
    s = (label or '').strip().strip('"\'<> ')
    if not s:
        return None
    m = re.match(r'^[A-Za-z][A-Za-z0-9+.\-]*:(.*)$', s)
    if m:
        s = m.group(1).lstrip('/')
    if not s:
        return None
    if '/' not in s and '.' in s and s.rsplit('.', 1)[1].lower() not in IMPORT_EXTS:
        s = s.replace('.', '/')
    return s or None

def resolve_by_suffix(candidate: str, suffix_index: dict[str, set[str]]) -> str | None:
    # Longest unique path-tail wins, but the tail must have >=2 path segments so
    # a bare basename (config.h, App) never mis-merges onto an unrelated file
    # that happens to share the name; basename-only imports stay external.
    parts = candidate.split('/')
    for i in range(len(parts) - 1):
        matches = suffix_index.get('/'.join(parts[i:]))
        if matches and len(matches) == 1:
            return next(iter(matches))
    return None

def normalize_import_targets() -> None:
    graph_json = OUT / 'graph.json'
    data = json.loads(graph_json.read_text())
    nodes = list(data.get('nodes', []))
    links = list(data.get('links', data.get('edges', [])))
    node_by_id = {node['id']: dict(node) for node in nodes if node.get('id')}

    file_by_path: dict[str, str] = {}
    for node_id, node in node_by_id.items():
        source_file = node.get('source_file')
        if source_file and node.get('label') == Path(source_file).name:
            file_by_path[os.path.normpath(source_file)] = node_id

    suffix_index = build_suffix_index(file_by_path)

    canonical_external: dict[str, dict] = {}
    replace: dict[str, str] = {}
    for node_id, node in list(node_by_id.items()):
        label = node.get('label') or ''
        source_file = node.get('source_file')
        resolved_id = None

        # 1. Relative imports resolve exactly against the importing file's dir.
        if source_file and (label.startswith('./') or label.startswith('../')):
            rel = os.path.normpath(str(Path(source_file).parent / label.strip('"\'')))
            resolved_id = file_by_path.get(rel)

        # 2. Everything else: match the label's longest unique path-tail against
        #    the local-file index. Internal imports (Dart package:, Java/Kotlin/
        #    C# namespaces, C/C++ includes, JS/TS module paths) resolve to a
        #    file; external/stdlib imports match nothing and stay external.
        if resolved_id is None:
            candidate = label_to_candidate(label)
            if candidate:
                resolved_id = resolve_by_suffix(candidate, suffix_index)

        if resolved_id and resolved_id != node_id:
            replace[node_id] = resolved_id
            continue

        # Scheme-prefixed external/stdlib imports collapse to one node per label.
        if re.match(r'^[A-Za-z][A-Za-z0-9+.\-]*:', label):
            canonical_id = 'import_' + slug(label)
            if canonical_id not in canonical_external:
                canonical_external[canonical_id] = {
                    **node,
                    'id': canonical_id,
                    'source_file': None,
                    'source_location': None,
                }
            replace[node_id] = canonical_id

    kept: OrderedDict[str, dict] = OrderedDict()
    for node_id, node in node_by_id.items():
        if node_id in replace and replace[node_id] != node_id:
            continue
        kept[node_id] = node
    for node in canonical_external.values():
        kept[node['id']] = node

    seen_edges = set()
    repaired_links = []
    for edge in links:
        source = replace.get(edge.get('source'), edge.get('source'))
        target = replace.get(edge.get('target'), edge.get('target'))
        if not source or not target or source == target:
            continue
        if source not in kept or target not in kept:
            continue
        repaired = {**edge, 'source': source, 'target': target}
        key = (source, target, repaired.get('relation'), repaired.get('source_file'), repaired.get('source_location'))
        if key in seen_edges:
            continue
        seen_edges.add(key)
        repaired_links.append(repaired)

    repaired_data = {**data, 'nodes': list(kept.values()), 'links': repaired_links}
    graph = json_graph.node_link_graph(repaired_data, edges='links')
    communities = cluster(graph)
    graph_json.unlink(missing_ok=True)
    to_json(graph, communities, graph_json)
    print(
        'build-graphify-ast: normalized imports '
        f'nodes {len(nodes)}->{len(kept)} edges {len(links)}->{len(repaired_links)} '
        f'external_imports={len(canonical_external)} rewrites={len(replace)}'
    )

def health_metrics() -> tuple[int, int, int, int, int, int]:
    data = json.loads((OUT / 'graph.json').read_text())
    nodes = data.get('nodes', [])
    links = data.get('links', data.get('edges', []))
    node_comm = {node.get('id'): node.get('community') for node in nodes}
    ids = set(node_comm)
    cross = 0
    adj: dict[str, set[str]] = defaultdict(set)
    for edge in links:
        source = edge.get('source')
        target = edge.get('target')
        if source not in ids or target not in ids:
            continue
        adj[source].add(target)
        adj[target].add(source)
        if node_comm.get(source) != node_comm.get(target):
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
    return len(nodes), len(links), len(Counter(node_comm.values())), cross, len(components), max(components, default=0)

def write_report_and_html(detection: dict) -> None:
    data = json.loads((OUT / 'graph.json').read_text())
    graph = json_graph.node_link_graph(data, edges='links')
    communities = {node: graph.nodes[node].get('community') for node in graph.nodes}
    # graphify report/export expect community-id -> node-list mapping.
    grouped: dict[int, list[str]] = defaultdict(list)
    for node_id, community in communities.items():
        if community is not None:
            grouped[int(community)].append(node_id)
    community_map = dict(grouped)
    cohesion = score_all(graph, community_map)
    labels = {community: f'Community {community}' for community in community_map}
    tokens = {'input': 0, 'output': 0}
    gods = god_nodes(graph)
    surprises = surprising_connections(graph, community_map)
    questions = suggest_questions(graph, community_map, labels)
    report = generate(graph, community_map, cohesion, labels, gods, surprises, detection, tokens, '.', suggested_questions=questions)
    (OUT / 'GRAPH_REPORT.md').write_text(report)
    to_html(graph, community_map, OUT / 'graph.html', community_labels=labels)

detection, code_files = detect_code_files()
if not code_files:
    raise SystemExit('build-graphify-ast: no code files detected')
write_base_graph(code_files)
normalize_import_targets()
write_report_and_html(detection)
save_manifest(detection.get('files', {}))
nodes, edges, communities, cross, components, largest = health_metrics()
print(f'build-graphify-ast: graph health nodes={nodes} edges={edges} communities={communities} cross_edges={cross} components={components} largest_component={largest}')
if nodes >= 100 and communities >= 5 and cross < max(5, communities // 10):
    raise SystemExit('build-graphify-ast: graph health check failed; graph is still source-file-sharded')
PY
