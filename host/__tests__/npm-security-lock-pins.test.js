import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../../scripts/apply-npm-security-lock-pins.mjs', import.meta.url));

describe('REQ-OPS-019: bounded npm security lock pins', () => {
  it('replaces every vulnerable bundled security pin and preserves unrelated packages', () => {
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
          'node_modules/vendor-7/node_modules/undici': {
            version: '7.28.0',
            resolved: 'old-7',
            integrity: 'old-7',
          },
          'node_modules/vendor-8/node_modules/undici': {
            version: '8.5.0',
            resolved: 'old-8',
            integrity: 'old-8',
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
      assert.equal(patched.version, '5.0.9');
      assert.equal(
        patched.integrity,
        'sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==',
      );
      assert.deepEqual(lock.packages['node_modules/vendor-7/node_modules/undici'], {
        version: '7.29.0',
        resolved: 'https://registry.npmjs.org/undici/-/undici-7.29.0.tgz',
        integrity: 'sha512-IDxfleLmmbSskfWSUATiN1nfn2rDuvnMOqb5CWR92iIfojA0Ud+ulOAAEQ57LPr9rWmsreUyf5lwyao+7GNNVw==',
        license: 'MIT',
        engines: { node: '>=20.18.1' },
      });
      assert.deepEqual(lock.packages['node_modules/vendor-8/node_modules/undici'], {
        version: '8.9.0',
        resolved: 'https://registry.npmjs.org/undici/-/undici-8.9.0.tgz',
        integrity: 'sha512-aWZpUj7XoGonMClx4gdDRfgBjqeA+F473aDmROQQbM9n6PRfK/u1q/a0X4wMTgcHfT8H6fpbt98PFuDUwFg2YA==',
        license: 'MIT',
        engines: { node: '>=22.19.0' },
      });
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
