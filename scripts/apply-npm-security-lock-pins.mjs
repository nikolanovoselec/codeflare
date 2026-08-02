#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BRACE_EXPANSION_5_0_8 = Object.freeze({
  version: '5.0.8',
  resolved: 'https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.8.tgz',
  integrity: 'sha512-JZyDyq3D4AUifKTPOB7DELf6XsB3WdPuNxCtob1vFXPsSXhdAiHBWJ/tJ8HAc9aH84BK+5JFZLNkJKx3G9kzQg==',
  license: 'MIT',
  dependencies: { 'balanced-match': '^4.0.2' },
  engines: { node: '20 || >=22' },
});

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function main() {
  const lockPath = resolve(process.argv[2] ?? 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    throw new Error(`${lockPath} must contain a packages object`);
  }

  let changed = false;
  for (const [packagePath, metadata] of Object.entries(lock.packages)) {
    if (!packagePath.endsWith('/node_modules/brace-expansion') || !metadata?.version) continue;
    if (compareVersions(metadata.version, BRACE_EXPANSION_5_0_8.version) >= 0) continue;
    lock.packages[packagePath] = { ...BRACE_EXPANSION_5_0_8 };
    changed = true;
  }

  const packageName = (packagePath) => packagePath.slice(packagePath.lastIndexOf('node_modules/') + 13);
  const committedIntegrity = new Map();
  for (const [packagePath, metadata] of Object.entries(lock.packages)) {
    if (!packagePath || !metadata?.version || !metadata.integrity) continue;
    committedIntegrity.set(`${packageName(packagePath)}@${metadata.version}`, metadata.integrity);
  }
  for (const [packagePath, metadata] of Object.entries(lock.packages)) {
    if (!packagePath || !metadata?.version || metadata.integrity || metadata.link) continue;
    const integrity = committedIntegrity.get(`${packageName(packagePath)}@${metadata.version}`);
    if (!integrity) continue;
    lock.packages[packagePath] = { ...metadata, integrity };
    changed = true;
  }

  if (changed) writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
