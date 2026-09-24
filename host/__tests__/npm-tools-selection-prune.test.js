import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectedNpmManifest } from '../../scripts/ci/coding-agent-selection.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const prune = join(root, 'scripts/ci/prune-selected-npm-tools.sh');

test('REQ-OPS-038/040: full installs retain launchers, reduced installs remove omitted launchers, errors fail closed', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'npm-tools-selection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 41\n', { mode: 0o755 });
  const original = join(directory, 'original.json');
  const selected = join(directory, 'selected.json');
  const modules = join(directory, 'node_modules');
  mkdirSync(join(modules, '.bin'), { recursive: true });
  const launchers = [
    ['@anthropic-ai/claude-code', 'claude'], ['@openai/codex', 'codex'],
    ['@github/copilot', 'copilot'], ['opencode-ai', 'opencode'],
    ['@earendil-works/pi-coding-agent', 'pi'], ['shared-tool', 'shared'],
  ];
  for (const [packageName, binName] of launchers) {
    const packagePath = join(modules, packageName);
    mkdirSync(packagePath, { recursive: true });
    const executable = join(packagePath, 'run');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    symlinkSync(executable, join(modules, '.bin', binName));
  }
  const families = [
    ['@anthropic-ai', 'claude-code', 'claude-code-linux-x64'],
    ['@openai', 'codex', 'codex-linux-x64'],
    ['@github', 'copilot', 'copilot-linux-x64'],
    ['', 'opencode-ai', 'opencode-linux-x64'],
  ];
  for (const [scope, , payload] of families) mkdirSync(join(modules, scope, payload), { recursive: true });
  mkdirSync(join(modules, '@github', 'copilot-linux-arm64'));
  const copilotPayload = join(modules, '@github', 'copilot-linux-x64', 'run');
  writeFileSync(copilotPayload, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  symlinkSync(copilotPayload, join(modules, '.bin', 'copilot-linux-x64'));
  const inventory = (scope, prefix) => readdirSync(join(modules, scope)).filter((name) => name.startsWith(prefix)).sort();
  const launch = (name) => spawnSync(join(modules, '.bin', name));
  const source = readFileSync(join(root, 'preseed/npm-tools/package.json'), 'utf8');
  const manifest = JSON.parse(source);
  writeFileSync(original, source);
  const run = (selection) => spawnSync('sh', [prune, original, selected, selection], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  writeFileSync(selected, `${JSON.stringify(selectedNpmManifest(manifest, 'claude-code,codex,copilot,antigravity,opencode,pi'), null, 2)}\n`);
  assert.equal(run('claude-code,codex,copilot,antigravity,opencode,pi').status, 0);
  for (const [, binName] of launchers) assert.equal(launch(binName).status, 0, binName);
  assert.equal(launch('copilot-linux-x64').status, 0);
  for (const [scope, name, payload] of families) {
    assert.ok(inventory(scope, name.split('-')[0]).includes(payload), `${payload} was installed`);
  }

  writeFileSync(selected, `${JSON.stringify(selectedNpmManifest(manifest, 'claude-code,pi'), null, 2)}\n`);
  assert.equal(run('claude-code,pi').status, 0);
  for (const name of ['claude', 'pi', 'shared']) assert.equal(launch(name).status, 0, name);
  for (const name of ['codex', 'copilot', 'opencode', 'copilot-linux-x64']) {
    assert.equal(launch(name).error?.code, 'ENOENT', `${name} must not launch when omitted`);
  }
  for (const [scope, prefix] of families.slice(1)) {
    assert.deepEqual(inventory(scope, prefix.split('-')[0]), [], `${prefix} package family must be absent`);
  }
  assert.deepEqual(inventory('@anthropic-ai', 'claude-code'), ['claude-code', 'claude-code-linux-x64']);

  writeFileSync(selected, `${JSON.stringify(selectedNpmManifest(manifest, 'pi'), null, 2)}\n`);
  assert.equal(run('pi').status, 0);
  assert.equal(launch('claude').error?.code, 'ENOENT', 'enterprise Pi-only images omit Claude');
  for (const [scope, prefix] of families) {
    assert.deepEqual(inventory(scope, prefix.split('-')[0]), [], `${prefix} package family must be absent`);
  }
  for (const name of ['pi', 'shared']) assert.equal(launch(name).status, 0, name);

  rmSync(original);
  assert.equal(run('pi').status, 2, 'a comparison error must not be treated as a legitimate difference');
});
