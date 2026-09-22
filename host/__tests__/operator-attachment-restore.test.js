import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { restoreOperatorAttachments } from '../../scripts/restore-operator-attachments.mjs';

const bytes = Buffer.from('{"schemaVersion":1,"scope":"opaque"}');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const projection = { schemaVersion: 1, activityId: 'activity-1', files: [{ name: 'packet.json',
  mediaType: 'application/json', size: bytes.length, sha256, locator: 'locator-1' }] };

test('opaque operator attachments restore only the declared owner key beneath the fixed root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'operator-attachments-'));
  const calls = [];
  restoreOperatorAttachments(projection, { root, bucket: 'owner-bucket', rcloneConfig: '/tmp/rclone.conf',
    run: (_command, args) => {
      calls.push(args);
      assert.equal(args[1], 'r2:owner-bucket/.codeflare/operator-inputs/activity-1/locator-1');
      writeFileSync(args[2], bytes);
    } });
  assert.deepEqual(await readFile(path.join(root, 'input/packet.json')), bytes);
  assert.equal(calls.length, 1);
});

test('opaque operator attachments reject undeclared shape and integrity mismatches', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'operator-attachments-'));
  assert.throws(() => restoreOperatorAttachments({ ...projection, files: [{ ...projection.files[0], name: '../packet' }] },
    { root, bucket: 'owner-bucket', rcloneConfig: '/tmp/rclone.conf', run: () => {} }), /invalid/i);
  assert.throws(() => restoreOperatorAttachments(projection,
    { root, bucket: 'owner-bucket', rcloneConfig: '/tmp/rclone.conf',
      run: (_command, args) => writeFileSync(args[2], Buffer.from('changed')) }), /integrity/i);
});
