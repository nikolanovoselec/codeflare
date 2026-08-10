#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash, getFips } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    throw new Error(`jiti cache artifact is missing at ${artifactPath}`);
  }
  return artifactPath;
}

export function warmAndVerifyJitiEntrypoints(piBinary, cacheDirectory, sourcePaths) {
  if (!piBinary || !cacheDirectory || sourcePaths.length === 0) {
    throw new Error('Pi binary, cache directory, and at least one entrypoint are required');
  }
  const extensionArgs = sourcePaths.flatMap((sourcePath) => ['--extension', sourcePath]);
  spawnSync(
    piBinary,
    ['--no-extensions', ...extensionArgs, '-p', 'warm'],
    { encoding: 'utf8', env: process.env, timeout: 240_000 },
  );
  return sourcePaths.map((sourcePath) => verifyJitiCacheArtifact(sourcePath, cacheDirectory));
}

export function verifyPiLockstep(runtimeManifestPath, prewarmManifestPath, installedPackagePath) {
  const runtimeVersion = readJson(runtimeManifestPath).dependencies?.[PI_PACKAGE];
  const prewarmManifest = readJson(prewarmManifestPath);
  const prewarmDependencyVersion = prewarmManifest.dependencies?.[PI_PACKAGE];
  const prewarmOverrideVersion = prewarmManifest.overrides?.[PI_PACKAGE];
  if (!runtimeVersion || !prewarmDependencyVersion || !prewarmOverrideVersion) {
    throw new Error('Pi runtime and prewarm manifests must contain exact pins');
  }
  if (prewarmDependencyVersion !== runtimeVersion) {
    throw new Error(`prewarm Pi SDK dependency ${prewarmDependencyVersion} != runtime ${runtimeVersion}`);
  }
  if (prewarmOverrideVersion !== runtimeVersion) {
    throw new Error(`prewarm Pi SDK override ${prewarmOverrideVersion} != runtime ${runtimeVersion}`);
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
  } else if (args[0] === '--warm-jiti-entrypoints') {
    const [, piBinary, cacheDirectory, ...sourcePaths] = args;
    const artifacts = warmAndVerifyJitiEntrypoints(piBinary, cacheDirectory, sourcePaths);
    process.stdout.write(`${artifacts.join('\n')}\n`);
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
