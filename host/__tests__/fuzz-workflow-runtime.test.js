import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

describe('backend fuzz workflow runtime', () => {
  it('discovers backend fuzz tests under the plain Node forks pool', async () => {
    const configPath = resolve(repoRoot, 'vitest.fuzz.config.mjs');
    const { default: config } = await import(pathToFileURL(configPath).href);

    assert.equal(config.test.environment, 'node');
    assert.equal(config.test.pool, 'forks');
    assert.deepEqual(config.test.include, ['src/__tests__/fuzz/**/*.fuzz.test.ts']);

    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/fuzz.yml'), 'utf8');
    assert.match(
      workflow,
      /run: npx vitest run --config vitest\.fuzz\.config\.mjs --reporter=verbose/,
    );
  });
});
