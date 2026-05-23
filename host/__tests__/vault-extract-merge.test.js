// REQ-MEM-009: vault-extract cumulative merge pipeline.
//
// AC1/AC2/AC4 are now implemented by merge-vault-graph.py (extracted
// from the prompt). Tests inspect the Python script's AST via a
// subprocess: py_compile validates syntax, ast.parse + dump verifies
// the expected imports and function calls actually exist as Python
// nodes (not just byte patterns in prose). Gut-check: rename
// nx.compose to nx.union and AC2 fails; remove the try/except and AC4
// fails; remove to_json(...vault_graph_path...) and AC1 fails.
//
// AC3 + AC5 still test the prompt: the global-add invocation and the
// flock scope live in the orchestrating bash, not the Python script,
// and rewriting them as a separate script would add no behavioural
// coverage (the bash is a single command line).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = path.join(__dirname, '..', '..', 'preseed', 'agents', 'claude', 'plugins', 'codeflare-vault', 'scripts');
const SCRIPT = path.join(VAULT_DIR, 'merge-vault-graph.py');
const PROMPT = path.join(VAULT_DIR, 'vault-extract-prompt.md');

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

test('REQ-MEM-009 AC4: script wraps the vault-graph.json load in try/except so missing/corrupt files reset to a fresh DiGraph', () => {
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

test('REQ-MEM-009 AC3: prompt step 5 feeds vault-graph.json to `graphify global add --as user_vault` (not the per-chunk graph)', () => {
  const body = fs.readFileSync(PROMPT, 'utf8');
  assert.match(
    body,
    /graphify\s+global\s+add\s[\s\S]{0,200}vault-graph\.json[\s\S]{0,200}--as\s+user_vault/,
    'prompt step 5 must call `graphify global add <vault-graph.json> --as user_vault`',
  );
});

test('REQ-MEM-009 AC5: prompt wraps the merge invocation under flock /tmp/graphify-global.lock', () => {
  const body = fs.readFileSync(PROMPT, 'utf8');
  const flockMatches = body.match(/flock\s+-w\s+\d+\s+\/tmp\/graphify-global\.lock/g) || [];
  assert.ok(flockMatches.length >= 2, `expected >=2 flock wrappers (steps 4 + 5), got ${flockMatches.length}`);
  assert.match(
    body,
    /flock\s+-w\s+\d+\s+\/tmp\/graphify-global\.lock\s+\S*python\S*\s+\S*merge-vault-graph\.py/,
    'prompt step 4 must invoke merge-vault-graph.py under flock',
  );
});
