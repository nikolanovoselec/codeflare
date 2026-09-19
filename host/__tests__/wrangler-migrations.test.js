// Durable Object migration tags are append-only once deployed. Removing a
// historical tag makes Wrangler replay the remaining migrations against the
// published script.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wranglerToml = readFileSync(resolve(__dirname, '../../wrangler.toml'), 'utf8');
const workerEntry = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');

describe('Durable Object migration history', () => {
  it('retains every migration tag already applied to the integration script', () => {
    assert.match(wranglerToml, /tag = "v1"[\s\S]*?new_sqlite_classes = \["container"\]/);
    assert.match(wranglerToml, /tag = "v2"[\s\S]*?new_classes = \["timekeeper"\]/);
    assert.match(wranglerToml, /tag = "v3"[\s\S]*?new_sqlite_classes = \["OperatorRegistry"\]/);
    assert.match(wranglerToml, /tag = "v4"[\s\S]*?new_sqlite_classes = \["OperatorActivity"\]/);
    assert.match(workerEntry, /OperatorRegistry/);
    assert.match(workerEntry, /OperatorActivity/);
  });
});
