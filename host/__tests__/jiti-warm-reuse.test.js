import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../../scripts/verify-pi-lockstep.mjs', import.meta.url));
const jiti = createRequire(import.meta.url).resolve('jiti');

function exercise({ invalidate = false, native = false, quiet = false, dependency = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jiti-reuse-'));
  try {
    const source = join(directory, native ? 'extension.js' : 'extension.ts');
    const cache = join(directory, 'jiti');
    const count = join(directory, 'count');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    const dependencyPath = join(directory, 'dependency.ts');
    writeFileSync(dependencyPath, 'export const value: number = 1;');
    writeFileSync(source, dependency ? "export { value } from './dependency.ts';" : native ? 'export const value = 1;' : 'export const value: number = 1;');
    mkdirSync(cache);
    const pi = join(directory, 'fixture-pi.cjs');
    writeFileSync(pi, `#!/usr/bin/env node
const fs = require('node:fs');
const countPath = ${JSON.stringify(count)};
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;
fs.writeFileSync(countPath, String(count + 1));
if (${invalidate} && count === 1) fs.writeFileSync(${JSON.stringify(dependency ? dependencyPath : source)}, 'export const value: number = 2;');
const { createJiti } = require(${JSON.stringify(jiti)});
const loader = createJiti(__filename, { moduleCache: false, fsCache: ${JSON.stringify(cache)}, ${quiet ? 'debug: false,' : ''} alias: {} });
loader.import(${JSON.stringify(source)}).then(module => {
  if (module.value !== (${invalidate} && count === 1 ? 2 : 1)) throw new Error('incorrect compiled value');
}).catch(error => { console.error(error); process.exitCode = 1; });
`);
    chmodSync(pi, 0o755);
    const result = spawnSync(process.execPath, [script, '--warm-jiti-entrypoints', pi, cache, source], {
      encoding: 'utf8', timeout: 30_000,
    });
    return { ...result, launches: Number(readFileSync(count, 'utf8')) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('REQ-AGENT-210: image extension cache reuse', () => {
  it('proves a real JITI hit in a second fresh process', () => {
    const result = exercise();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.launches, 2);
  });

  it('rejects a source change that produces a cold miss instead of a hit', () => {
    const result = exercise({ invalidate: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JITI cache reuse not proven/);
  });

  it('rejects a cold dependency even when its entrypoint hits the cache', () => {
    const result = exercise({ dependency: true, invalidate: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JITI cache reuse not proven:.*dependency\.ts/);
  });

  it('fails closed when a populated cache has no hit evidence', () => {
    const result = exercise({ quiet: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JITI cache reuse not proven/);
  });

  it('warms native JavaScript without requiring a nonexistent JITI artifact', () => {
    const result = exercise({ native: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.launches, 2);
  });
});
