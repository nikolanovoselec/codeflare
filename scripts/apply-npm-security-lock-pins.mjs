#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BRACE_EXPANSION_5_0_12 = Object.freeze({
  version: '5.0.12',
  resolved: 'https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz',
  integrity: 'sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==',
  license: 'MIT',
  dependencies: { 'balanced-match': '^4.0.2' },
  engines: { node: '20 || >=22' },
});

const UNDICI_7_30_0 = Object.freeze({
  version: '7.30.0',
  resolved: 'https://registry.npmjs.org/undici/-/undici-7.30.0.tgz',
  integrity: 'sha512-dkrQXeHSaoamnItlYbmzG0wFYrM0ZwDxCIg0A7aKjTyyhh9svRzCNFEzV+Vm05/yehjCzjDZ31KXfGEjYSztDQ==',
  license: 'MIT',
  engines: { node: '>=20.18.1' },
});

const UNDICI_8_11_2 = Object.freeze({
  version: '8.11.2',
  resolved: 'https://registry.npmjs.org/undici/-/undici-8.11.2.tgz',
  integrity: 'sha512-u4UB2/IrKdU6lFxumHmmo1a3fCQO5tzQllRorfoRS63txhrB7xTpSn1PftwC4qEHkOaqP95fCWW4lJzwErwzhQ==',
  license: 'MIT',
  engines: { node: '>=22.19.0' },
});

const IP_ADDRESS_10_7_2 = Object.freeze({
  version: '10.7.2',
  resolved: 'https://registry.npmjs.org/ip-address/-/ip-address-10.7.2.tgz',
  integrity: 'sha512-7H/2gFSIitxc0hG3nOI1glS8QLo/EHBFFLk8vEUjXY/xu0AdL8jZ9U1IzO2PUm0d2D/ofQcAifb0g6OBkt8U7w==',
  license: 'MIT',
  engines: { node: '>= 12' },
});

// Pi's published shrinkwrap omits these nested registry integrities. Keep the
// independently reviewed npm dist values here so every committed production
// lock remains complete after deterministic regeneration.
const REVIEWED_SHRINKWRAP_INTEGRITIES = new Map([
  ['@earendil-works/pi-client@0.84.1', 'sha512-/V5hGHE4Zq+jG0GtwIB9PyBUOGd6gBLZ7lkQYFKchKnxYHeH3rmWC5xw4kpnZKKBuBuFTdLVbU9vEjlAGMMb2A=='],
  ['@earendil-works/pi-protocol@0.84.1', 'sha512-Ox1pciyeSPGEEUcxvR0/dJcrY7C6hrEGA8y71rOsvSIUlXN1Cbp/be/eoL71OGDBk5O97TeQPfWN6Ju/2Ehjww=='],
]);

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
      securityPin = BRACE_EXPANSION_5_0_12;
    } else if (packagePath === 'node_modules/undici' || packagePath.endsWith('/node_modules/undici')) {
      if (metadata.version.startsWith('7.')) securityPin = UNDICI_7_30_0;
      if (metadata.version.startsWith('8.')) securityPin = UNDICI_8_11_2;
    } else if (packagePath === 'node_modules/ip-address' || packagePath.endsWith('/node_modules/ip-address')) {
      if (metadata.version.startsWith('10.')) securityPin = IP_ADDRESS_10_7_2;
    }

    if (!securityPin || compareVersions(metadata.version, securityPin.version) >= 0) continue;
    lock.packages[packagePath] = { ...securityPin, ...(metadata.dev === true ? { dev: true } : {}) };
    changed = true;
  }

  const packageName = (packagePath) => packagePath.slice(packagePath.lastIndexOf('node_modules/') + 13);
  const committedIntegrity = new Map(REVIEWED_SHRINKWRAP_INTEGRITIES);
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
