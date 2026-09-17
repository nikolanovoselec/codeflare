/** REQ-OPERATOR-005: stable explicit upload receipts; independent parent verification remains separate. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { OperatorSyncService } from '../dist/operator-sync.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const a = Buffer.from('alpha');
const b = Buffer.from('beta');
const request = { operationId: 'sync-1', requestDigest: 'a'.repeat(64), files: [
  { path: 'reports/a.txt', size: a.length, sha256: digest(a) },
  { path: 'reports/b.txt', size: b.length, sha256: digest(b) },
] };
function fixture(overrides = {}) {
  let receipt = overrides.receipt ?? null;
  const saves = [];
  const puts = [];
  const store = { async load() { return receipt ? structuredClone(receipt) : null; }, async save(value) {
    receipt = structuredClone(value); saves.push(structuredClone(value));
  } };
  const content = new Map([['reports/a.txt', a], ['reports/b.txt', b]]);
  const files = { async read(path, size) { const value = content.get(path); if (!value || value.length !== size) throw new Error('bad file'); return value; } };
  const uploader = { async put(key, bytes) { puts.push([key, Buffer.from(bytes)]); } };
  const service = new OperatorSyncService({ activityId: 'activity-1', sessionId: 'session-1', policyDigest: 'b'.repeat(64),
    root: '/owned/output', remotePrefix: 'Remote Reviews/activity-1/session-1/sync-1/',
    deadline: Date.now() + 60_000, store, files, uploader, ...overrides.options });
  return { service, store, files, uploader, saves, puts, receipt: () => receipt };
}

test('REQ-OPERATOR-005: persists intent then uploads exact files and canonical manifest last', async () => {
  const f = fixture();
  const result = await f.service.upload(request);
  assert.equal(result.status, 'uploaded');
  assert.deepEqual(f.saves.map(value => value.status), ['accepted', 'uploading', 'uploaded']);
  assert.deepEqual(f.puts.map(([key]) => key), [
    'Remote Reviews/activity-1/session-1/sync-1/reports/a.txt',
    'Remote Reviews/activity-1/session-1/sync-1/reports/b.txt',
    'Remote Reviews/activity-1/session-1/sync-1/manifest.json',
  ]);
  const manifest = f.puts.at(-1)[1];
  assert.equal(digest(manifest), result.manifestDigest);
  assert.deepEqual(JSON.parse(manifest), { schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1',
    operationId: 'sync-1', requestDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), files: request.files });
});

test('REQ-OPERATOR-005: same operation reconciles and changed reuse conflicts without another upload', async () => {
  const first = fixture();
  const uploaded = await first.service.upload(request);
  const replay = fixture({ receipt: uploaded });
  assert.deepEqual(await replay.service.upload(request), uploaded);
  assert.deepEqual(replay.puts, []);
  await assert.rejects(replay.service.upload({ ...request, requestDigest: 'c'.repeat(64) }), /conflict/i);
  assert.deepEqual(replay.puts, []);
});

test('REQ-OPERATOR-005: interrupted upload becomes unknown and is never automatically replayed', async () => {
  const f = fixture();
  f.uploader.put = async (key, bytes) => { f.puts.push([key, Buffer.from(bytes)]); throw new Error('transport lost'); };
  await assert.rejects(f.service.upload(request), /outcome.*unknown/i);
  assert.equal(f.receipt().status, 'unknown');
  assert.equal(f.puts.length, 1);
  await assert.rejects(f.service.upload(request), /outcome.*unknown/i);
  assert.equal(f.puts.length, 1);
});

test('REQ-OPERATOR-005: rejects expiry, traversal, duplicate paths and size/hash mismatch before remote writes', async () => {
  const expired = fixture({ options: { deadline: Date.now() - 1 } });
  await assert.rejects(expired.service.upload(request), /expired/i);
  assert.deepEqual(expired.saves, []);
  for (const files of [
    [{ path: '../escape', size: 1, sha256: 'a'.repeat(64) }],
    [{ path: 'same', size: 1, sha256: 'a'.repeat(64) }, { path: 'same', size: 1, sha256: 'b'.repeat(64) }],
  ]) {
    const f = fixture();
    await assert.rejects(f.service.upload({ ...request, files }), /invalid/i);
    assert.deepEqual(f.puts, []);
  }
  const mismatch = fixture();
  await assert.rejects(mismatch.service.upload({ ...request, files: [{ ...request.files[0], sha256: 'f'.repeat(64) }] }), /file.*mismatch/i);
  assert.deepEqual(mismatch.puts, []);
  assert.equal(mismatch.receipt().status, 'failed');
});
