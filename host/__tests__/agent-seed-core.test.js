import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const coreUrl = pathToFileURL(join(repoRoot, 'scripts/agent-seed-core.mjs')).href;
const wrapperUrl = pathToFileURL(join(repoRoot, 'scripts/generate-agent-seed.mjs')).href;
const generatedPath = join(repoRoot, 'src/lib/agent-seed.generated.ts');

async function copyCompilerFixture(root) {
  for (const agent of ['claude', 'pi']) {
    const manifestPath = `preseed/agents/${agent}/manifest.json`;
    const manifest = JSON.parse(await readFile(join(repoRoot, manifestPath), 'utf8'));
    for (const relativePath of [manifestPath, ...Object.keys(manifest).map((key) => `preseed/agents/${agent}/${key}`)]) {
      const destination = join(root, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(repoRoot, relativePath), destination);
    }
  }
  for (const relativePath of [
    'preseed/npm-tools/package-lock.json',
    'preseed/agents/claude/browser-run-mcp/package-lock.json',
    'preseed/retired-keys.json',
  ]) {
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await copyFile(join(repoRoot, relativePath), join(root, relativePath));
  }
}

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
      const licenses = compiled.documents.filter((document) => document.key.endsWith('/LICENSE'));
      assert.ok(licenses.length >= 2);
      assert.ok(licenses.every((document) => document.contentType === 'text/plain; charset=utf-8'));
      assert.deepEqual(await readFile(outputFile), await readFile(generatedPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('REQ-AGENT-157 AC4: accepts 399 and rejects 400 Claude safe-check policy characters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-seed-policy-limit-'));
    try {
      await copyCompilerFixture(dir);
      const policyPath = join(dir, 'preseed/agents/claude/rules/no-local-builds.md');
      await writeFile(policyPath, 'x'.repeat(399));
      const { compileAgentSeed } = await import(coreUrl);
      const compiled = await compileAgentSeed({ rootDir: dir });
      assert.equal(
        compiled.documents.find(({ key }) => key === '.claude/rules/no-local-builds.md')?.content.length,
        399,
      );

      await writeFile(policyPath, 'x'.repeat(400));
      await assert.rejects(
        compileAgentSeed({ rootDir: dir }),
        /Claude permanently loaded safe-check rule must remain below 400 characters/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('binds the release ABI to every managed npm runtime lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-runtime-hash-'));
    const lockPaths = [
      'preseed/npm-tools/package-lock.json',
      'preseed/agents/claude/browser-run-mcp/package-lock.json',
      'preseed/agents/pi/package-lock.json',
    ];
    const baseline = '{"lockfileVersion":3,"packages":{}}\n';
    try {
      for (const relativePath of lockPaths) {
        const lockPath = join(dir, relativePath);
        await mkdir(dirname(lockPath), { recursive: true });
        await writeFile(lockPath, baseline);
      }
      const { computeAgentRuntimeHash } = await import(coreUrl);
      const first = await computeAgentRuntimeHash(dir);

      assert.match(first, /^[0-9a-f]{64}$/);
      for (const relativePath of lockPaths) {
        const lockPath = join(dir, relativePath);
        await writeFile(lockPath, '{"lockfileVersion":3,"packages":{"node_modules/example":{"version":"1.0.0"}}}\n');
        assert.notEqual(await computeAgentRuntimeHash(dir), first, `${relativePath} must participate in compatibility`);
        await writeFile(lockPath, baseline);
        assert.equal(await computeAgentRuntimeHash(dir), first, 'unchanged runtime locks retain compatibility');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
