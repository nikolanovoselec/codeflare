import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectedNpmManifest } from '../../scripts/ci/coding-agent-selection.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const prune = join(root, 'scripts/ci/prune-selected-npm-tools.sh');

test('REQ-OPS-038: full agent installs skip redundant prune; subsets prune; comparison errors fail closed', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'npm-tools-selection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 41\n', { mode: 0o755 });
  const original = join(directory, 'original.json');
  const selected = join(directory, 'selected.json');
  const source = readFileSync(join(root, 'preseed/npm-tools/package.json'), 'utf8');
  const manifest = JSON.parse(source);
  writeFileSync(original, source);
  const run = () => spawnSync('sh', [prune, original, selected], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  writeFileSync(selected, `${JSON.stringify(selectedNpmManifest(manifest, 'claude-code,codex,copilot,antigravity,opencode,pi'), null, 2)}\n`);
  assert.equal(run().status, 0, 'unchanged locked manifest needs no second npm resolution');

  writeFileSync(selected, `${JSON.stringify(selectedNpmManifest(manifest, 'claude-code,pi'), null, 2)}\n`);
  assert.equal(run().status, 41, 'a reduced selection must execute prune and propagate its failure');

  rmSync(original);
  assert.equal(run().status, 2, 'a comparison error must not be treated as a legitimate difference');
});
