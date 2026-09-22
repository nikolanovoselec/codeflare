/** REQ-OPERATOR-023: concrete restricted local/R2 I/O adapters. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FileOperatorSyncStore, OwnedOperatorSyncFiles, RcloneOperatorSyncUploader } from '../dist/operator-sync-io.js';

const receipt = { schemaVersion: 1, operationId: 'sync-1', requestDigest: 'a'.repeat(64), status: 'accepted', manifestDigest: null, files: [] };

test('REQ-OPERATOR-023: local adapter reads only exact regular non-symlink files beneath the owned root', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'operator-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'reports'));
  await writeFile(path.join(root, 'reports/result.txt'), 'result');
  const files = new OwnedOperatorSyncFiles(root);
  assert.equal(new TextDecoder().decode(await files.read('reports/result.txt', 6)), 'result');
  assert.deepEqual(await files.inspect(['reports/result.txt']), [{ path: 'reports/result.txt', size: 6,
    sha256: createHash('sha256').update('result').digest('hex') }]);
  await assert.rejects(files.read('../escape', 1), /invalid.*path/i);
  await assert.rejects(files.read('reports/result.txt', 5), /size/i);
  await symlink(path.join(root, 'reports/result.txt'), path.join(root, 'reports/link'));
  await assert.rejects(files.read('reports/link', 6), /symlink|regular/i);
});

test('REQ-OPERATOR-023: opened output remains beneath the owned root after an intermediate-directory swap', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'operator-output-race-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'operator-output-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(path.join(root, 'reports'));
  await writeFile(path.join(root, 'reports/result.txt'), 'inside');
  await writeFile(path.join(outside, 'result.txt'), 'secret');
  let swapped = false;
  const files = new OwnedOperatorSyncFiles(root, async (file, flags) => {
    if (!swapped) {
      swapped = true;
      await rename(path.join(root, 'reports'), path.join(root, 'reports-safe'));
      await symlink(outside, path.join(root, 'reports'));
    }
    return open(file, flags);
  });
  await assert.rejects(files.read('reports/result.txt', 6), /owned output path/i);
});

test('REQ-OPERATOR-023: receipt store atomically persists mode-0600 bounded per-operation state', async t => {
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

test('REQ-OPERATOR-023: rclone adapter uses fixed rcat destination and stdin without a shell', async () => {
  const calls = [];
  const uploader = new RcloneOperatorSyncUploader({ bucket: 'owner-bucket', prefixes: ['Operators/', '.codeflare/operators/activity/'],
    configFile: '/run/codeflare/rclone.conf', run: async (command, args, bytes) => { calls.push({ command, args, bytes: Buffer.from(bytes) }); return 0; } });
  await uploader.put('sync-1', 'Operators/reports/result.txt', new TextEncoder().encode('result'));
  assert.deepEqual(calls, [{ command: 'rclone', args: ['rcat', 'r2:owner-bucket/Operators/reports/result.txt',
    '--config', '/run/codeflare/rclone.conf', '--size', '6', '--header',
    'X-Codeflare-Operator-Sync-Operation: sync-1', '--s3-no-head'], bytes: Buffer.from('result') }]);
  await assert.rejects(uploader.put('sync-1', 'Other/result.txt', new Uint8Array()), /scope/i);
  await assert.rejects(uploader.put('../escape', 'Operators/result.txt', new Uint8Array()), /scope/i);
  const failed = new RcloneOperatorSyncUploader({ bucket: 'owner-bucket', prefixes: ['Operators/', '.codeflare/operators/activity/'],
    configFile: '/run/codeflare/rclone.conf', run: async () => 7 });
  await assert.rejects(failed.put('sync-1', '.codeflare/operators/activity/sync-1/manifest.json', new Uint8Array()), /upload failed/i);
});
