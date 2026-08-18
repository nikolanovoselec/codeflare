import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const coreUrl = pathToFileURL(join(repoRoot, 'scripts/agent-seed-core.mjs')).href;
const wrapperUrl = pathToFileURL(join(repoRoot, 'scripts/generate-agent-seed.mjs')).href;
const generatedPath = join(repoRoot, 'src/lib/agent-seed.generated.ts');

// REQ-AGENT-147: the image generator and the private release workflow share
// one side-effect-free compiler. These tests cross the public module boundary;
// deleting the core, restoring import-time generation, or changing generated
// bytes makes them fail.
describe('shared agent seed compiler', () => {
  it('imports without generating or rewriting the committed image artifact', async () => {
    const before = await stat(generatedPath);
    const beforeBytes = await readFile(generatedPath);

    const core = await import(`${coreUrl}?import-contract=${Date.now()}`);

    assert.equal(typeof core.compileAgentSeed, 'function');
    assert.equal(typeof core.generateAgentSeed, 'function');
    assert.equal(typeof core.computeAgentRuntimeHash, 'function');
    const after = await stat(generatedPath);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(await readFile(generatedPath), beforeBytes);
  });

  it('keeps the CLI wrapper import side-effect free', async () => {
    const before = await stat(generatedPath);
    const beforeBytes = await readFile(generatedPath);

    const wrapper = await import(`${wrapperUrl}?import-contract=${Date.now()}`);

    assert.equal(typeof wrapper.main, 'function');
    const after = await stat(generatedPath);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(await readFile(generatedPath), beforeBytes);
  });

  it('generates byte-identical image output through the shared core', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-seed-core-'));
    try {
      const outputFile = join(dir, 'agent-seed.generated.ts');
      const { generateAgentSeed } = await import(coreUrl);

      const compiled = await generateAgentSeed({ rootDir: repoRoot, outputFile, log: () => undefined });

      assert.match(compiled.runtimeHash, /^[0-9a-f]{64}$/);
      assert.match(compiled.source, new RegExp(`export const PRESEED_RUNTIME_DEPENDENCY_HASH = '${compiled.runtimeHash}';`));
      assert.deepEqual(await readFile(outputFile), await readFile(generatedPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('binds the release ABI to the Pi runtime dependency lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-runtime-hash-'));
    const lockPath = join(dir, 'preseed/agents/pi/package-lock.json');
    try {
      await mkdir(dirname(lockPath), { recursive: true });
      await writeFile(lockPath, '{"lockfileVersion":3,"packages":{}}\n');
      const { computeAgentRuntimeHash } = await import(coreUrl);
      const first = await computeAgentRuntimeHash(dir);

      await writeFile(lockPath, '{"lockfileVersion":3,"packages":{"node_modules/example":{"version":"1.0.0"}}}\n');
      const second = await computeAgentRuntimeHash(dir);

      assert.match(first, /^[0-9a-f]{64}$/);
      assert.match(second, /^[0-9a-f]{64}$/);
      assert.notEqual(second, first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
