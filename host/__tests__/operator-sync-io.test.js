/** REQ-OPERATOR-005: concrete restricted local/R2 I/O adapters. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FileOperatorSyncStore, OwnedOperatorSyncFiles, RcloneOperatorSyncUploader } from '../dist/operator-sync-io.js';

const receipt = { schemaVersion: 1, operationId: 'sync-1', requestDigest: 'a'.repeat(64), status: 'accepted', manifestDigest: null, files: [] };

test('REQ-OPERATOR-005: local adapter reads only exact regular non-symlink files beneath the owned root', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'operator-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'reports'));
  await writeFile(path.join(root, 'reports/result.txt'), 'result');
  const files = new OwnedOperatorSyncFiles(root);
  assert.equal(new TextDecoder().decode(await files.read('reports/result.txt', 6)), 'result');
  await assert.rejects(files.read('../escape', 1), /invalid.*path/i);
  await assert.rejects(files.read('reports/result.txt', 5), /size/i);
  await symlink(path.join(root, 'reports/result.txt'), path.join(root, 'reports/link'));
  await assert.rejects(files.read('reports/link', 6), /symlink|regular/i);
});

test('REQ-OPERATOR-005: receipt store atomically persists mode-0600 bounded per-operation state', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'operator-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileOperatorSyncStore(root);
  assert.equal(await store.load('sync-1'), null);
  await store.save(receipt);
  assert.deepEqual(await store.load('sync-1'), receipt);
  const file = path.join(root, 'sync-1.json');
  assert.equal((await stat(file)).mode & 0o077, 0);
  await chmod(file, 0o600);
  await writeFile(file, 'x'.repeat(257 * 1024));
  await assert.rejects(store.load('sync-1'), /large/i);
  await assert.rejects(store.load('../escape'), /operation/i);
});

test('REQ-OPERATOR-005: rclone adapter uses fixed rcat destination and stdin without a shell', async () => {
  const calls = [];
  const uploader = new RcloneOperatorSyncUploader({ bucket: 'owner-bucket', prefix: 'Remote Reviews/activity/session/sync-1/',
    configFile: '/run/codeflare/rclone.conf', run: async (command, args, bytes) => { calls.push({ command, args, bytes: Buffer.from(bytes) }); return 0; } });
  await uploader.put('Remote Reviews/activity/session/sync-1/reports/result.txt', new TextEncoder().encode('result'));
  assert.deepEqual(calls, [{ command: 'rclone', args: ['rcat', 'r2:owner-bucket/Remote Reviews/activity/session/sync-1/reports/result.txt',
    '--config', '/run/codeflare/rclone.conf', '--size', '6'], bytes: Buffer.from('result') }]);
  await assert.rejects(uploader.put('Remote Reviews/other/result.txt', new Uint8Array()), /scope/i);
  const failed = new RcloneOperatorSyncUploader({ bucket: 'owner-bucket', prefix: 'Remote Reviews/activity/session/sync-1/',
    configFile: '/run/codeflare/rclone.conf', run: async () => 7 });
  await assert.rejects(failed.put('Remote Reviews/activity/session/sync-1/result.txt', new Uint8Array()), /upload failed/i);
});
