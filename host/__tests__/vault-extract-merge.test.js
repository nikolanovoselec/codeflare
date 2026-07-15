// REQ-MEM-009: vault-extract cumulative merge pipeline.
//
// Behavioral cases execute merge-vault-graph.py against persisted and
// request graphs. Focused AST checks cover recovery branches that are
// difficult to trigger without coupling tests to NetworkX internals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = path.join(__dirname, '..', '..', 'preseed', 'agents', 'claude', 'plugins', 'codeflare-vault', 'scripts');
const SCRIPT = path.join(VAULT_DIR, 'merge-vault-graph.py');

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

test('REQ-MEM-009: missing or corrupt persistent graph input has a guarded recovery branch', () => {
  const r = pyAst(`
tries = [n for n in ast.walk(tree) if isinstance(n, ast.Try)]
ok = False
for t in tries:
    body_src = ast.unparse(t)
    if 'vault_graph_path' in body_src and t.handlers:
        ok = True
        break
print('OK' if ok else 'MISSING')
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'OK', 'merge-vault-graph.py must wrap the vault_graph_path read in a try/except block');
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
