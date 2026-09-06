#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash, getFips } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export async function verifyPiRuntime(packagePath) {
  const manifest = readJson(packagePath);
  if (manifest.name !== PI_PACKAGE) throw new Error('Expected the installed Pi package manifest');
  const require = createRequire(packagePath);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) require.resolve(dependency);
  const { loadPhoton } = await import(pathToFileURL(join(dirname(packagePath), 'dist/utils/photon.js')).href);
  const photon = await loadPhoton();
  if (!photon) throw new Error('Pi image dependency could not be loaded');
  const image = new photon.PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1);
  let bytes;
  try { bytes = image.get_bytes(); } finally { image.free(); }
  const { processImage } = await import(pathToFileURL(join(dirname(packagePath), 'dist/utils/image-process.js')).href);
  const result = await processImage(bytes, 'image/png');
  if (!result.ok) throw new Error(`Pi image processing failed: ${result.message}`);
}

export function resetRuntimeJitiCache(runtimeRoot) {
  if (!runtimeRoot || runtimeRoot === '/') throw new Error('A dedicated Codeflare runtime root is required');
  const cache = join(runtimeRoot, 'pi-tmp/jiti');
  // rmSync unlinks symlinks; it never traverses into the image-owned cache target.
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
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
  const artifactPaths = sourcePaths.map((sourcePath) => resolveJitiCachePath(sourcePath, cacheDirectory));
  for (const artifactPath of artifactPaths) rmSync(artifactPath, { force: true, recursive: true });
  const extensionArgs = sourcePaths.flatMap((sourcePath) => ['--extension', sourcePath]);
  const result = spawnSync(
    piBinary,
    ['--no-extensions', ...extensionArgs, '--list-models'],
    { encoding: 'utf8', env: process.env, timeout: 240_000 },
  );
  if (result.error) throw new Error(`Pi JITI warm failed: ${result.error.message}`);
  if (result.signal) throw new Error(`Pi JITI warm terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`Pi JITI warm exited ${result.status}`);
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
  if (args[0] === '--verify-runtime') {
    await verifyPiRuntime(args[1]);
  } else if (args[0] === '--reset-runtime-jiti') {
    resetRuntimeJitiCache(args[1]);
  } else if (args[0] === '--jiti-cache-path' || args[0] === '--verify-jiti-cache') {
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
