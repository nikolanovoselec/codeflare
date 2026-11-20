import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { shareClaudeNative } from '../../scripts/ci/share-claude-native.mjs';

function fixture(t, officialBytes = 'identical native payload') {
  const root = mkdtempSync(join(tmpdir(), 'claude-native-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const native = join(root, 'native'), alias = join(root, 'cli.js'), launcher = join(root, 'claude'), official = join(root, 'official');
  writeFileSync(native, 'identical native payload', { mode: 0o755 });
  linkSync(native, alias); symlinkSync(alias, launcher);
  writeFileSync(official, officialBytes); chmodSync(official, 0o555);
  return { native, alias, launcher, official };
}

test('shares identical native bytes across CLI aliases and the immutable official extension path', async t => {
  const f = fixture(t), bytes = readFileSync(f.official), mode = statSync(f.official).mode & 0o777;
  const result = await shareClaudeNative(f.launcher, f.official);
  assert.equal(result.shared, true); assert.equal(result.bytesSaved, bytes.length);
  for (const path of [f.native, f.alias, f.official]) {
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(statSync(path).ino, statSync(f.native).ino);
    assert.equal(statSync(path).dev, statSync(f.native).dev);
    assert.equal(statSync(path).mode & 0o777, mode);
  }
  assert.equal(lstatSync(f.launcher).isSymbolicLink(), true); assert.equal(readlinkSync(f.launcher), f.alias);
  assert.deepEqual(readFileSync(f.launcher), bytes);
  assert.equal((await shareClaudeNative(f.launcher, f.official)).bytesSaved, 0);
});

test('same-sized but different executables retain their original bytes and permissions', async t => {
  const f = fixture(t, 'DIFFERENT NATIVE PAYLOAD'), before = [f.native, f.official].map(p => ({ bytes: readFileSync(p), mode: statSync(p).mode }));
  assert.equal(before[0].bytes.length, before[1].bytes.length);
  assert.equal((await shareClaudeNative(f.launcher, f.official)).shared, false);
  [f.native, f.official].forEach((p, i) => { assert.deepEqual(readFileSync(p), before[i].bytes); assert.equal(statSync(p).mode, before[i].mode); });
});

test('rejects a symlink official payload without replacing it', async t => {
  const f = fixture(t), target = join(tmpdir(), 'not-used');
  rmSync(f.official); symlinkSync(target, f.official);
  await assert.rejects(shareClaudeNative(f.launcher, f.official));
  assert.equal(lstatSync(f.official).isSymbolicLink(), true); assert.equal(readlinkSync(f.official), target);
});

test('does not claim storage savings when the original official payload has another alias', async t => {
  const f = fixture(t); linkSync(f.official, f.official + '.alias');
  assert.equal((await shareClaudeNative(f.launcher, f.official)).shared, false);
  assert.notEqual(statSync(f.native).ino, statSync(f.official).ino);
});
