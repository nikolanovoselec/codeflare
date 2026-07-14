import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const testFiles = JSON.parse(
  readFileSync(new URL('./workers-runtime-tests.json', import.meta.url), 'utf8'),
);

export function runWorkersRuntimeTests() {
  for (const testFile of testFiles) {
    const result = spawnSync(
      'npx',
      ['vitest', 'run', '--config', 'vitest.workers.config.ts', testFile],
      { stdio: 'inherit' },
    );

    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

runWorkersRuntimeTests();
