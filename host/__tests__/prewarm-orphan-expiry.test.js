import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handlePrewarmOrphanExpiry } from '../dist/prewarm-readiness.js';

function actions(calls) {
  return {
    disposeDataListener: () => calls.push('dispose-listener'),
    clearReadinessPoll: () => calls.push('clear-poll'),
    deleteSession: () => calls.push('delete-session'),
  };
}

describe('pre-warm orphan expiry', () => {
  it('REQ-TERM-035 AC2: orphan expiry fails unbootstrapped Herdr after cleanup', () => {
    const calls = [];

    const outcome = handlePrewarmOrphanExpiry('herdr', false, actions(calls));

    assert.equal(outcome, 'bootstrap_failed');
    assert.deepEqual(calls, ['dispose-listener', 'clear-poll', 'delete-session']);
  });

  it('preserves ready orphan fallback for classic and bootstrapped Herdr', () => {
    assert.equal(handlePrewarmOrphanExpiry('classic', false, actions([])), 'ready');
    assert.equal(handlePrewarmOrphanExpiry('herdr', true, actions([])), 'ready');
  });
});
