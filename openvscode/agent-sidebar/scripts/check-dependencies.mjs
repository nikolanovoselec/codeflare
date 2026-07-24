import { readFile } from 'node:fs/promises';

const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MPL-2.0',
]);

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));

if (lock.lockfileVersion !== 3) throw new Error('Browser IDE lockfile must use npm lockfile version 3');
for (const section of ['dependencies', 'devDependencies']) {
  for (const [name, version] of Object.entries(manifest[section] ?? {})) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
      throw new Error(`${name} is not pinned to an exact version`);
    }
  }
}

const rejected = [];
for (const [path, dependency] of Object.entries(lock.packages ?? {})) {
  if (!path || !path.startsWith('node_modules/')) continue;
  if (!ALLOWED_LICENSES.has(dependency.license)) {
    rejected.push(`${path}: ${dependency.license ?? '<missing>'}`);
  }
}
if (rejected.length) throw new Error(`Unapproved dependency licenses:\n${rejected.join('\n')}`);

process.stdout.write(`Validated ${Object.keys(lock.packages).length - 1} locked Browser IDE packages and licenses.\n`);
