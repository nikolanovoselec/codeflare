import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { transform } from 'esbuild';

import {
  EXPECTED_PI_CAVEMAN_VERSION,
  PATCH_MARKER,
  patchPiCavemanDirectory,
  patchPiCavemanSource,
} from '../../scripts/patch-pi-caveman-tutorial-exemption.mjs';

const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__');
const pinnedArchive = join(fixturesDirectory, 'pi-caveman-1.0.8.tgz');
const pinnedIntegrity = 'sha512-N0F/Ui86dEtKzoAnRpe+9t4AXsv9cshTGBFwbDf7aiiE1C5iQ8QrZuszdc/yX9FWNUP0pzSZX/M/zWynngnGQw==';

function extractPinnedPackage() {
  const archive = readFileSync(pinnedArchive);
  assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, pinnedIntegrity);
  const packageDirectory = mkdtempSync(join(tmpdir(), 'codeflare-caveman-'));
  execFileSync('tar', ['-xzf', pinnedArchive, '-C', packageDirectory, '--strip-components=1'], { stdio: 'ignore' });
  return packageDirectory;
}

describe('Pi Caveman tutorial exemption image patch', () => {
  it('patches the locked extension once and rejects version drift', () => {
    const packageDirectory = extractPinnedPackage();
    try {
      const source = readFileSync(join(packageDirectory, 'extensions', 'caveman.ts'), 'utf8');
      const patched = patchPiCavemanSource(source);

      assert.match(patched, new RegExp(PATCH_MARKER));
      assert.equal(patchPiCavemanSource(patched), patched);
      assert.throws(
        () => patchPiCavemanDirectory('0.0.0', packageDirectory),
        /Unsupported pi-caveman version/,
      );
    } finally {
      rmSync(packageDirectory, { recursive: true, force: true });
    }
  });

  it('patches the pinned package layout and keeps its TypeScript parseable', async () => {
    const packageDirectory = extractPinnedPackage();
    try {
      const packageJson = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
      assert.equal(packageJson.version, EXPECTED_PI_CAVEMAN_VERSION);

      patchPiCavemanDirectory(packageJson.version, packageDirectory);

      const patched = readFileSync(join(packageDirectory, 'extensions', 'caveman.ts'), 'utf8');
      assert.match(patched, new RegExp(PATCH_MARKER));
      await transform(patched, { loader: 'ts' });
    } finally {
      rmSync(packageDirectory, { recursive: true, force: true });
    }
  });
});
