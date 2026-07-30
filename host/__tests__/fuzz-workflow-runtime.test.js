import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

describe('backend fuzz workflow runtime', () => {
  it('discovers backend fuzz tests under the plain Node forks pool', () => {
    const executable = resolve(
      repoRoot,
      'node_modules/.bin',
      process.platform === 'win32' ? 'vitest.cmd' : 'vitest',
    );
    const result = spawnSync(executable, ['list', '--config', 'vitest.fuzz.config.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const expected = readdirSync(resolve(repoRoot, 'src/__tests__/fuzz'))
      .filter((name) => name.endsWith('.fuzz.test.ts'))
      .map((name) => `src/__tests__/fuzz/${name}`)
      .sort();
    const discovered = [...result.stdout.matchAll(/src\/__tests__\/fuzz\/[^ >\n]+\.fuzz\.test\.ts/g)]
      .map(([file]) => file)
      .filter((file, index, files) => files.indexOf(file) === index)
      .sort();

    assert.deepEqual(discovered, expected);
  });
});
