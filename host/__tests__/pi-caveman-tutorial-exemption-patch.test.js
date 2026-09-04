import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureSource = String.raw`const SAFETY = \
Auto-clarity: drop caveman for security warnings, irreversible action confirmations, \
or when user is confused. Resume after.
Boundaries: write normal code. Only compress explanations. "stop caveman" or "normal mode" reverts.\`;
`;

describe('Pi Caveman tutorial exemption image patch', () => {
  it('patches the locked extension once and rejects version drift', () => {
    const patched = patchPiCavemanSource(fixtureSource);

    assert.match(patched, new RegExp(PATCH_MARKER));
    assert.equal(patchPiCavemanSource(patched), patched);
    assert.throws(
      () => patchPiCavemanDirectory('0.0.0', '/unused'),
      /Unsupported pi-caveman version/,
    );
  });

  it('patches a package copy and keeps the transformed TypeScript parseable', async () => {
    const packageDirectory = mkdtempSync(join(tmpdir(), 'codeflare-caveman-'));
    const sourcePath = join(packageDirectory, 'extensions', 'caveman.ts');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, fixtureSource);

    patchPiCavemanDirectory(EXPECTED_PI_CAVEMAN_VERSION, packageDirectory);

    const patched = readFileSync(sourcePath, 'utf8');
    assert.match(patched, new RegExp(PATCH_MARKER));
    await transform(patched, { loader: 'ts' });
  });

  it('wires the version-locked transform into image construction', () => {
    const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /patch-pi-caveman-tutorial-exemption\.mjs/);
    assert.match(dockerfile, /node_modules\/pi-caveman/);
  });
});
