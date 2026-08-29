import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { handlePrewarmOrphanExpiry } from '../dist/prewarm-readiness.js';

function actions(calls) {
  return {
    disposeDataListener: () => calls.push('dispose-listener'),
    clearReadinessPoll: () => calls.push('clear-poll'),
    deleteSession: () => calls.push('delete-session'),
  };
}

describe('pre-warm orphan expiry', () => {
  it('REQ-TERM-035 AC5: orphan expiry terminates unbootstrapped Herdr after cleanup', () => {
    const moduleUrl = new URL('../dist/prewarm-readiness.js', import.meta.url).href;
    const script = `
      import { writeSync } from 'node:fs';
      import { handlePrewarmOrphanExpiry } from ${JSON.stringify(moduleUrl)};
      handlePrewarmOrphanExpiry('herdr', false, {
        disposeDataListener: () => writeSync(1, 'dispose-listener\\n'),
        clearReadinessPoll: () => writeSync(1, 'clear-poll\\n'),
        deleteSession: () => writeSync(1, 'delete-session\\n'),
      });
      writeSync(1, 'unreachable\\n');
    `;

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.stdout.trim().split('\n'), ['dispose-listener', 'clear-poll', 'delete-session']);
  });

  it('preserves ready orphan fallback for classic and bootstrapped Herdr', () => {
    const classicCalls = [];
    const herdrCalls = [];

    assert.equal(handlePrewarmOrphanExpiry('classic', false, actions(classicCalls)), 'ready');
    assert.equal(handlePrewarmOrphanExpiry('herdr', true, actions(herdrCalls)), 'ready');
    assert.deepEqual(classicCalls, ['dispose-listener', 'clear-poll', 'delete-session']);
    assert.deepEqual(herdrCalls, ['dispose-listener', 'clear-poll', 'delete-session']);
  });
});
