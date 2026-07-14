import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(modulePath), '..');
const sourceRoot = join(repositoryRoot, 'src');

export function findBackendTestFiles(directory = sourceRoot) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) return findBackendTestFiles(entryPath);
      if (!entry.isFile() || !entry.name.endsWith('.test.ts')) return [];
      return [relative(repositoryRoot, entryPath).split(sep).join('/')];
    })
    .sort();
}

export function runWorkersRuntimeTests(testFiles = findBackendTestFiles()) {
  for (const testFile of testFiles) {
    const result = spawnSync(
      'npx',
      ['vitest', 'run', '--config', 'vitest.config.ts', testFile],
      { cwd: repositoryRoot, stdio: 'inherit' },
    );

    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }

  return 0;
}

if (resolve(process.argv[1] ?? '') === modulePath) {
  process.exitCode = runWorkersRuntimeTests();
}
