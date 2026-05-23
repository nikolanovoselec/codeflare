import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for pre-warm readiness configuration.
 *
 * Readiness is now detected by first PTY output — no more agent-specific
 * regex patterns or quiescence thresholds. The config just extracts the
 * command from TAB_CONFIG for logging purposes.
 */

import { getPrewarmConfig } from '../dist/prewarm-config.js';

// REQ-SESSION-015 (pre-warm config feeds the readiness gate; getPrewarmConfig extracts the command for logging the pre-warm origin)
describe('getPrewarmConfig / REQ-SESSION-015 (tab-1 pre-warm command feeds readiness gate)', () => {
  describe('when TAB_CONFIG is absent or empty', () => {
    // REQ-SESSION-015 (no TAB_CONFIG -> no pre-warm command; readiness gate uses default path)
    it('returns null command for undefined', () => {
      const cfg = getPrewarmConfig(undefined);
      assert.equal(cfg.command, null);
    });

    // REQ-SESSION-015 (empty TAB_CONFIG -> null command; readiness gate falls back to default shell)
    it('returns null command for empty array', () => {
      const cfg = getPrewarmConfig([]);
      assert.equal(cfg.command, null);
    });
  });

  describe('when tab 1 has a command / REQ-AGENT-003 (agent CLI auto-started in tab 1) / REQ-TERM-005 (pre-warm pty)', () => {
    // REQ-SESSION-015 AC1 (pre-warm tab 1 PTY; command is logged so the prewarm origin is traceable)
    it('extracts first token from command string', () => {
      const cfg = getPrewarmConfig([{ id: '1', command: 'claude --dangerously-skip-permissions', label: 'Claude' }]);
      assert.equal(cfg.command, 'claude');
    });

    // REQ-SESSION-015 AC1 (multi-agent pre-warm support)
    it('extracts command for opencode', () => {
      const cfg = getPrewarmConfig([{ id: '1', command: 'opencode', label: 'OpenCode' }]);
      assert.equal(cfg.command, 'opencode');
    });

    // REQ-SESSION-015 AC1 (bash fallback pre-warm)
    it('extracts command for bash', () => {
      const cfg = getPrewarmConfig([{ id: '1', command: 'bash', label: 'Terminal' }]);
      assert.equal(cfg.command, 'bash');
    });
  });

  describe('ignores non-tab-1 entries', () => {
    // REQ-SESSION-015 AC1 (pre-warm explicitly gated on tab 1; other tab ids are lazy)
    it('only looks at tab with id "1"', () => {
      const cfg = getPrewarmConfig([
        { id: '2', command: 'opencode', label: 'OpenCode' },
        { id: '3', command: 'htop', label: 'Monitor' },
      ]);
      assert.equal(cfg.command, null);
    });
  });
});
