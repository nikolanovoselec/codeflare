#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_LIBRARIES = Object.freeze([
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertVersion(actual, expected, label) {
  if (actual !== expected) throw new Error(`expected ${label} ${expected}, found ${actual ?? 'missing'}`);
}

export function updateNpmToolManifests(manifestPath, packageName, currentVersion, nextVersion, piManifestPath) {
  const manifest = readJson(manifestPath);
  assertVersion(manifest.dependencies?.[packageName], currentVersion, packageName);

  let piManifest;
  if (packageName === PI_PACKAGE) {
    if (!piManifestPath) throw new Error('Pi runtime bumps require the prewarm manifest path');
    piManifest = readJson(piManifestPath);
    assertVersion(piManifest.dependencies?.[PI_PACKAGE], currentVersion, `prewarm dependency ${PI_PACKAGE}`);
    assertVersion(piManifest.overrides?.[PI_PACKAGE], currentVersion, `prewarm override ${PI_PACKAGE}`);
    for (const dependency of PI_LIBRARIES) {
      assertVersion(manifest.devDependencies?.[dependency], currentVersion, dependency);
      assertVersion(piManifest.devDependencies?.[dependency], currentVersion, `prewarm ${dependency}`);
    }
  }

  const nextDevDependencies = packageName === PI_PACKAGE
    ? Object.fromEntries(
      Object.entries(manifest.devDependencies).map(([dependency, version]) => [
        dependency,
        PI_LIBRARIES.includes(dependency) ? nextVersion : version,
      ]),
    )
    : manifest.devDependencies;
  const nextManifest = {
    ...manifest,
    dependencies: { ...manifest.dependencies, [packageName]: nextVersion },
    ...(nextDevDependencies ? { devDependencies: nextDevDependencies } : {}),
  };
  if (packageName === PI_PACKAGE) {
    const nextPiManifest = {
      ...piManifest,
      dependencies: { ...piManifest.dependencies, [PI_PACKAGE]: nextVersion },
      overrides: { ...piManifest.overrides, [PI_PACKAGE]: nextVersion },
      devDependencies: Object.fromEntries(
        Object.entries(piManifest.devDependencies).map(([dependency, version]) => [
          dependency,
          PI_LIBRARIES.includes(dependency) ? nextVersion : version,
        ]),
      ),
    };
    writeFileSync(piManifestPath, `${JSON.stringify(nextPiManifest, null, 2)}\n`);
  }
  writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [manifestPath, packageName, currentVersion, nextVersion, piManifestPath] = process.argv.slice(2);
    if (!manifestPath || !packageName || !currentVersion || !nextVersion) {
      throw new Error('usage: update-npm-tool-manifests.mjs <manifest> <package> <current> <next> [pi-prewarm-manifest]');
    }
    updateNpmToolManifests(manifestPath, packageName, currentVersion, nextVersion, piManifestPath);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
