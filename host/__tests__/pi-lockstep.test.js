import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, getFips } from 'node:crypto';
import { describe, it } from 'node:test';

const script = fileURLToPath(new URL('../../scripts/verify-pi-lockstep.mjs', import.meta.url));

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe('REQ-AGENT-111 AC3: Goal jiti cache uses the runtime-resolved path', () => {
  it('derives jiti\'s exact async cache filename through the runtime symlink', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-goal-cache-'));
    try {
      const installedRoot = join(directory, 'installed');
      const runtimeRoot = join(directory, 'runtime');
      const sourceDirectory = join(installedRoot, 'extensions', 'loops');
      mkdirSync(sourceDirectory, { recursive: true });
      mkdirSync(runtimeRoot);
      const installedSource = join(sourceDirectory, 'goal.ts');
      const runtimeSource = join(runtimeRoot, 'goal.ts');
      writeFileSync(installedSource, 'export default function goal() {}\n');
      symlinkSync(installedSource, runtimeSource);

      const result = spawnSync(process.execPath, [script, '--jiti-cache-path', runtimeSource, '/cache'], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      const realSource = realpathSync(runtimeSource);
      const algorithm = getFips?.() ? 'sha256' : 'md5';
      const hash = createHash(algorithm).update(realSource).digest('hex').slice(0, 8);
      assert.equal(result.stdout, `/cache/loops-goal.${hash}.mjs\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('REQ-AGENT-001 AC6: Pi image lockstep fails closed', () => {
  it('accepts matching runtime, prewarm, and installed Pi versions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-pi-lockstep-'));
    try {
      const runtime = join(directory, 'runtime.json');
      const prewarm = join(directory, 'prewarm.json');
      const installed = join(directory, 'installed.json');
      writeJson(runtime, { dependencies: { '@earendil-works/pi-coding-agent': '0.82.0' } });
      writeJson(prewarm, { overrides: { '@earendil-works/pi-coding-agent': '0.82.0' } });
      writeJson(installed, { version: '0.82.0' });

      const result = spawnSync(process.execPath, [script, runtime, prewarm, installed], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects prewarm and installed version drift independently', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-pi-lockstep-'));
    try {
      const runtime = join(directory, 'runtime.json');
      const prewarm = join(directory, 'prewarm.json');
      const installed = join(directory, 'installed.json');
      writeJson(runtime, { dependencies: { '@earendil-works/pi-coding-agent': '0.82.0' } });
      writeJson(prewarm, { overrides: { '@earendil-works/pi-coding-agent': '0.81.0' } });
      writeJson(installed, { version: '0.82.0' });

      const prewarmDrift = spawnSync(process.execPath, [script, runtime, prewarm], { encoding: 'utf8' });
      assert.notEqual(prewarmDrift.status, 0);
      assert.match(prewarmDrift.stderr, /prewarm Pi SDK 0\.81\.0 != runtime 0\.82\.0/);

      writeJson(prewarm, { overrides: { '@earendil-works/pi-coding-agent': '0.82.0' } });
      writeJson(installed, { version: '0.81.0' });
      const installedDrift = spawnSync(process.execPath, [script, runtime, prewarm, installed], { encoding: 'utf8' });
      assert.notEqual(installedDrift.status, 0);
      assert.match(installedDrift.stderr, /installed prewarm Pi SDK 0\.81\.0 != runtime 0\.82\.0/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
