#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function verifyPiLockstep(runtimeManifestPath, prewarmManifestPath, installedPackagePath) {
  const runtimeVersion = readJson(runtimeManifestPath).dependencies?.[PI_PACKAGE];
  const prewarmVersion = readJson(prewarmManifestPath).overrides?.[PI_PACKAGE];
  if (!runtimeVersion || !prewarmVersion) throw new Error('Pi runtime and prewarm manifests must contain exact pins');
  if (prewarmVersion !== runtimeVersion) {
    throw new Error(`prewarm Pi SDK ${prewarmVersion} != runtime ${runtimeVersion}`);
  }

  if (installedPackagePath) {
    const installedVersion = readJson(installedPackagePath).version;
    if (installedVersion !== runtimeVersion) {
      throw new Error(`installed prewarm Pi SDK ${installedVersion ?? 'missing'} != runtime ${runtimeVersion}`);
    }
  }
}

try {
  const [runtimeManifestPath, prewarmManifestPath, installedPackagePath] = process.argv.slice(2);
  if (!runtimeManifestPath || !prewarmManifestPath) {
    throw new Error('usage: verify-pi-lockstep.mjs <runtime-manifest> <prewarm-manifest> [installed-package]');
  }
  verifyPiLockstep(runtimeManifestPath, prewarmManifestPath, installedPackagePath);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
