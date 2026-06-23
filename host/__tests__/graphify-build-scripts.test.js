// Verifies Codeflare's Pi Graphify build wrappers preserve Graphify's portable
// manifest contract introduced in graphifyy 0.8.45: save_manifest(..., root=ROOT).
// The scripts are executed with lightweight fake graphify modules, so the test
// observes behavior without running a real AST build.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

function writeFakeGraphify(root) {
  const fakeRoot = join(root, 'fake-python');
  const graphify = join(fakeRoot, 'graphify');
  mkdirSync(graphify, { recursive: true });
  writeFileSync(join(graphify, '__init__.py'), '');
  writeFileSync(join(graphify, 'analyze.py'), `
def god_nodes(_graph):
    return []
def surprising_connections(_graph, _communities):
    return []
def suggest_questions(_graph, _communities, _labels):
    return []
`);
  writeFileSync(join(graphify, 'build.py'), `
class NodeView:
    def __init__(self, graph):
        self.graph = graph
    def __call__(self, data=False):
        return list(self.graph._nodes.items()) if data else list(self.graph._nodes.keys())
    def __iter__(self):
        return iter(self.graph._nodes.keys())
    def __contains__(self, key):
        return key in self.graph._nodes
    def __getitem__(self, key):
        return self.graph._nodes[key]

class FakeGraph:
    def __init__(self):
        self._nodes = {
            'src_module': {'source_file': 'src.py', 'label': 'Source Module'},
            'src_handler': {'source_file': 'src.py', 'label': 'handler'},
            'dep_module': {'source_file': 'dep.py', 'label': 'Dependency Module'},
        }
        self._edges = [
            ('src_handler', 'dep_module', {'relation': 'imports', 'source_file': 'src.py'}),
        ]
        self.graph = {}
        self.nodes = NodeView(self)
    def edges(self, data=False):
        return list(self._edges) if data else [(u, v) for u, v, _ in self._edges]
    def number_of_nodes(self):
        return len(self._nodes)
    def number_of_edges(self):
        return len(self._edges)

def build(_extractions, dedup=True, root=None):
    return FakeGraph()

def build_merge(_chunks, graph_path=None, prune_sources=None, dedup=True, root=None):
    return FakeGraph()
`);
  writeFileSync(join(graphify, 'cluster.py'), `
def cluster(graph):
    return {0: list(graph.nodes())}
def score_all(_graph, communities):
    return {cid: 1.0 for cid in communities}
`);
  writeFileSync(join(graphify, 'detect.py'), `
import json
import os
from pathlib import Path

def detect(root, **_kwargs):
    root = Path(root).resolve()
    files = {'code': [str(root / 'src.py'), str(root / 'dep.py')], 'document': [], 'paper': [], 'image': [], 'video': []}
    return {'files': files, 'total_files': 2, 'total_words': 2, 'scan_root': str(root)}

def save_manifest(files, manifest_path='graphify-out/manifest.json', *, kind='both', root=None):
    record_path = Path(os.environ['GRAPHIFY_SAVE_MANIFEST_RECORD'])
    calls = json.loads(record_path.read_text()) if record_path.exists() else []
    calls.append({
        'files': files,
        'manifest_path': str(manifest_path),
        'kind': kind,
        'root': None if root is None else str(Path(root).resolve()),
    })
    record_path.write_text(json.dumps(calls), encoding='utf-8')
    Path(manifest_path).parent.mkdir(parents=True, exist_ok=True)
    Path(manifest_path).write_text('{}', encoding='utf-8')
`);
  writeFileSync(join(graphify, 'export.py'), `
import json
from pathlib import Path

def to_json(graph, _communities, path, force=False):
    Path(path).write_text(json.dumps({'nodes': list(graph.nodes()), 'links': []}), encoding='utf-8')
    return True
`);
  writeFileSync(join(graphify, 'extract.py'), `
def extract(_files, **_kwargs):
    return {'nodes': [{'id': 'src_module', 'label': 'Source Module', 'source_file': 'src.py'}], 'edges': [], 'input_tokens': 0, 'output_tokens': 0}
`);
  writeFileSync(join(graphify, 'report.py'), `
def generate(_graph, _communities, _cohesion, _labels, _gods, _surprises, _detection, _tokens, root, suggested_questions=None):
    return '# Graph Report - ' + str(root)
`);
  writeFileSync(join(fakeRoot, 'networkx.py'), `
class NodeView:
    def __init__(self, graph):
        self.graph = graph
    def __call__(self, data=False):
        return list(self.graph._nodes.items()) if data else list(self.graph._nodes.keys())
    def __iter__(self):
        return iter(self.graph._nodes.keys())
    def __contains__(self, key):
        return key in self.graph._nodes
    def __getitem__(self, key):
        return self.graph._nodes[key]

class Graph:
    def __init__(self):
        self._nodes = {}
        self._edges = {}
        self.nodes = NodeView(self)
        self.graph = {}
    def add_node(self, node, **attrs):
        self._nodes[node] = attrs
    def add_edge(self, source, target, **attrs):
        self._edges[(source, target)] = attrs
    def has_edge(self, source, target):
        return (source, target) in self._edges or (target, source) in self._edges
    def __getitem__(self, source):
        return {target: attrs for (src, target), attrs in self._edges.items() if src == source}
    def __contains__(self, node):
        return node in self._nodes
    def edges(self, data=False):
        return [(u, v, attrs) for (u, v), attrs in self._edges.items()] if data else list(self._edges.keys())
    def degree(self):
        counts = {node: 0 for node in self._nodes}
        for source, target in self._edges:
            counts[source] = counts.get(source, 0) + 1
            counts[target] = counts.get(target, 0) + 1
        return list(counts.items())
    def remove_nodes_from(self, nodes):
        for node in list(nodes):
            self._nodes.pop(node, None)
        self._edges = {edge: attrs for edge, attrs in self._edges.items() if edge[0] in self._nodes and edge[1] in self._nodes}
    def number_of_nodes(self):
        return len(self._nodes)
    def number_of_edges(self):
        return len(self._edges)
`);
  return fakeRoot;
}

function runBuildScript(scriptName) {
  const cwd = mkdtempSync(join(tmpdir(), 'graphify-script-'));
  writeFileSync(join(cwd, 'src.py'), 'from dep import value\n');
  writeFileSync(join(cwd, 'dep.py'), 'value = 1\n');
  const fakeRoot = writeFakeGraphify(cwd);
  const recordPath = join(cwd, 'manifest-calls.json');
  const result = spawnSync('bash', [resolve(repoRoot, 'preseed/agents/pi/scripts', scriptName), cwd], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      GRAPHIFY_PYTHON: 'python3',
      PYTHONPATH: fakeRoot,
      GRAPHIFY_SAVE_MANIFEST_RECORD: recordPath,
      GRAPHIFY_BUILD_TIMEOUT: '30',
      GRAPHIFY_SAFE_RLIMIT_KB: '800000',
    },
  });
  assert.equal(result.status, 0, `${scriptName} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return { cwd, calls: JSON.parse(readFileSync(recordPath, 'utf-8')) };
}

function extractClaudeGraphifyManifestScript() {
  const skillPath = resolve(repoRoot, 'preseed/agents/claude/skills/graphify/references/build.md');
  const skill = readFileSync(skillPath, 'utf-8');
  const start = skill.indexOf('## Step 7 - Save manifest, update cost tracker, clean up, and report');
  assert.notEqual(start, -1, 'Claude graphify manifest step is missing');
  const fenceStart = skill.indexOf('```bash', start);
  assert.notEqual(fenceStart, -1, 'Claude graphify manifest bash block is missing');
  const bodyStart = skill.indexOf('\n', fenceStart) + 1;
  const fenceEnd = skill.indexOf('\n```', bodyStart);
  assert.notEqual(fenceEnd, -1, 'Claude graphify manifest bash block terminator is missing');
  return skill.slice(bodyStart, fenceEnd).replace('/root/.local/share/uv/tools/graphifyy/bin/python', 'python3');
}

function runClaudeGraphifyManifestStep() {
  const cwd = mkdtempSync(join(tmpdir(), 'graphify-claude-skill-'));
  const fakeRoot = writeFakeGraphify(cwd);
  const recordPath = join(cwd, 'manifest-calls.json');
  writeFileSync(join(cwd, '.graphify_detect.json'), JSON.stringify({
    files: { code: [join(cwd, 'src.py')], document: [], paper: [], image: [], video: [] },
    total_files: 1,
  }));
  writeFileSync(join(cwd, '.graphify_extract.json'), JSON.stringify({ input_tokens: 3, output_tokens: 5 }));
  writeFileSync(join(cwd, 'src.py'), 'print("hi")\n');
  const result = spawnSync('bash', ['-lc', extractClaudeGraphifyManifestScript()], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PYTHONPATH: fakeRoot,
      GRAPHIFY_SAVE_MANIFEST_RECORD: recordPath,
    },
  });
  assert.equal(result.status, 0, `Claude graphify skill manifest step failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return { cwd, calls: JSON.parse(readFileSync(recordPath, 'utf-8')) };
}

describe('Graphify build preseed', () => {
  it('Claude skill manifest step writes a portable manifest rooted at the scanned repo', () => {
    const { cwd, calls } = runClaudeGraphifyManifestStep();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'both');
    assert.equal(calls[0].root, cwd);
    assert.equal(calls[0].manifest_path, 'graphify-out/manifest.json');
  });

  it('Pi AST-only build writes a portable manifest rooted at the scanned repo', () => {
    const { cwd, calls } = runBuildScript('build-graphify-ast.sh');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'ast');
    assert.equal(calls[0].root, cwd);
    assert.equal(calls[0].manifest_path, join(cwd, 'graphify-out', 'manifest.json'));
  });

  it('Pi architecture build writes a portable manifest rooted at the scanned repo', () => {
    const { cwd, calls } = runBuildScript('build-graphify-architecture.sh');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'ast');
    assert.equal(calls[0].root, cwd);
    assert.equal(calls[0].manifest_path, join(cwd, 'graphify-out', 'manifest.json'));
  });
});
