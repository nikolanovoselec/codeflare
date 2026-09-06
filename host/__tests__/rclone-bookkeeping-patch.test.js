import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const patch = join(root, 'scripts/patch-rclone-bisync.py');

describe('rclone bookkeeping compatibility gate', () => {
  it('requires the Docker rclone pin to match the reviewed patch version', () => {
    const docker = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const version = /VERSION = "([^"]+)"/.exec(readFileSync(patch, 'utf8'))?.[1];
    assert.ok(version);
    const pins = [...docker.matchAll(/rclone\/rclone\/tar\.gz\/refs\/tags\/v([\d.]+)/g)];
    assert.equal(pins.length, 1);
    assert.equal(pins[0][1], version, 'Revalidate the bookkeeping patch before changing the rclone pin');
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

  it('rejects incompatible source without writing a partial patch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rclone-source-'));
    try {
      const result = spawnSync('python3', [patch, directory, '1.73.5'], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /No such file/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
