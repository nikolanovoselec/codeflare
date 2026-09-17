/** REQ-OPERATOR-023: trusted startup composition of exact local/scope/rclone sync adapters. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createOperatorSyncService } from '../dist/operator-sync-service.js';

const sha = value => createHash('sha256').update(value).digest('hex');

test('REQ-OPERATOR-023: trusted config composes an exact upload with durable receipt', async t => {
  const allowedRoot = await mkdtemp(path.join(tmpdir(), 'operator-sync-service-'));
  t.after(() => rm(allowedRoot, { recursive: true, force: true }));
  const root = path.join(allowedRoot, 'Operators');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'report.txt'), 'result');
  const calls = [];
  const serializedConfig = JSON.stringify({ schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1',
    policyDigest: 'b'.repeat(64), root, filePrefix: 'Operators/',
    manifestPrefix: '.codeflare/operators/activity-1/', deadline: Date.now() + 60_000 });
  const controller = createOperatorSyncService({ serializedConfig, allowedRoot, outputRoot: root, bucket: 'owner-bucket',
    rcloneConfig: '/run/codeflare/rclone.conf', run: async (command, args, bytes) => { calls.push([command, args, Buffer.from(bytes)]); return 0; } });
  assert.ok(controller);
  const request = { operationId: 'sync-1', requestDigest: 'a'.repeat(64),
    files: [{ path: 'report.txt', size: 6, sha256: sha('result') }] };
  const response = await controller.handle({ method: 'POST', pathname: '/internal/bisync-trigger',
    body: new TextEncoder().encode(JSON.stringify(request)) });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).status, 'uploaded');
  assert.deepEqual(calls.map(([, args]) => args[1]), [
    'r2:owner-bucket/Operators/report.txt',
    'r2:owner-bucket/.codeflare/operators/activity-1/sync-1/manifest.json',
  ]);
  const persisted = JSON.parse(await readFile(path.join(allowedRoot, 'activity-1/.codeflare/sync-receipts/sync-1.json'), 'utf8'));
  assert.equal(persisted.status, 'uploaded');
});

test('REQ-OPERATOR-023: absent config preserves ordinary host and malformed/escaping config fails closed', () => {
  assert.equal(createOperatorSyncService({ allowedRoot: '/owned', outputRoot: '/home/user/Operators', rcloneConfig: '/run/rclone.conf' }), undefined);
  assert.throws(() => createOperatorSyncService({ serializedConfig: '{', allowedRoot: '/owned', outputRoot: '/home/user/Operators', bucket: 'owner',
    rcloneConfig: '/run/rclone.conf' }), /configuration/i);
  const escaping = JSON.stringify({ schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1',
    policyDigest: 'b'.repeat(64), root: '/other/output', filePrefix: 'Operators/',
    manifestPrefix: '.codeflare/operators/activity-1/', deadline: Date.now() + 60_000 });
  assert.throws(() => createOperatorSyncService({ serializedConfig: escaping, allowedRoot: '/owned', outputRoot: '/home/user/Operators', bucket: 'owner',
    rcloneConfig: '/run/rclone.conf' }), /configuration/i);
});
