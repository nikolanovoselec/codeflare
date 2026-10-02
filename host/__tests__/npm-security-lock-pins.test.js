import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../../scripts/apply-npm-security-lock-pins.mjs', import.meta.url));

describe('REQ-OPS-003 AC5: bounded npm security lock pins', () => {
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
            version: '7.29.0',
            resolved: 'old-7',
            integrity: 'old-7',
          },
          'node_modules/vendor-8/node_modules/undici': {
            version: '8.9.0',
            resolved: 'old-8',
            integrity: 'old-8',
            dev: true,
          },
          'node_modules/vendor/node_modules/ip-address': {
            version: '10.4.0',
            resolved: 'old-ip',
            integrity: 'old-ip',
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
          'node_modules/vendor/node_modules/@earendil-works/pi-client': {
            version: '0.84.1',
            resolved: 'https://registry.npmjs.org/@earendil-works/pi-client/-/pi-client-0.84.1.tgz',
          },
          'node_modules/vendor/node_modules/@earendil-works/pi-protocol': {
            version: '0.84.1',
            resolved: 'https://registry.npmjs.org/@earendil-works/pi-protocol/-/pi-protocol-0.84.1.tgz',
          },
          'node_modules/unrelated': { version: '1.2.3', integrity: 'unchanged' },
        },
      }));

      const result = spawnSync(process.execPath, [script, lockPath], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);

      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      const patched = lock.packages['node_modules/vendor/node_modules/brace-expansion'];
      assert.equal(patched.version, '5.0.12');
      assert.equal(
        patched.integrity,
        'sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==',
      );
      assert.deepEqual(lock.packages['node_modules/vendor-7/node_modules/undici'], {
        version: '7.30.0',
        resolved: 'https://registry.npmjs.org/undici/-/undici-7.30.0.tgz',
        integrity: 'sha512-dkrQXeHSaoamnItlYbmzG0wFYrM0ZwDxCIg0A7aKjTyyhh9svRzCNFEzV+Vm05/yehjCzjDZ31KXfGEjYSztDQ==',
        license: 'MIT',
        engines: { node: '>=20.18.1' },
      });
      assert.deepEqual(lock.packages['node_modules/vendor-8/node_modules/undici'], {
        version: '8.11.2',
        resolved: 'https://registry.npmjs.org/undici/-/undici-8.11.2.tgz',
        integrity: 'sha512-u4UB2/IrKdU6lFxumHmmo1a3fCQO5tzQllRorfoRS63txhrB7xTpSn1PftwC4qEHkOaqP95fCWW4lJzwErwzhQ==',
        license: 'MIT',
        engines: { node: '>=22.19.0' },
        dev: true,
      });
      assert.deepEqual(lock.packages['node_modules/vendor/node_modules/ip-address'], {
        version: '10.7.3',
        resolved: 'https://registry.npmjs.org/ip-address/-/ip-address-10.7.3.tgz',
        integrity: 'sha512-A1kdq/tSb5QjvKvAMgIoEvDBIgL7qaqVP/jkvSwYYRZ9iEzvPpopxp2wQfu3SuZRHtpHNxMn8Fs0bS+gf5Xmwg==',
        license: 'MIT',
        engines: { node: '>= 12' },
      });
      assert.equal(
        lock.packages['node_modules/vendor/node_modules/scoped'].integrity,
        'sha512-canonical',
        'nested shrinkwrap entries inherit committed integrity from the same locked package and version',
      );
      assert.equal(
        lock.packages['node_modules/vendor/node_modules/@earendil-works/pi-client'].integrity,
        'sha512-/V5hGHE4Zq+jG0GtwIB9PyBUOGd6gBLZ7lkQYFKchKnxYHeH3rmWC5xw4kpnZKKBuBuFTdLVbU9vEjlAGMMb2A==',
      );
      assert.equal(
        lock.packages['node_modules/vendor/node_modules/@earendil-works/pi-protocol'].integrity,
        'sha512-Ox1pciyeSPGEEUcxvR0/dJcrY7C6hrEGA8y71rOsvSIUlXN1Cbp/be/eoL71OGDBk5O97TeQPfWN6Ju/2Ehjww==',
      );
      assert.deepEqual(lock.packages['node_modules/unrelated'], { version: '1.2.3', integrity: 'unchanged' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function assertPatchedTransportLock(relativePath) {
    const lock = JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
    const transports = Object.entries(lock.packages).filter(([path]) =>
      path === 'node_modules/undici' || path.endsWith('/node_modules/undici'));
    assert.ok(transports.length > 0, `${relativePath} must include the audited transport`);
    for (const [path, metadata] of transports) {
      const [major, minor, patch] = metadata.version.split('.').map(Number);
      assert.ok(major > 8 || (major === 8 && (minor > 10 || (minor === 10 && patch >= 2))),
        `${relativePath}:${path} must include the 8.10.2 security fix`);
      assert.equal(metadata.dev, true, `${relativePath}:${path} remains a development-only dependency`);
    }
  }

  it('keeps host transport lock above the patched GHSA-vp8m-p9jh-q5pm floor', () => {
    assertPatchedTransportLock('../package-lock.json');
  });

  it('keeps UI transport lock above the patched GHSA-vp8m-p9jh-q5pm floor', () => {
    assertPatchedTransportLock('../../web-ui/package-lock.json');
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
