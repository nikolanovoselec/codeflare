import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../../scripts/apply-npm-security-lock-pins.mjs', import.meta.url));

describe('REQ-OPS-019: bounded npm security lock pins', () => {
  it('replaces every vulnerable bundled brace-expansion entry and preserves unrelated packages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-security-lock-'));
    const lockPath = join(directory, 'package-lock.json');

    try {
      writeFileSync(lockPath, JSON.stringify({
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture' },
          'node_modules/vendor/node_modules/brace-expansion': {
            version: '5.0.7',
            resolved: 'old',
            integrity: 'old',
            dependencies: { 'balanced-match': '^4.0.2' },
          },
          'node_modules/scoped': {
            version: '2.0.0',
            resolved: 'https://registry.example/scoped-2.0.0.tgz',
            integrity: 'sha512-canonical',
          },
          'node_modules/vendor/node_modules/scoped': {
            version: '2.0.0',
            resolved: 'https://registry.example/scoped-2.0.0.tgz',
          },
          'node_modules/unrelated': { version: '1.2.3', integrity: 'unchanged' },
        },
      }));

      const result = spawnSync(process.execPath, [script, lockPath], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);

      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      const patched = lock.packages['node_modules/vendor/node_modules/brace-expansion'];
      assert.equal(patched.version, '5.0.8');
      assert.equal(
        patched.integrity,
        'sha512-JZyDyq3D4AUifKTPOB7DELf6XsB3WdPuNxCtob1vFXPsSXhdAiHBWJ/tJ8HAc9aH84BK+5JFZLNkJKx3G9kzQg==',
      );
      assert.equal(
        lock.packages['node_modules/vendor/node_modules/scoped'].integrity,
        'sha512-canonical',
        'nested shrinkwrap entries inherit committed integrity from the same locked package and version',
      );
      assert.deepEqual(lock.packages['node_modules/unrelated'], { version: '1.2.3', integrity: 'unchanged' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed for malformed lockfiles', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-security-lock-'));
    const lockPath = join(directory, 'package-lock.json');

    try {
      writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3 }));
      const result = spawnSync(process.execPath, [script, lockPath], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /packages object/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
