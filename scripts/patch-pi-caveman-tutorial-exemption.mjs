#!/usr/bin/env node
// Applies Codeflare's narrow tutorial-style compatibility patch to the exact
// locked pi-caveman release. Caveman stays Lite for ordinary responses; its
// own auto-clarity boundary yields to Codeflare capability/onboarding tutorials.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_PI_CAVEMAN_VERSION = '1.0.8';
export const PATCH_MARKER = 'CODEFLARE_CAVEMAN_TUTORIAL_EXEMPTION';

const SOURCE = [
  'Auto-clarity: drop caveman for security warnings, irreversible action confirmations, ' + '\\',
  'or when user is confused. Resume after.',
].join('\n');

const PATCH = [
  `Auto-clarity: drop caveman for Codeflare capability/onboarding tutorials, numbered tutorial replies, \\`,
  'security warnings, irreversible action confirmations, or when user is confused. Resume after.',
].join('\n');

export function patchPiCavemanSource(source) {
  if (source.includes(PATCH_MARKER)) return source;
  const count = source.split(SOURCE).length - 1;
  if (count !== 1) {
    throw new Error(`pi-caveman tutorial exemption anchor count ${count}; expected 1`);
  }
  const safetyDeclaration = 'const SAFETY =';
  const declarationCount = source.split(safetyDeclaration).length - 1;
  if (declarationCount !== 1) {
    throw new Error(`pi-caveman SAFETY declaration count ${declarationCount}; expected 1`);
  }
  return source
    .replace(safetyDeclaration, `// ${PATCH_MARKER}\n${safetyDeclaration}`)
    .replace(SOURCE, PATCH);
}

export function patchPiCavemanDirectory(version, packageDirectory) {
  if (version !== EXPECTED_PI_CAVEMAN_VERSION) {
    throw new Error(`Unsupported pi-caveman version ${version}; expected ${EXPECTED_PI_CAVEMAN_VERSION}`);
  }
  const sourcePath = join(packageDirectory, 'extensions', 'caveman.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const patched = patchPiCavemanSource(source);
  if (patched !== source) writeFileSync(sourcePath, patched, 'utf8');
}

function main() {
  const [version, packageDirectory] = process.argv.slice(2);
  if (!version || !packageDirectory) {
    throw new Error('usage: patch-pi-caveman-tutorial-exemption.mjs <version> <package-directory>');
  }
  patchPiCavemanDirectory(version, packageDirectory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
