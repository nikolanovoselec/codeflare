import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createHermesMergeStorage, hermesSnapshotDigest, runHermesShutdownMerge } from '../src/hermes-shutdown-merge.ts';

const bucket = 'owner-bucket';
const endpoint = 'https://fixture.r2.cloudflarestorage.com';
const root = 'Vault/Memory/';
const session = 'lifecycle123';
const prefix = `${root}Sessions/${session}/`;
const pointer = `${root}Masters/current.json`;
const files = ['global/USER.md', 'global/MEMORY.md', 'global/failures.md', 'Projects/workspace/MEMORY.md'];
const all = memory => Object.fromEntries(files.map(file => [file, file === 'global/MEMORY.md' ? memory : '']));
const bytes = texts => Object.fromEntries(files.map(file => [file, Buffer.from(texts[file])]));

function fixture({ encrypted = false, emptyDefaultEncrypted = false } = {}) {
  const baseline = all('Known fact.'), snapshot = all('Known fact.\n§\nNew fact.');
  const objects = new Map([[`${prefix}baseline.json`, Buffer.from(JSON.stringify(baseline))]]);
  const etags = new Map(), trace = [];
  for (const file of files) objects.set(prefix + file, Buffer.from(snapshot[file]));
  objects.set(`${root}MEMORY.md`, Buffer.from(baseline['global/MEMORY.md']));
  const source = { owner: bucket, sessionId: session, generation: 7, intent: 'stop-7',
    snapshotId: hermesSnapshotDigest(bytes(baseline), bytes(snapshot)) };
  const sseHeaders = encrypted ? { 'x-amz-server-side-encryption-customer-algorithm': 'AES256',
    'x-amz-server-side-encryption-customer-key': 'synthetic-fixture-key' } : {};
  const storage = createHermesMergeStorage({ bucket, endpoint, sseHeaders,
    async send(request) {
      const url = new URL(request.url);
      assert.equal(url.origin, endpoint);
      const [owner, ...segments] = url.pathname.slice(1).split('/').map(decodeURIComponent);
      assert.equal(owner, bucket);
      const key = segments.join('/');
      const sse = request.headers.get('x-amz-server-side-encryption-customer-key');
      const previous = objects.get(key), etag = etags.get(key) ?? '"initial-opaque-revision"';
      trace.push({ key, method: request.method, sse, ifMatch: request.headers.get('if-match'), ifAbsent: request.headers.get('if-none-match') });
      if (encrypted && emptyDefaultEncrypted && request.method === 'GET' && previous?.byteLength === 0 && key.startsWith(prefix)) {
        return sse ? new Response(null, { status: 400 }) : new Response(previous, { headers: { etag, 'content-length': '0' } });
      }
      assert.equal(sse, encrypted ? 'synthetic-fixture-key' : null);
      if (request.method === 'GET') return previous === undefined ? new Response(null, { status: 404 })
        : new Response(previous, { headers: { etag } });
      assert.equal(request.method, 'PUT');
      const ifMatch = request.headers.get('if-match'), ifAbsent = request.headers.get('if-none-match');
      if ((previous !== undefined && ifAbsent === '*') || (ifMatch && (previous === undefined || ifMatch !== etag))) return new Response(null, { status: 412 });
      const data = Buffer.from(await request.arrayBuffer());
      objects.set(key, data);
      etags.set(key, encrypted ? '"opaque-sse-write"' : `"${createHash('md5').update(data).digest('hex')}"`);
      return new Response(null, { status: 200 });
    },
  });
  const run = (id = source, infer = () => bytes(all('Published fact.'))) => runHermesShutdownMerge({
    source: id, attemptId: 'test-attempt', deadline: Date.now() + 10_000, signal: new AbortController().signal, storage, infer,
  });
  return { objects, source, storage, run, trace };
}

for (const encrypted of [false, true]) {
  test(`REQ-MEM-044: conditionally publishes a complete R2 revision (${encrypted ? 'SSE-C headers' : 'plain'})`, async () => {
    const f = fixture({ encrypted });
    assert.equal((await f.run()).status, 'merged');
    const commit = JSON.parse(f.objects.get(pointer).toString());
    const writes = f.trace.filter(event => event.method === 'PUT');
    assert.equal(writes.length, 5);
    assert.ok(writes.slice(0, 4).every(event => event.key.startsWith(`${root}Masters/${commit.revision}/`) && event.ifAbsent === '*'));
    assert.equal(writes[4].key, pointer);
    assert.equal(writes[4].ifAbsent, '*');
    assert.equal(f.objects.get(`${root}MEMORY.md`).toString(), 'Known fact.', 'bootstrap does not rewrite old masters');
    const current = await f.storage.readCommit(new AbortController().signal);
    assert.equal(await f.storage.commitRevision(commit, '"not-current"', new AbortController().signal), false);
    assert.equal((await f.storage.readCommit(new AbortController().signal)).etag, current.etag);
  });
}

test('REQ-MEM-044: accepts a verified zero-byte default-encrypted file in an SSE-C snapshot', async () => {
  const f = fixture({ encrypted: true, emptyDefaultEncrypted: true });
  assert.equal((await f.run()).status, 'merged');
  assert.ok(f.trace.some(event => event.key === `${prefix}global/USER.md` && event.method === 'GET' && !event.sse));
  assert.ok(f.trace.filter(event => event.method === 'PUT').every(event => event.sse));
});

test('REQ-MEM-044: a reseeded baseline preserves subsequent whole-entry change detection', async () => {
  const f = fixture();
  const baselineKey = `${prefix}baseline.json`;
  const baseline = JSON.parse(f.objects.get(baselineKey).toString());
  const reseed = { owner: bucket, sessionId: session, snapshotId: 'c'.repeat(64), revision: 'previous-reseed',
    files: Object.fromEntries(files.map(file => [file, createHash('sha256').update(baseline[file]).digest('hex')])),
  };
  f.objects.set(baselineKey, Buffer.from(JSON.stringify({ ...baseline, _reseed: reseed })));
  const result = await f.run(f.source, input => {
    assert.deepEqual(input.changes['global/MEMORY.md'], ['New fact.']);
    return bytes(all('Known fact.\n§\nNew fact.'));
  });
  assert.equal(result.status, 'merged');
});

test('REQ-MEM-044: missing baseline or a different durable snapshot never reaches inference', async () => {
  const f = fixture();
  f.objects.set(`${prefix}global/MEMORY.md`, Buffer.from('A later save.'));
  const never = () => assert.fail('inference must not receive substituted inputs');
  let attempted = false;
  const infer = () => { attempted = true; return never(); };
  assert.deepEqual(await f.run(f.source, infer), { status: 'pending' });
  f.objects.delete(`${prefix}baseline.json`);
  assert.deepEqual(await f.run(f.source, infer), { status: 'pending' });
  assert.equal(attempted, false);
  assert.ok(f.trace.every(event => event.method === 'GET'));
});
