import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for the simplified pre-warm config used by server.js.
 *
 * Readiness is now first-PTY-output based. The config module only extracts
 * the command name from TAB_CONFIG for logging — no patterns or quiescence.
 */

import { getPrewarmConfig } from '../dist/prewarm-config.js';

describe('getPrewarmConfig (server integration)', () => {
  it('returns command: null when tabConfig is undefined', () => {
    const cfg = getPrewarmConfig(undefined);
    assert.equal(cfg.command, null);
  });

  it('returns command: null when tabConfig has no tab 1', () => {
    const cfg = getPrewarmConfig([{ id: '2', command: 'bash', label: 'Shell' }]);
    assert.equal(cfg.command, null);
  });

  it('returns first token of tab 1 command', () => {
    const cfg = getPrewarmConfig([{ id: '1', command: 'claude --dangerously-skip-permissions', label: 'Claude' }]);
    assert.equal(cfg.command, 'claude');
  });

  it('does not return quiescenceMs or readyPattern', () => {
    const cfg = getPrewarmConfig([{ id: '1', command: 'opencode', label: 'OpenCode' }]);
    assert.equal(cfg.command, 'opencode');
    assert.equal(cfg.quiescenceMs, undefined);
    assert.equal(cfg.readyPattern, undefined);
  });
});
