import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verifier = join(root, 'scripts/ci/verify-herdr-version.mjs');
const temporaryDirectories = [];

function verify(version, output) {
  const directory = mkdtempSync(join(tmpdir(), 'codeflare-herdr-version-'));
  temporaryDirectories.push(directory);
  const provenance = join(directory, 'provenance.json');
  writeFileSync(provenance, JSON.stringify({ version }));
  return spawnSync(process.execPath, [verifier, provenance, output], { encoding: 'utf8' });
}

describe('Herdr packaged version verification', () => {
  afterEach(() => {
    while (temporaryDirectories.length) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  });

  it('REQ-OPS-055: accepts the exact version recorded in provenance', () => {
    assert.equal(verify('0.8.2', 'herdr 0.8.2').status, 0);
  });

  it('REQ-OPS-055: rejects output that merely contains the provenance version', () => {
    assert.notEqual(verify('0.8.2', 'herdr 10.8.20').status, 0);
  });
});
