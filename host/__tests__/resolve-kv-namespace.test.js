import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/ci/resolve-kv-namespace.sh', import.meta.url));
const original = '[[kv_namespaces]]\nbinding = "KV"\nid = "placeholder"\n';
const title = 'fixture-worker-kv';
const existing = 'a'.repeat(32);
const created = 'b'.repeat(32);

function resolveNamespace(inventory, listStatus = '0') {
  const root = mkdtempSync(join(tmpdir(), 'resolve-kv-namespace-'));
  try {
    const config = join(root, 'wrangler.toml');
    writeFileSync(config, original);
    writeFileSync(join(root, 'calls'), '');
    writeFileSync(join(root, 'npx'), `#!/bin/bash
printf '%s\\n' "$*" >> calls
case "$*" in
  'wrangler kv namespace list')
    printf '%s\\n' 'Wrangler diagnostic on stderr' >&2
    printf '%s' "$INVENTORY"
    exit "$LIST_STATUS"
    ;;
  'wrangler kv namespace create ${title}') printf '%s\\n' 'id = "${created}"' ;;
  *) exit 90 ;;
esac
`, { mode: 0o700 });
    const result = spawnSync('bash', [script], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: `${root}:${process.env.PATH}`, WORKER_NAME: 'fixture-worker', INVENTORY: inventory, LIST_STATUS: listStatus },
    });
    if (result.error) throw result.error;
    return { ...result, config: readFileSync(config, 'utf8'), calls: readFileSync(join(root, 'calls'), 'utf8').trim().split('\n') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const list = 'wrangler kv namespace list';
const match = { title, id: existing };

test('REQ-OPS-001 AC5: reuses the namespace from a valid inventory', () => {
  const result = resolveNamespace(JSON.stringify([match], null, 2));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [list]);
  assert.equal(result.config, original.replace('placeholder', existing));
});

test('REQ-OPS-001 AC5: creates the namespace only when a valid inventory confirms absence', () => {
  for (const inventory of [[], [{ ...match, title: `other-${title}` }]]) {
    const result = resolveNamespace(JSON.stringify(inventory));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [list, `wrangler kv namespace create ${title}`]);
    assert.equal(result.config, original.replace('placeholder', created));
  }
});

test('REQ-OPS-001 AC5: failed or unusable inventory cannot create or rebind KV', () => {
  for (const [inventory, status] of [
    ['', '0'], [' \n', '0'], ['[', '0'], ['{}', '0'], ['[]\n[]', '0'],
    ['[null]', '0'], ['[{"id":"bad"}]', '0'],
    [JSON.stringify([{ ...match, id: 'bad' }]), '0'],
    [JSON.stringify([match, { ...match, id: created }]), '0'],
    [JSON.stringify([match]), '1'],
  ]) {
    const result = resolveNamespace(inventory, status);
    assert.equal(result.status, 1, JSON.stringify([inventory, status, result.stderr]));
    assert.deepEqual(result.calls, [list]);
    assert.equal(result.config, original);
  }
});
