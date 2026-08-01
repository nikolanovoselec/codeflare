#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash, getFips } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function resolveJitiCachePath(sourcePath, cacheDirectory) {
  const realSourcePath = realpathSync(sourcePath);
  const stem = `${basename(dirname(realSourcePath))}-${basename(realSourcePath, extname(realSourcePath))}`;
  const algorithm = getFips?.() ? 'sha256' : 'md5';
  const pathHash = createHash(algorithm).update(realSourcePath).digest('hex').slice(0, 8);
  return join(cacheDirectory, `${stem}.${pathHash}.mjs`);
}

export function verifyJitiCacheArtifact(sourcePath, cacheDirectory) {
  const artifactPath = resolveJitiCachePath(sourcePath, cacheDirectory);
  if (!existsSync(artifactPath)) throw new Error(`jiti cache artifact is missing at ${artifactPath}`);
  return artifactPath;
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
  const args = process.argv.slice(2);
  if (args[0] === '--jiti-cache-path' || args[0] === '--verify-jiti-cache') {
    const [command, sourcePath, cacheDirectory] = args;
    if (!sourcePath || !cacheDirectory) {
      throw new Error(`usage: verify-pi-lockstep.mjs ${command} <source> <cache-directory>`);
    }
    const artifactPath = command === '--verify-jiti-cache'
      ? verifyJitiCacheArtifact(sourcePath, cacheDirectory)
      : resolveJitiCachePath(sourcePath, cacheDirectory);
    process.stdout.write(`${artifactPath}\n`);
  } else {
    const [runtimeManifestPath, prewarmManifestPath, installedPackagePath] = args;
    if (!runtimeManifestPath || !prewarmManifestPath) {
      throw new Error('usage: verify-pi-lockstep.mjs <runtime-manifest> <prewarm-manifest> [installed-package]');
    }
    verifyPiLockstep(runtimeManifestPath, prewarmManifestPath, installedPackagePath);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
