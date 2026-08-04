#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BRACE_EXPANSION_5_0_9 = Object.freeze({
  version: '5.0.9',
  resolved: 'https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz',
  integrity: 'sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==',
  license: 'MIT',
  dependencies: { 'balanced-match': '^4.0.2' },
  engines: { node: '20 || >=22' },
});

const UNDICI_7_29_0 = Object.freeze({
  version: '7.29.0',
  resolved: 'https://registry.npmjs.org/undici/-/undici-7.29.0.tgz',
  integrity: 'sha512-IDxfleLmmbSskfWSUATiN1nfn2rDuvnMOqb5CWR92iIfojA0Ud+ulOAAEQ57LPr9rWmsreUyf5lwyao+7GNNVw==',
  license: 'MIT',
  engines: { node: '>=20.18.1' },
});

const UNDICI_8_9_0 = Object.freeze({
  version: '8.9.0',
  resolved: 'https://registry.npmjs.org/undici/-/undici-8.9.0.tgz',
  integrity: 'sha512-aWZpUj7XoGonMClx4gdDRfgBjqeA+F473aDmROQQbM9n6PRfK/u1q/a0X4wMTgcHfT8H6fpbt98PFuDUwFg2YA==',
  license: 'MIT',
  engines: { node: '>=22.19.0' },
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
    if (!metadata?.version) continue;

    let securityPin;
    if (packagePath === 'node_modules/brace-expansion' || packagePath.endsWith('/node_modules/brace-expansion')) {
      securityPin = BRACE_EXPANSION_5_0_9;
    } else if (packagePath === 'node_modules/undici' || packagePath.endsWith('/node_modules/undici')) {
      if (metadata.version.startsWith('7.')) securityPin = UNDICI_7_29_0;
      if (metadata.version.startsWith('8.')) securityPin = UNDICI_8_9_0;
    }

    if (!securityPin || compareVersions(metadata.version, securityPin.version) >= 0) continue;
    lock.packages[packagePath] = { ...securityPin };
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
