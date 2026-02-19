import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for agent-aware pre-warm readiness detection.
 *
 * The pre-warm logic starts tab 1's PTY at server boot so the first client
 * connect is instant.  Current readiness = 2 s of PTY silence (quiescence).
 * This works for bash/Claude Code but causes ~10 s delays for TUI agents
 * like OpenCode that produce continuous spinner output during startup.
 *
 * The fix: expose a helper that, given TAB_CONFIG, returns readiness
 * parameters (quiescence threshold and optional ready-pattern regex).
 * The server's readiness loop uses these instead of hard-coded 2 000 ms.
 */

// We test the pure helper extracted from server.js (no PTY / network needed).
// If the import fails the tests fail RED — that's the point of the RED phase.
import { getPrewarmConfig } from '../prewarm-config.js';

describe('getPrewarmConfig', () => {
  describe('when TAB_CONFIG is absent or empty', () => {
    it('returns the default 2000 ms quiescence with no readyPattern', () => {
      const cfg = getPrewarmConfig(undefined);
      assert.equal(cfg.quiescenceMs, 2000);
      assert.equal(cfg.readyPattern, null);
    });

    it('handles an empty array', () => {
      const cfg = getPrewarmConfig([]);
      assert.equal(cfg.quiescenceMs, 2000);
      assert.equal(cfg.readyPattern, null);
    });
  });

  describe('when tab 1 is a shell or Claude Code', () => {
    it('returns default quiescence for bash', () => {
      const cfg = getPrewarmConfig([{ id: '1', command: 'bash', label: 'Terminal' }]);
      assert.equal(cfg.quiescenceMs, 2000);
      assert.equal(cfg.readyPattern, null);
    });

    it('returns default quiescence for cu (claude-unleashed)', () => {
      const cfg = getPrewarmConfig([{ id: '1', command: 'cu', label: 'Claude' }]);
      assert.equal(cfg.quiescenceMs, 2000);
      assert.equal(cfg.readyPattern, null);
    });

    it('returns default quiescence for claude-unleashed', () => {
      const cfg = getPrewarmConfig([
        { id: '1', command: 'claude-unleashed', label: 'Claude' },
      ]);
      assert.equal(cfg.quiescenceMs, 2000);
      assert.equal(cfg.readyPattern, null);
    });
  });

  describe('when tab 1 is opencode', () => {
    it('returns a shorter quiescence (500 ms)', () => {
      const cfg = getPrewarmConfig([
        { id: '1', command: 'opencode', label: 'OpenCode' },
      ]);
      assert.equal(cfg.quiescenceMs, 500);
    });

    it('provides a readyPattern that matches OpenCode prompt output', () => {
      const cfg = getPrewarmConfig([
        { id: '1', command: 'opencode', label: 'OpenCode' },
      ]);
      assert.notEqual(cfg.readyPattern, null);
      // OpenCode's Bubble Tea TUI shows a ">" prompt when ready
      assert.ok(cfg.readyPattern.test('>'), 'should match ">" prompt');
    });
  });

  describe('when tab 1 is another TUI agent', () => {
    it('returns shorter quiescence for gemini', () => {
      const cfg = getPrewarmConfig([
        { id: '1', command: 'gemini', label: 'Gemini' },
      ]);
      assert.equal(cfg.quiescenceMs, 500);
    });

    it('returns shorter quiescence for codex', () => {
      const cfg = getPrewarmConfig([
        { id: '1', command: 'codex', label: 'Codex' },
      ]);
      assert.equal(cfg.quiescenceMs, 500);
    });
  });

  describe('ignores non-tab-1 entries', () => {
    it('only looks at tab with id "1"', () => {
      const cfg = getPrewarmConfig([
        { id: '2', command: 'opencode', label: 'OpenCode' },
        { id: '3', command: 'htop', label: 'Monitor' },
      ]);
      // No tab 1 → defaults
      assert.equal(cfg.quiescenceMs, 2000);
      assert.equal(cfg.readyPattern, null);
    });
  });
});
