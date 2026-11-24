import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHermesMergeStorage, hermesSnapshotDigest, runHermesShutdownMerge } from '../src/hermes-shutdown-merge.ts';

const bucket = 'owner-bucket';
const root = 'Vault/Memory/';
const session = 'lifecycle123';
const prefix = `${root}Sessions/${session}/`;
const files = ['global/USER.md', 'global/MEMORY.md', 'global/failures.md', 'Projects/workspace/MEMORY.md'];
const all = memory => Object.fromEntries(files.map(file => [file, file === 'global/MEMORY.md' ? memory : '']));
const bytes = texts => Object.fromEntries(files.map(file => [file, Buffer.from(texts[file])]));

const master = file => root + file.replace(/^global\//, '');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-rclone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'rclone.conf');
  const remote = join(dir, 'remote'), home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(configFile, `[r2]\ntype = alias\nremote = ${remote}\n`, { mode: 0o600 });
  const path = key => join(remote, bucket, key);
  const put = (key, data) => { mkdirSync(dirname(path(key)), { recursive: true }); writeFileSync(path(key), data); };
  const baseline = all('Known fact.'), snapshot = all('Known fact.\n§\nNew fact.');
  put(prefix + 'baseline.json', JSON.stringify(baseline));
  for (const file of files) put(prefix + file, snapshot[file]);
  put(master('global/MEMORY.md'), 'Peer fact.');
  put(root + 'other.md', 'Untouched');
  put(root + 'Masters/current.json', 'Unused historical object');
  const source = { owner: bucket, sessionId: session, generation: 7, intent: 'stop-7',
    snapshotId: hermesSnapshotDigest(bytes(baseline), bytes(snapshot)) };
  const storage = createHermesMergeStorage({ bucket, configFile, home });
  const run = (id = source, infer = () => bytes(all('Published fact.'))) => runHermesShutdownMerge({
    source: id, deadline: Date.now() + 20_000, signal: new AbortController().signal, storage, infer,
  });
  return { path, put, source, run, home };
}

test('REQ-MEM-044: rclone pulls and writes only the four fixed master objects', async t => {
  const f = fixture(t);
  const output = all('Peer fact.\n§\nNew fact.');
  const result = await f.run(f.source, input => {
    assert.equal(input.masters['global/MEMORY.md'], 'Peer fact.');
    assert.equal(readFileSync(join(f.home, master('global/MEMORY.md')), 'utf8'), 'Peer fact.');
    assert.deepEqual(input.changes['global/MEMORY.md'], ['New fact.']);
    return bytes(output);
  });
  assert.deepEqual(result, { status: 'merged', receipt: { source: f.source } });
  for (const file of files) {
    assert.equal(readFileSync(f.path(master(file)), 'utf8'), output[file]);
    assert.equal(readFileSync(join(f.home, master(file)), 'utf8'), output[file]);
  }
  assert.deepEqual(readdirSync(f.path(root + 'Masters')), ['current.json']);
  assert.equal(readFileSync(f.path(root + 'Masters/current.json'), 'utf8'), 'Unused historical object');
  assert.equal(readFileSync(f.path(root + 'other.md'), 'utf8'), 'Untouched');
});

test('REQ-MEM-044: a reseeded baseline preserves subsequent whole-entry change detection', async t => {
  const f = fixture(t);
  const baselineKey = `${prefix}baseline.json`;
  const baseline = JSON.parse(readFileSync(f.path(baselineKey), 'utf8'));
  const reseed = { owner: bucket, sessionId: session, snapshotId: 'c'.repeat(64), revision: 'previous-reseed',
    files: Object.fromEntries(files.map(file => [file, createHash('sha256').update(baseline[file]).digest('hex')])),
  };
  f.put(baselineKey, Buffer.from(JSON.stringify({ ...baseline, _reseed: reseed })));
  const result = await f.run(f.source, input => {
    assert.deepEqual(input.changes['global/MEMORY.md'], ['New fact.']);
    return bytes(all('Known fact.\n§\nNew fact.'));
  });
  assert.equal(result.status, 'merged');
});

test('REQ-MEM-044: missing baseline or a different durable snapshot never reaches inference', async t => {
  const f = fixture(t);
  f.put(`${prefix}global/MEMORY.md`, Buffer.from('A later save.'));
  const never = () => assert.fail('inference must not receive substituted inputs');
  let attempted = false;
  const infer = () => { attempted = true; return never(); };
  assert.deepEqual(await f.run(f.source, infer), { status: 'pending' });
  rmSync(f.path(`${prefix}baseline.json`));
  assert.deepEqual(await f.run(f.source, infer), { status: 'pending' });
  assert.equal(attempted, false);
  assert.equal(readFileSync(f.path(master('global/MEMORY.md')), 'utf8'), 'Peer fact.');
});
