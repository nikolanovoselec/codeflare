import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handlePrewarmOrphanExpiry } from '../dist/prewarm-readiness.js';

function actions(calls) {
  return {
    disposeDataListener: () => calls.push('dispose-listener'),
    clearReadinessPoll: () => calls.push('clear-poll'),
    deleteSession: () => calls.push('delete-session'),
    terminateHost: () => calls.push('terminate-host'),
  };
}

describe('pre-warm orphan expiry', () => {
  it('REQ-TERM-035 AC5: orphan expiry terminates unbootstrapped Herdr after cleanup', () => {
    const calls = [];

    const outcome = handlePrewarmOrphanExpiry('herdr', false, actions(calls));

    assert.equal(outcome, 'bootstrap_failed');
    assert.deepEqual(calls, ['dispose-listener', 'clear-poll', 'delete-session', 'terminate-host']);
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
