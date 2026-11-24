import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { handlePrewarmOrphanExpiry } from '../dist/prewarm-readiness.js';
import { createPiWebHandoff } from '../dist/pi-web-handoff.js';
import { createPiWebRuntime } from '../dist/pi-web-runtime.js';

function actions(calls) {
  return {
    disposeDataListener: () => calls.push('dispose-listener'),
    clearReadinessPoll: () => calls.push('clear-poll'),
    deleteSession: () => calls.push('delete-session'),
  };
}

describe('pre-warm orphan expiry', () => {
  it('REQ-AGENT-272 AC1: Classic Terminal starts after profile restore while cloning continues', { timeout: 3000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-web-clone-ready-'));
    let profileRestored = false;
    const runtimeDir = join(home, 'runtime');
    const owner = join(runtimeDir, 'owner.json');
    const runtime = createPiWebRuntime({ sessionId: 'fixture123', generation: 7, initialSurface: 'terminal',
      terminalMode: 'classic', cwd: join(home, 'workspace'), home, runtimeDir, profileRestored: () => profileRestored, cloneRestored: () => false });
    const boot = runtime.initialize();
    void boot.catch(() => {});
    try {
      await delay(200);
      assert.equal(existsSync(owner), false);
      assert.equal(runtime.status().phase, 'opening');
      profileRestored = true;
      await boot;
      const grant = JSON.parse(readFileSync(owner, 'utf8'));
      assert.equal(grant.generation, 7);
      assert.equal(grant.surface, 'terminal');
      assert.equal(grant.phase, 'active');
      assert.equal(grant.terminalTicket, 'initial');
    } finally {
      await runtime.close();
      await boot.catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('REQ-TERM-035 AC5: orphan expiry terminates unbootstrapped Herdr after cleanup', () => {
    const moduleUrl = new URL('../dist/prewarm-readiness.js', import.meta.url).href;
    const script = `
      import { writeSync } from 'node:fs';
      import { handlePrewarmOrphanExpiry } from ${JSON.stringify(moduleUrl)};
      handlePrewarmOrphanExpiry('herdr', false, {
        disposeDataListener: () => writeSync(1, 'dispose-listener\\n'),
        clearReadinessPoll: () => writeSync(1, 'clear-poll\\n'),
        deleteSession: () => writeSync(1, 'delete-session\\n'),
      }, true);
      writeSync(1, 'unreachable\\n');
    `;

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.stdout.trim().split('\n'), ['dispose-listener', 'clear-poll', 'delete-session']);
  });

  for (const mode of ['classic', 'herdr']) {
    it(`REQ-AGENT-272 AC2: idle ${mode} primary remains available for a Chat-to-Terminal switch after orphan expiry`, async () => {
      const saved = { id: 'native-id', cwd: '/workspace', path: '/sessions/native-id.jsonl' };
      let primaryAlive = true;
      let writer = 'chat';
      const handoff = createPiWebHandoff({
        generation: 7, initialSurface: 'chat', stopWork: async () => {}, waitForIdle: async () => {},
        release: async () => { writer = null; return saved; },
        open: async (surface, binding) => {
          if (!primaryAlive) return false;
          assert.equal(writer, null);
          assert.deepEqual(binding, saved);
          writer = surface;
          return true;
        },
      });
      handlePrewarmOrphanExpiry(mode, mode === 'herdr', {
        ...actions([]), deleteSession: () => { primaryAlive = false; },
      }, true);
      const switched = await handoff.switchTo({ generation: 7, requestId: 'retained-primary', target: 'terminal' });
      assert.equal(switched.phase, 'complete');
      assert.equal(writer, 'terminal');
    });
  }

  it('preserves ready orphan fallback for classic and bootstrapped Herdr', () => {
    const classicCalls = [];
    const herdrCalls = [];

    assert.equal(handlePrewarmOrphanExpiry('classic', false, actions(classicCalls)), 'ready');
    assert.equal(handlePrewarmOrphanExpiry('herdr', true, actions(herdrCalls)), 'ready');
    assert.deepEqual(classicCalls, ['dispose-listener', 'clear-poll', 'delete-session']);
    assert.deepEqual(herdrCalls, ['dispose-listener', 'clear-poll', 'delete-session']);
  });
});
