import assert from 'node:assert/strict';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inventory } from '../../scripts/ci/image-size-inventory.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'image-size-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('counts hardlink names logically but allocated inodes once, including across selected roots', t => {
  const root = fixture(t), a = join(root, 'a'), b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  const first = join(a, 'file'), second = join(a, 'link'), third = join(b, 'link');
  writeFileSync(first, 'hello inventory'); linkSync(first, second); linkSync(first, third);
  const report = inventory([a, b]);
  const file = lstatSync(first), dirA = lstatSync(a), dirB = lstatSync(b);
  assert.equal(report.incomplete, false);
  assert.equal(report.measurements[0].bytes.apparentBytes, dirA.size + file.size * 2);
  assert.equal(report.measurements[0].bytes.allocatedBytes, (dirA.blocks + file.blocks) * 512);
  assert.equal(report.measurements[0].bytes.hardlinkDuplicateBytes, file.size);
  assert.equal(report.selectedRoots.apparentBytes, dirA.size + dirB.size + file.size * 3);
  assert.equal(report.selectedRoots.allocatedBytes, (dirA.blocks + dirB.blocks + file.blocks) * 512);
  assert.equal(report.selectedRoots.hardlinkDuplicateBytes, file.size * 2);
});

test('does not follow symlinks, including cycles, dangling links, or selected-root ancestors', t => {
  const root = fixture(t), inside = join(root, 'inside'), outside = join(root, 'outside');
  mkdirSync(inside); mkdirSync(outside); writeFileSync(join(outside, 'private'), 'not counted');
  symlinkSync(outside, join(inside, 'escape')); symlinkSync(inside, join(inside, 'cycle'));
  symlinkSync(join(root, 'absent'), join(inside, 'dangling'));
  const report = inventory([inside]);
  assert.equal(report.incomplete, false);
  assert.equal(report.measurements[0].bytes.entries, 4);
  assert.equal(report.measurements[0].bytes.apparentBytes, ['escape', 'cycle', 'dangling']
    .reduce((sum, name) => sum + lstatSync(join(inside, name)).size, lstatSync(inside).size));
  const escaped = inventory([join(inside, 'escape', 'private')]).measurements[0];
  assert.equal(escaped.status, 'unavailable'); assert.equal(escaped.bytes, null);
  assert.equal(escaped.reason, 'measurement-error');
});

test('missing paths are unavailable, never measured zero; entry, depth and time bounds flag partial data', t => {
  const root = fixture(t); mkdirSync(join(root, 'nested')); writeFileSync(join(root, 'nested', 'file'), 'x');
  const missing = inventory([join(root, 'absent')]).measurements[0];
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.bytes, null);
  assert.equal(missing.reason, 'missing'); assert.equal(missing.incomplete, true);
  for (const limits of [{ maxEntries: 1 }, { maxDepth: 0 }, { maxMillis: 0 }]) {
    const report = inventory([root], limits);
    assert.equal(report.incomplete, true); assert.equal(report.measurements[0].reason, 'bound');
  }
  assert.throws(() => inventory([root], { maxEntries: -1 }), /invalid measurement/);
  assert.throws(() => inventory([root], { maxMillis: NaN }), /invalid measurement/);
});

test('package buckets report separate scoped and unscoped installed subtree sizes without loading packages', t => {
  const modules = join(fixture(t), 'node_modules');
  for (const name of ['plain', '@scope/tool']) {
    mkdirSync(join(modules, name), { recursive: true });
    writeFileSync(join(modules, name, 'index.js'), 'throw Error("must not execute")');
  }
  const report = inventory([modules]);
  assert.equal(inventory([modules], { maxBuckets: 1 }).measurements[0].reason, 'bound');
  for (const name of ['plain', '@scope/tool']) {
    const bucket = report.measurements[0].buckets.find(b => b.name === name);
    assert.equal(bucket.apparentBytes, lstatSync(join(modules, name)).size + lstatSync(join(modules, name, 'index.js')).size);
    assert.equal(bucket.entries, 2);
  }
});
