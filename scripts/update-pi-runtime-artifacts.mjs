#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { updateNpmToolManifests } from './update-npm-tool-manifests.mjs';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

function runChecked(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? 'without status'}`);
}

export function updatePiRuntimeArtifacts(repositoryRoot, currentVersion, nextVersion, options = {}) {
  const { npmCommand = 'npm' } = options;
  const toolsDirectory = resolve(repositoryRoot, 'preseed/npm-tools');
  const toolsManifest = resolve(toolsDirectory, 'package.json');
  const prewarmDirectory = resolve(repositoryRoot, 'preseed/agents/pi');
  const prewarmManifest = resolve(prewarmDirectory, 'package.json');
  const regenerateLock = resolve(repositoryRoot, 'scripts/regenerate-npm-package-lock.mjs');

  updateNpmToolManifests(toolsManifest, PI_PACKAGE, currentVersion, nextVersion, prewarmManifest);
  runChecked(process.execPath, [regenerateLock, toolsDirectory], { cwd: repositoryRoot });
  runChecked(process.execPath, [regenerateLock, prewarmDirectory], { cwd: repositoryRoot });
  runChecked(npmCommand, ['ci', '--no-audit', '--no-fund', '--silent'], { cwd: repositoryRoot });
  runChecked(npmCommand, ['run', 'generate:agent-seed'], { cwd: repositoryRoot });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [currentVersion, nextVersion, root = process.cwd()] = process.argv.slice(2);
    if (!currentVersion || !nextVersion) {
      throw new Error('usage: update-pi-runtime-artifacts.mjs <current> <next> [repository-root]');
    }
    updatePiRuntimeArtifacts(resolve(root), currentVersion, nextVersion);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
