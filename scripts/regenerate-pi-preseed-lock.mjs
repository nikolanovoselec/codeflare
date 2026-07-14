#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectory = process.argv[2]
  ? resolve(process.argv[2])
  : join(repositoryRoot, 'preseed/agents/pi');
const packageManifest = join(packageDirectory, 'package.json');

if (!existsSync(packageManifest)) {
  process.stderr.write(`Pi preseed package manifest not found: ${packageManifest}\n`);
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
  process.stderr.write(`Failed to regenerate the Pi preseed lockfile: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
