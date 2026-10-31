import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

const WRAPPER = '/codeflare/preseed/agents/claude/skills/safe-local-checks/scripts/safe-local-check.mjs';

// Absolute fallbacks are exercised only in the built container via CODEFLARE_IMAGE_TEST.
it('uses image-baked Oxlint without dependencies, ignores ancestor/PATH tools, and stays read-only', {
  skip: process.env.CODEFLARE_IMAGE_TEST !== '1',
}, () => {
  const parent = mkdtempSync(join(tmpdir(), 'safe-local-check-image-analyzer-'));
  const root = join(parent, 'repository');
  const bin = join(parent, 'node_modules', '.bin');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'oxlint'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
  const source = 'export const value = 1;\n';
  writeFileSync(join(root, 'valid.js'), source, 'utf8');
  const before = readdirSync(root).sort();
  const run = (args) => spawnSync(process.execPath, [WRAPPER, 'oxlint', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  const result = run(['valid.js']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(root).sort(), before, 'no dependencies, locks, caches, or output files');
  assert.equal(readFileSync(join(root, 'valid.js'), 'utf8'), source);

  for (const flag of ['--fix', '--fix-suggestions', '--write', '--watch', '--output-file=report.json', '--cache', '--concurrency=2']) {
    const refused = run([flag, 'valid.js']);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /read-only|not allowed/i);
    assert.deepEqual(readdirSync(root).sort(), before);
    assert.equal(readFileSync(join(root, 'valid.js'), 'utf8'), source);
  }

  writeFileSync(join(root, 'invalid.js'), 'debugger;\n', 'utf8');
  const diagnostic = run(['--deny', 'no-debugger', 'invalid.js']);
  assert.equal(diagnostic.status, 1, diagnostic.stderr);
  assert.match(diagnostic.stdout + diagnostic.stderr, /debugger/i);
  assert.deepEqual(readdirSync(root).sort(), [...before, 'invalid.js'].sort());
  assert.equal(readFileSync(join(root, 'invalid.js'), 'utf8'), 'debugger;\n');
});
for (const name of ['oxlint', 'eslint', 'biome', 'prettier']) {
  it(`${name} uses only its approved image binary when no local copy exists`, {
    skip: process.env.CODEFLARE_IMAGE_TEST !== '1',
  }, () => {
    const parent = mkdtempSync(join(tmpdir(), 'safe-local-check-image-bin-'));
    const root = join(parent, 'repository');
    const bin = join(parent, 'node_modules', '.bin');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
    writeFileSync(join(root, 'valid.js'), 'export const value = 1;\n', 'utf8');
    writeFileSync(join(root, 'eslint.config.mjs'), 'export default [{}];\n', 'utf8');
    const before = readdirSync(root).sort();
    const args = name === 'biome' ? ['check', 'valid.js'] : name === 'prettier' ? ['--check', 'valid.js'] : ['valid.js'];
    const result = spawnSync(process.execPath, [WRAPPER, name, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(root).sort(), before, 'no repository dependencies or outputs created');
    assert.equal(readFileSync(join(root, 'valid.js'), 'utf8'), 'export const value = 1;\n');
  });
}

it('runs image-provided Node and Bash syntax checks without repository dependencies', {
  skip: process.env.CODEFLARE_IMAGE_TEST !== '1',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'safe-local-check-image-shell-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'valid.js'), 'export const value = 1;\n', 'utf8');
  writeFileSync(join(root, 'valid.sh'), 'echo ready\n', 'utf8');
  const before = readdirSync(root).sort();
  for (const args of [['syntax', 'valid.js'], ['shell-syntax', 'valid.sh']]) {
    const result = spawnSync(process.execPath, [WRAPPER, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(root).sort(), before);
  }
});

it('parses YAML using the image library without dependencies or repository mutation', {
  skip: process.env.CODEFLARE_IMAGE_TEST !== '1',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'safe-local-check-image-yaml-'));
  mkdirSync(join(root, '.git'));
  const valid = 'ok: true\n';
  const invalid = 'ok: [\n';
  writeFileSync(join(root, 'valid.yaml'), valid, 'utf8');
  writeFileSync(join(root, 'invalid.yaml'), invalid, 'utf8');
  const before = readdirSync(root).sort();
  const run = (file) => spawnSync(process.execPath, [WRAPPER, 'yaml', file], { cwd: root, encoding: 'utf8' });

  const result = run('valid.yaml');
  assert.equal(result.status, 0, result.stderr);
  const diagnostic = run('invalid.yaml');
  assert.equal(diagnostic.status, 2, diagnostic.stderr);
  assert.match(diagnostic.stderr, /invalid.yaml/);
  assert.deepEqual(readdirSync(root).sort(), before);
  assert.equal(readFileSync(join(root, 'valid.yaml'), 'utf8'), valid);
  assert.equal(readFileSync(join(root, 'invalid.yaml'), 'utf8'), invalid);
});

it('REQ-AGENT-192 AC2-AC3: parses TypeScript without project dependencies or repository writes', {
  skip: process.env.CODEFLARE_IMAGE_TEST !== '1',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'safe-local-check-image-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'valid.ts'), 'const value: number = 1;\n', 'utf8');
  const before = readdirSync(root).sort();
  assert.deepEqual(before, ['.git', 'valid.ts']);

  const result = spawnSync(process.execPath, [
    '/codeflare/preseed/agents/claude/skills/safe-local-checks/scripts/safe-local-check.mjs',
    'ts-syntax',
    'valid.ts',
  ], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(root).sort(), before);
  assert.equal(readFileSync(join(root, 'valid.ts'), 'utf8'), 'const value: number = 1;\n');
});
