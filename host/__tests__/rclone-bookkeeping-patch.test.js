import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const patch = join(root, 'scripts/patch-rclone-bisync.py');

describe('rclone bookkeeping compatibility gate', () => {
  it('rejects an upstream version bump even when the caller supplies the old version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rclone-version-'));
    try {
      writeFileSync(join(directory, 'VERSION'), 'v99.0.0\n');
      const result = spawnSync('python3', [patch, directory, '1.73.5'], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unreviewed upstream version/);
      assert.equal(readFileSync(join(directory, 'VERSION'), 'utf8'), 'v99.0.0\n');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects an unreviewed version before touching source', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rclone-guard-'));
    try {
      const sentinel = join(directory, 'sentinel');
      writeFileSync(sentinel, 'preserve');
      const result = spawnSync('python3', [patch, directory, '99.0.0'], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not approved/);
      assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('leaves a patchable first file untouched when a later source anchor is incompatible', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rclone-source-'));
    try {
      mkdirSync(join(directory, 'backend/s3'), { recursive: true });
      mkdirSync(join(directory, 'fs/operations'), { recursive: true });
      writeFileSync(join(directory, 'VERSION'), 'v1.73.5\n');
      const first = '\to.setMetaData(head)\n\n\t// Check multipart upload ETag if required\n';
      const later = 'incompatible logger source\n';
      writeFileSync(join(directory, 'backend/s3/s3.go'), first);
      writeFileSync(join(directory, 'fs/operations/logger.go'), later);
      const result = spawnSync('python3', [patch, directory, '1.73.5'], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unrecognized.*fs\/operations\/logger.go/);
      assert.equal(readFileSync(join(directory, 'backend/s3/s3.go'), 'utf8'), first);
      assert.equal(readFileSync(join(directory, 'fs/operations/logger.go'), 'utf8'), later);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
