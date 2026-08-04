#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requestedDirectory = process.argv[2];
if (!requestedDirectory) {
  process.stderr.write('Usage: regenerate-npm-package-lock.mjs <package-directory>\n');
  process.exit(1);
}
const packageDirectory = resolve(requestedDirectory);
const packageManifest = join(packageDirectory, 'package.json');

if (!existsSync(packageManifest)) {
  process.stderr.write(`Npm package manifest not found: ${packageManifest}\n`);
  process.exit(1);
}

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
  {
    cwd: packageDirectory,
    stdio: 'inherit',
  },
);

if (result.error) {
  process.stderr.write(`Failed to regenerate npm package lock: ${result.error.message}\n`);
  process.exit(1);
}

if (result.status !== 0) process.exit(result.status ?? 1);

const securityPins = spawnSync(
  process.execPath,
  [join(repositoryRoot, 'scripts/apply-npm-security-lock-pins.mjs'), join(packageDirectory, 'package-lock.json')],
  { stdio: 'inherit' },
);
if (securityPins.error) {
  process.stderr.write(`Failed to apply npm security lock pins: ${securityPins.error.message}\n`);
  process.exit(1);
}
process.exit(securityPins.status ?? 1);
