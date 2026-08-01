import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { updatePiRuntimeArtifacts } from '../../scripts/update-pi-runtime-artifacts.mjs';

const script = fileURLToPath(new URL('../../scripts/update-npm-tool-manifests.mjs', import.meta.url));
const piPackage = '@earendil-works/pi-coding-agent';
const piLibraries = ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui'];

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('REQ-OPS-033: lock-backed npm bump manifest updates', () => {
  it('updates an exact direct pin and rejects current-version drift', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-npm-tool-pin-'));
    try {
      const manifest = join(directory, 'package.json');
      writeJson(manifest, { dependencies: { bun: '1.0.0' } });

      const updated = spawnSync(process.execPath, [script, manifest, 'bun', '1.0.0', '1.1.0'], { encoding: 'utf8' });
      assert.equal(updated.status, 0, updated.stderr);
      assert.equal(readJson(manifest).dependencies.bun, '1.1.0');

      const drift = spawnSync(process.execPath, [script, manifest, 'bun', '1.0.0', '1.2.0'], { encoding: 'utf8' });
      assert.notEqual(drift.status, 0);
      assert.match(drift.stderr, /expected bun 1\.0\.0, found 1\.1\.0/);
      assert.equal(readJson(manifest).dependencies.bun, '1.1.0');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('REQ-OPS-025 AC4: updates every Pi runtime and prewarm artifact through one fail-closed operation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-pi-pin-'));
    try {
      const toolsDirectory = join(directory, 'preseed/npm-tools');
      const prewarmDirectory = join(directory, 'preseed/agents/pi');
      mkdirSync(toolsDirectory, { recursive: true });
      mkdirSync(prewarmDirectory, { recursive: true });
      const tools = join(toolsDirectory, 'package.json');
      const prewarm = join(prewarmDirectory, 'package.json');
      const devDependencies = Object.fromEntries(piLibraries.map((dependency) => [dependency, '0.81.0']));
      writeJson(tools, { dependencies: { [piPackage]: '0.81.0' }, devDependencies });
      writeJson(prewarm, { overrides: { [piPackage]: '0.81.0' }, devDependencies });

      const calls = [];
      updatePiRuntimeArtifacts(directory, '0.81.0', '0.82.0', (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
      });

      const nextTools = readJson(tools);
      const nextPrewarm = readJson(prewarm);
      assert.equal(nextTools.dependencies[piPackage], '0.82.0');
      assert.equal(nextPrewarm.overrides[piPackage], '0.82.0');
      for (const dependency of piLibraries) {
        assert.equal(nextTools.devDependencies[dependency], '0.82.0');
        assert.equal(nextPrewarm.devDependencies[dependency], '0.82.0');
      }
      assert.deepEqual(
        calls.map(({ command, args }) => [command, ...args].join(' ')),
        [
          'npm install --package-lock-only --ignore-scripts --no-audit --no-fund',
          `${process.execPath} ${join(directory, 'scripts/apply-npm-security-lock-pins.mjs')} ${join(toolsDirectory, 'package-lock.json')}`,
          `${process.execPath} ${join(directory, 'scripts/regenerate-pi-preseed-lock.mjs')}`,
          `${process.execPath} ${join(directory, 'scripts/apply-npm-security-lock-pins.mjs')} ${join(prewarmDirectory, 'package-lock.json')}`,
          'npm ci --no-audit --no-fund --silent',
          'npm run generate:agent-seed',
        ],
      );
      assert.equal(calls[0].cwd, toolsDirectory);
      assert.ok(calls.slice(1).every(({ cwd }) => cwd === directory));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
