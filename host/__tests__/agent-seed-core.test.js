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
      const licenses = compiled.documents.filter((document) => document.key.endsWith('/LICENSE'));
      assert.ok(licenses.length >= 2);
      assert.ok(licenses.every((document) => document.contentType === 'text/plain; charset=utf-8'));
      const piInstructions = compiled.documents.find((document) => (
        document.key === '.pi/agent/AGENTS.md' && document.modes.includes('default')
      ));
      const instructions = piInstructions?.content ?? '';
      const indexStart = instructions.indexOf('<!-- pi-skill-index:start -->');
      const indexEnd = instructions.indexOf('<!-- pi-skill-index:end -->');
      assert.ok(indexStart >= 0 && indexEnd > indexStart);
      const indexedSkills = [...instructions.slice(indexStart, indexEnd).matchAll(/^- `([^`]+)` — /gm)]
        .map((match) => match[1]);
      assert.ok(indexedSkills.includes('codeflare-capabilities'));
      const humanizeDocuments = compiled.documents
        .filter((document) => document.key.includes('/skills/humanize/'))
        .map(({ key, modes }) => ({ key, modes }))
        .sort((left, right) => left.key.localeCompare(right.key));
      assert.deepEqual(humanizeDocuments, [
        '.claude/skills/humanize/reference/findings.md',
        '.claude/skills/humanize/SKILL.md',
        '.codex/skills/humanize/reference/findings.md',
        '.codex/skills/humanize/SKILL.md',
        '.config/opencode/skills/humanize/reference/findings.md',
        '.config/opencode/skills/humanize/SKILL.md',
        '.gemini/skills/humanize/reference/findings.md',
        '.gemini/skills/humanize/SKILL.md',
        '.pi/agent/skills/humanize/reference/findings.md',
        '.pi/agent/skills/humanize/SKILL.md',
      ].map((key) => ({ key, modes: ['advanced'] })));
      assert.deepEqual(await readFile(outputFile), await readFile(generatedPath));
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
