// REQ-MEM-009: vault-extract cumulative merge pipeline.
//
// Behavioral cases execute merge-vault-graph.py against persisted and
// request graphs. Focused AST checks cover static export/composition wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = path.join(__dirname, '..', '..', 'preseed', 'agents', 'claude', 'plugins', 'codeflare-vault', 'scripts');
const SCRIPT = path.join(VAULT_DIR, 'merge-vault-graph.py');
const CAPTURE_A = '2026-01-01T00-00-00Z-a.md';
const CAPTURE_B = '2026-01-02T00-00-00Z-b.md';
const CAPTURE_C = '2026-01-03T00-00-00Z-c.md';

function sourceLocation(filename) {
  return `archive:${filename}`;
}

function archiveMarker(filename) {
  return `<!-- capture-begin:${sourceLocation(filename)} -->`;
}

function writeArchive(directory, filenames) {
  const archive = path.join(directory, 'Archive.md');
  const bytes = filenames.map((filename) => `## ${filename}\n\n${archiveMarker(filename)}\n`).join('');
  fs.writeFileSync(archive, bytes);
  return archive;
}

function relocationSource(directory, filename) {
  return {
    source_file: path.join(directory, filename),
    source_location: sourceLocation(filename),
    archive_marker: archiveMarker(filename),
  };
}

function pyAst(query) {
  const code = `
import ast, sys
src = open(${JSON.stringify(SCRIPT)}).read()
tree = ast.parse(src)
${query}
`;
  return spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 5_000 });
}

test('REQ-MEM-009 setup: merge-vault-graph.py exists and is valid Python', () => {
  assert.ok(fs.existsSync(SCRIPT), 'merge-vault-graph.py must exist');
  const compile = spawnSync('python3', ['-m', 'py_compile', SCRIPT], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(compile.status, 0, `py_compile failed: ${compile.stderr}`);
});

test('REQ-MEM-009 AC1: script writes the cumulative vault graph back to vault_graph_path as the to_json path argument', () => {
  // The graphify export signature is to_json(graph, communities, path).
  // The persistence target is therefore the THIRD positional arg
  // (index 2). Pin it: the test must fail if vault_graph_path moves
  // out of args[2] (e.g. someone wires it as the communities arg by
  // mistake) and must also fail if BOTH to_json calls target out_path
  // only (the per-extraction artifact) instead of vault_graph_path.
  const r = pyAst(`
calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, 'id', '') == 'to_json']
ok = False
for c in calls:
    if len(c.args) < 3:
        continue
    path_arg = c.args[2]
    if (isinstance(path_arg, ast.Call)
        and getattr(path_arg.func, 'id', '') == 'str'
        and path_arg.args
        and isinstance(path_arg.args[0], ast.Name)
        and path_arg.args[0].id == 'vault_graph_path'):
        ok = True
        break
print('OK' if ok else 'MISSING')
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'OK', 'merge-vault-graph.py must call to_json(..., ..., str(vault_graph_path)) so the cumulative graph is persisted at the right path');
});

test('REQ-MEM-009 AC2: script unions the prior + new graphs via nx.compose (hash-keyed dedup)', () => {
  const r = pyAst(`
hits = [n for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr == 'compose'
        and isinstance(n.func.value, ast.Name)
        and n.func.value.id == 'nx']
print(len(hits))
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '1', 'merge-vault-graph.py must call nx.compose exactly once');
});

test('REQ-MEM-009 AC1/AC2: successive merges preserve prior nodes and deduplicate IDs', () => {
  const code = `
import json, runpy
module = runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='merge_contract_test')
empty = {'nodes': [], 'links': []}
first_chunk = {
  'nodes': [{'id': 'document', 'label': 'first'}],
  'links': [],
}
second_chunk = {
  'nodes': [
    {'id': 'document', 'label': 'replacement'},
    {'id': 'concept', 'label': 'new'},
  ],
  'links': [],
}
first = module['merge_node_link_evidence'](empty, first_chunk)
second = module['merge_node_link_evidence'](first, second_chunk)
print(json.dumps(second, sort_keys=True))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).nodes, [
    { id: 'document', label: 'first' },
    { id: 'concept', label: 'new' },
  ]);
});

test('REQ-MEM-009 AC3: edge evidence is keyed by semantic tuple', () => {
  const code = `
import json, runpy
module = runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='merge_contract_test')
duplicated = {
  'nodes': [],
  'links': [
    {'source': 'document', 'target': 'concept', 'relation': 'references', 'source_file': '/note.md'},
    {'source': 'document', 'target': 'concept', 'relation': 'references', 'source_file': '/note.md'},
  ],
}
persisted = {
  'nodes': [{'id': 'document'}, {'id': 'concept'}],
  'links': [
    {'source': 'document', 'target': 'concept', 'relation': 'mentions', 'source_file': '/new.md'},
  ],
}
prior = {
  'links': [
    {'source': 'document', 'target': 'concept', 'relation': 'references', 'source_file': '/prior.md'},
  ],
}
print(json.dumps({
  'deduplicated': module['dedupe_node_link_edges'](duplicated),
  'merged': module['merge_node_link_evidence'](persisted, prior, duplicated),
}, sort_keys=True))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.deduplicated.links, [
    { source: 'document', target: 'concept', relation: 'references', source_file: '/note.md' },
  ]);
  assert.deepEqual(output.merged.links, [
    { source: 'document', target: 'concept', relation: 'mentions', source_file: '/new.md' },
    { source: 'document', target: 'concept', relation: 'references', source_file: '/prior.md' },
    { source: 'document', target: 'concept', relation: 'references', source_file: '/note.md' },
  ]);
});

test('REQ-MEM-009: relocation changes only provenance and preserves every evidence record', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-relocate-fields-'));
  const archive = writeArchive(directory, [CAPTURE_A, CAPTURE_B, CAPTURE_C]);
  const oldA = path.join(directory, CAPTURE_A);
  const oldB = path.join(directory, CAPTURE_B);
  const keep = path.join(directory, 'Keep.md');
  const blob = {
    directed: true,
    graph: { retained: ['all', 'fields'] },
    nodes: [
      { id: 'session', label: 'Session', kind: 'document', source_file: oldA, source_location: 'line:1' },
      { id: 'concept', label: 'Concept', source_file: oldB, source_location: null },
      { id: 'other', label: 'Other', source_file: keep, source_location: 'line:4' },
    ],
    links: [
      { source: 'session', target: 'concept', relation: 'references', confidence: 'AMBIGUOUS', evidence: 'older archive fact', source_file: archive, source_location: sourceLocation(CAPTURE_C) },
      { source: 'session', target: 'concept', relation: 'references', confidence: 'EXTRACTED', confidence_score: 0.9, evidence: 'quoted fact', source_file: oldA, source_location: 'line:8' },
      { source: 'concept', target: 'other', relation: 'mentions', confidence: 'INFERRED', source_file: oldB, source_location: null },
      { source: 'other', target: 'concept', relation: 'contains', weight: 0.5, source_file: keep, source_location: 'line:7' },
    ],
  };
  const relocation = {
    archive_file: archive,
    sources: [relocationSource(directory, CAPTURE_A), relocationSource(directory, CAPTURE_B)],
  };
  const code = `
import json, runpy
module = runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='merge_contract_test')
blob = json.loads(${JSON.stringify(JSON.stringify(blob))})
relocation = json.loads(${JSON.stringify(JSON.stringify(relocation))})
print(json.dumps(module['relocate_node_link_provenance'](blob, relocation), sort_keys=True))
`;

  try {
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      directed: true,
      graph: { retained: ['all', 'fields'] },
      nodes: [
        { id: 'session', label: 'Session', kind: 'document', source_file: archive, source_location: sourceLocation(CAPTURE_A) },
        { id: 'concept', label: 'Concept', source_file: archive, source_location: sourceLocation(CAPTURE_B) },
        { id: 'other', label: 'Other', source_file: keep, source_location: 'line:4' },
      ],
      links: [
        { source: 'session', target: 'concept', relation: 'references', confidence: 'AMBIGUOUS', evidence: 'older archive fact', source_file: archive, source_location: sourceLocation(CAPTURE_C) },
        { source: 'session', target: 'concept', relation: 'references', confidence: 'EXTRACTED', confidence_score: 0.9, evidence: 'quoted fact', source_file: archive, source_location: sourceLocation(CAPTURE_A) },
        { source: 'concept', target: 'other', relation: 'mentions', confidence: 'INFERRED', source_file: archive, source_location: sourceLocation(CAPTURE_B) },
        { source: 'other', target: 'concept', relation: 'contains', weight: 0.5, source_file: keep, source_location: 'line:7' },
      ],
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('REQ-MEM-009: relocation verification fails on stale sources and unresolved archive locations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-relocate-verify-'));
  const archive = writeArchive(directory, [CAPTURE_A]);
  const old = path.join(directory, CAPTURE_A);
  const before = {
    nodes: [{ id: 'session', label: 'Session', source_file: old, source_location: null }],
    links: [{ source: 'session', target: 'concept', relation: 'references', confidence: 'EXTRACTED', source_file: old, source_location: null }],
  };
  const relocation = {
    archive_file: archive,
    sources: [relocationSource(directory, CAPTURE_A)],
  };
  const code = `
import json, runpy, sys
module = runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='merge_contract_test')
before = json.loads(${JSON.stringify(JSON.stringify(before))})
relocation = json.loads(${JSON.stringify(JSON.stringify(relocation))})
if sys.argv[1] == 'stale':
    after = before
else:
    after = {
      'nodes': [{'id': 'session', 'label': 'Session', 'source_file': ${JSON.stringify(archive)}, 'source_location': 'archive:wrong'}],
      'links': [{'source': 'session', 'target': 'concept', 'relation': 'references', 'confidence': 'EXTRACTED', 'source_file': ${JSON.stringify(archive)}, 'source_location': 'archive:wrong'}],
    }
module['verify_relocated_provenance'](before, after, relocation)
`;
  try {
    for (const [mode, failure] of [
      ['stale', 'relocation_failed: stale_source_file:'],
      ['unresolved', 'relocation_failed: unresolved_node_location'],
    ]) {
      const result = spawnSync('python3', ['-c', code, mode], { encoding: 'utf8', timeout: 5_000 });
      assert.notEqual(result.status, 0, `${mode} unexpectedly succeeded`);
      assert.match(result.stderr, new RegExp(failure), mode);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('REQ-MEM-009: --relocate atomically transforms only the existing cumulative graph', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-merge-relocate-'));
  const chunkPath = path.join(directory, 'nonexistent-chunk.json');
  const vaultPath = path.join(directory, 'vault-graph.json');
  const outPath = path.join(directory, 'graph.json');
  const relocationPath = path.join(directory, 'relocation.json');
  const old = path.join(directory, CAPTURE_A);
  const archive = writeArchive(directory, [CAPTURE_A]);
  const prior = {
    directed: true,
    graph: { retained: true },
    nodes: [{ id: 'session', label: 'Session', metadata: { retained: true }, source_file: old, source_location: null }],
    links: [{ source: 'session', target: 'concept', relation: 'references', evidence: 'fact', source_file: old, source_location: null }],
  };
  const run = () => {
    const code = `
import runpy, sys
sys.argv = [${JSON.stringify(SCRIPT)}, ${JSON.stringify(chunkPath)}, ${JSON.stringify(vaultPath)}, ${JSON.stringify(outPath)}, '--relocate', ${JSON.stringify(relocationPath)}]
runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='__main__')
`;
    return spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 5_000 });
  };

  try {
    fs.writeFileSync(vaultPath, JSON.stringify(prior));
    fs.writeFileSync(outPath, 'unchanged output');
    fs.writeFileSync(relocationPath, JSON.stringify({
      archive_file: archive,
      sources: [{ source_file: old, source_location: '', archive_marker: '' }],
    }));

    const invalid = run();
    assert.notEqual(invalid.status, 0, 'invalid relocation unexpectedly succeeded');
    assert.match(invalid.stderr, /relocation_input_invalid:/);
    assert.deepEqual(JSON.parse(fs.readFileSync(vaultPath, 'utf8')), prior);
    assert.equal(fs.readFileSync(outPath, 'utf8'), 'unchanged output');

    fs.writeFileSync(relocationPath, JSON.stringify({
      archive_file: archive,
      sources: [relocationSource(directory, CAPTURE_A)],
    }));
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    const expected = {
      directed: true,
      graph: { retained: true },
      nodes: [{ id: 'session', label: 'Session', metadata: { retained: true }, source_file: archive, source_location: sourceLocation(CAPTURE_A) }],
      links: [{ source: 'session', target: 'concept', relation: 'references', evidence: 'fact', source_file: archive, source_location: sourceLocation(CAPTURE_A) }],
    };
    assert.deepEqual(JSON.parse(fs.readFileSync(vaultPath, 'utf8')), expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), expected);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('REQ-MEM-009: archived edge evidence survives relocation, repetition, and later merges', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-relocate-evidence-'));
  const archive = writeArchive(directory, [CAPTURE_A, CAPTURE_B, CAPTURE_C]);
  const oldA = path.join(directory, CAPTURE_A);
  const oldB = path.join(directory, CAPTURE_B);
  const later = path.join(directory, 'later.md');
  const blob = {
    nodes: [{ id: 'document' }, { id: 'concept' }],
    links: [
      { source: 'document', target: 'concept', relation: 'references', evidence: 'archive-c', source_file: archive, source_location: sourceLocation(CAPTURE_C) },
      { source: 'document', target: 'concept', relation: 'references', evidence: 'capture-a', source_file: oldA, source_location: 'line:4' },
      { source: 'document', target: 'concept', relation: 'references', evidence: 'capture-b', source_file: oldB, source_location: 'line:9' },
    ],
  };
  const relocation = {
    archive_file: archive,
    sources: [relocationSource(directory, CAPTURE_A), relocationSource(directory, CAPTURE_B)],
  };
  const next = {
    nodes: [],
    links: [{ source: 'document', target: 'concept', relation: 'references', evidence: 'later', source_file: later }],
  };
  const code = `
import json, runpy
module = runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='merge_contract_test')
blob = json.loads(${JSON.stringify(JSON.stringify(blob))})
relocation = json.loads(${JSON.stringify(JSON.stringify(relocation))})
once = module['relocate_node_link_provenance'](blob, relocation)
twice = module['relocate_node_link_provenance'](once, relocation)
merged = module['merge_node_link_evidence'](twice, json.loads(${JSON.stringify(JSON.stringify(next))}))
print(json.dumps({'once': once, 'twice': twice, 'merged': merged}, sort_keys=True))
`;

  try {
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.twice, output.once, 'relocation must be idempotent');
    assert.deepEqual(output.once.links.map((edge) => [edge.evidence, edge.source_location]), [
      ['archive-c', sourceLocation(CAPTURE_C)],
      ['capture-a', sourceLocation(CAPTURE_A)],
      ['capture-b', sourceLocation(CAPTURE_B)],
    ]);
    assert.deepEqual(output.merged.links.map((edge) => edge.evidence), [
      'archive-c',
      'capture-a',
      'capture-b',
      'later',
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('REQ-MEM-009: --relocate rejects missing or corrupt cumulative graphs without publication', () => {
  for (const [name, graphBytes] of [['missing', null], ['corrupt', '{not-json']]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `vault-relocate-${name}-`));
    const vaultPath = path.join(directory, 'vault-graph.json');
    const outPath = path.join(directory, 'graph.json');
    const relocationPath = path.join(directory, 'relocation.json');
    const archive = writeArchive(directory, [CAPTURE_A]);
    const relocation = {
      archive_file: archive,
      sources: [relocationSource(directory, CAPTURE_A)],
    };
    try {
      if (graphBytes !== null) fs.writeFileSync(vaultPath, graphBytes);
      fs.writeFileSync(outPath, 'unchanged output');
      fs.writeFileSync(relocationPath, JSON.stringify(relocation));
      const code = `
import runpy, sys
sys.argv = [${JSON.stringify(SCRIPT)}, ${JSON.stringify(path.join(directory, 'missing-chunk.json'))}, ${JSON.stringify(vaultPath)}, ${JSON.stringify(outPath)}, '--relocate', ${JSON.stringify(relocationPath)}]
runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='__main__')
`;
      const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 5_000 });
      assert.notEqual(result.status, 0, `${name} cumulative graph unexpectedly succeeded`);
      assert.match(result.stderr, /relocation_failed: vault_graph_unreadable:/, name);
      assert.equal(fs.readFileSync(outPath, 'utf8'), 'unchanged output', name);
      if (graphBytes === null) assert.equal(fs.existsSync(vaultPath), false, name);
      else assert.equal(fs.readFileSync(vaultPath, 'utf8'), graphBytes, name);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('REQ-MEM-009: --relocate rejects a destination marker absent from Archive.md bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-relocate-marker-'));
  const vaultPath = path.join(directory, 'vault-graph.json');
  const outPath = path.join(directory, 'graph.json');
  const relocationPath = path.join(directory, 'relocation.json');
  const archive = writeArchive(directory, [CAPTURE_A]);
  const old = path.join(directory, CAPTURE_B);
  const prior = {
    nodes: [{ id: 'session', source_file: old, source_location: 'line:1' }],
    links: [],
  };
  try {
    fs.writeFileSync(vaultPath, JSON.stringify(prior));
    fs.writeFileSync(outPath, 'unchanged output');
    fs.writeFileSync(relocationPath, JSON.stringify({
      archive_file: archive,
      sources: [relocationSource(directory, CAPTURE_B)],
    }));
    const code = `
import runpy, sys
sys.argv = [${JSON.stringify(SCRIPT)}, ${JSON.stringify(path.join(directory, 'missing-chunk.json'))}, ${JSON.stringify(vaultPath)}, ${JSON.stringify(outPath)}, '--relocate', ${JSON.stringify(relocationPath)}]
runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='__main__')
`;
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 5_000 });
    assert.notEqual(result.status, 0, 'nonexistent archive marker unexpectedly succeeded');
    assert.match(result.stderr, /relocation_input_invalid: archive_marker not found:/);
    assert.deepEqual(JSON.parse(fs.readFileSync(vaultPath, 'utf8')), prior);
    assert.equal(fs.readFileSync(outPath, 'utf8'), 'unchanged output');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('REQ-MEM-009 AC4: malformed edge entries are ignored without crashing', () => {
  const code = `
import json, runpy
module = runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='merge_contract_test')
persisted = {'nodes': [{'id': 'document'}, {'id': 'concept'}], 'links': []}
missing_edges = {'nodes': [], 'links': None}
malformed_prior = {
  'nodes': [],
  'links': [
    {'source': ['document'], 'target': 'concept', 'relation': 'mentions', 'source_file': '/bad.md'},
    {'source': 'document', 'target': {'id': 'concept'}, 'relation': 'mentions', 'source_file': '/bad.md'},
  ],
}
new = {
  'links': [
    {'source': 'document', 'target': 'concept', 'relation': 'mentions', 'source_file': '/new.md'},
  ],
}
print(json.dumps(module['merge_node_link_evidence'](persisted, missing_edges, malformed_prior, new), sort_keys=True))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).links, [
    { source: 'document', target: 'concept', relation: 'mentions', source_file: '/new.md' },
  ]);
});

test('REQ-MEM-009 AC2: script normalises both operands to directed before nx.compose (no crash on an undirected prior graph)', () => {
  // build_from_json returns an undirected Graph, and a prior vault-graph.json
  // written by an older release (directed:false, or lacking the flag) also
  // loads undirected. nx.compose raises "All graphs must be directed or
  // undirected" when its operands disagree, so the script must call
  // .to_directed() on both G_prior and G_new first. Gut-check: delete the two
  // normalisation calls and this drops to 0.
  const r = pyAst(`
calls = [n for n in ast.walk(tree)
         if isinstance(n, ast.Call)
         and isinstance(n.func, ast.Attribute)
         and n.func.attr == 'to_directed']
print(len(calls))
`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    Number(r.stdout.trim()) >= 2,
    'script must call .to_directed() on both G_prior and G_new so nx.compose never raises on an undirected prior graph',
  );
});

test('REQ-MEM-009: missing or corrupt persistent graph input recovers to a valid merged graph', () => {
  for (const [name, persisted] of [['missing', null], ['corrupt', '{not-json']]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `vault-merge-${name}-`));
    const chunkPath = path.join(directory, 'chunk.json');
    const vaultPath = path.join(directory, 'vault-graph.json');
    const outPath = path.join(directory, 'graph.json');

    try {
      fs.writeFileSync(chunkPath, JSON.stringify({ nodes: [{ id: 'new' }], links: [] }));
      if (persisted !== null) fs.writeFileSync(vaultPath, persisted);
      const code = `
import json, runpy, sys, types

class Graph:
    def __init__(self, blob=None):
        self.blob = blob or {'nodes': [], 'links': []}
    def is_directed(self):
        return True
    def to_directed(self):
        return self
    def number_of_nodes(self):
        return len(self.blob.get('nodes', []))

def compose(left, right):
    nodes = {}
    for item in left.blob.get('nodes', []) + right.blob.get('nodes', []):
        if isinstance(item, dict) and isinstance(item.get('id'), str):
            nodes.setdefault(item['id'], item)
    return Graph({'nodes': list(nodes.values()), 'links': left.blob.get('links', []) + right.blob.get('links', [])})

networkx = types.ModuleType('networkx')
networkx.DiGraph = Graph
networkx.node_link_graph = lambda blob, edges='edges': Graph(blob)
networkx.compose = compose
sys.modules['networkx'] = networkx

graphify = types.ModuleType('graphify')
graphify.__path__ = []
build = types.ModuleType('graphify.build')
build.build_from_json = lambda blob: Graph(blob)
cluster_module = types.ModuleType('graphify.cluster')
cluster_module.cluster = lambda graph: {}
export = types.ModuleType('graphify.export')
export.to_json = lambda graph, communities, output: open(output, 'w', encoding='utf-8').write(json.dumps(graph.blob))
sys.modules.update({'graphify': graphify, 'graphify.build': build, 'graphify.cluster': cluster_module, 'graphify.export': export})

sys.argv = [${JSON.stringify(SCRIPT)}, ${JSON.stringify(chunkPath)}, ${JSON.stringify(vaultPath)}, ${JSON.stringify(outPath)}]
runpy.run_path(${JSON.stringify(SCRIPT)}, run_name='__main__')
`;
      const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 5_000 });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      const persistedGraph = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
      assert.deepEqual(persistedGraph.nodes.map((node) => node.id), ['new'], name);
      assert.deepEqual(persistedGraph.links, [], name);
      assert.deepEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), persistedGraph, name);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('REQ-MEM-009: the Pi-local merge-vault-graph.py is byte-identical to the Claude copy (path-agnostic, no drift)', () => {
  // Pi reaches nothing in .claude: it ships its own copy under preseed/agents/pi/scripts/,
  // registered in the Pi manifest and deployed to /home/user/.pi/agent/scripts/. The script
  // is path-agnostic (DEFAULT_* constants + positional overrides), so the copy must stay
  // byte-identical to the Claude one or the two runtimes silently diverge.
  const PI_SCRIPT = path.join(__dirname, '..', '..', 'preseed', 'agents', 'pi', 'scripts', 'merge-vault-graph.py');
  assert.ok(fs.existsSync(PI_SCRIPT), 'Pi merge-vault-graph.py must be preseeded under preseed/agents/pi/scripts/');
  assert.equal(
    fs.readFileSync(PI_SCRIPT, 'utf8'),
    fs.readFileSync(SCRIPT, 'utf8'),
    'Pi and Claude merge-vault-graph.py must stay byte-identical',
  );
});
