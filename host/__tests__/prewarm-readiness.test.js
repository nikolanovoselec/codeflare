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

describe('getPrewarmConfig', () => {
  describe('when TAB_CONFIG is absent or empty', () => {
    it('returns null command for undefined', () => {
      const cfg = getPrewarmConfig(undefined);
      assert.equal(cfg.command, null);
    });

    it('returns null command for empty array', () => {
      const cfg = getPrewarmConfig([]);
      assert.equal(cfg.command, null);
    });
  });

  describe('when tab 1 has a command', () => {
    it('extracts the command name', () => {
      const cfg = getPrewarmConfig([{ id: '1', command: 'cu', label: 'Claude' }]);
      assert.equal(cfg.command, 'cu');
    });

    it('extracts first token from compound commands', () => {
      const cfg = getPrewarmConfig([{ id: '1', command: 'cu --silent', label: 'Claude' }]);
      assert.equal(cfg.command, 'cu');
    });

    it('extracts command for opencode', () => {
      const cfg = getPrewarmConfig([{ id: '1', command: 'opencode', label: 'OpenCode' }]);
      assert.equal(cfg.command, 'opencode');
    });

    it('extracts command for bash', () => {
      const cfg = getPrewarmConfig([{ id: '1', command: 'bash', label: 'Terminal' }]);
      assert.equal(cfg.command, 'bash');
    });
  });

  describe('ignores non-tab-1 entries', () => {
    it('only looks at tab with id "1"', () => {
      const cfg = getPrewarmConfig([
        { id: '2', command: 'opencode', label: 'OpenCode' },
        { id: '3', command: 'htop', label: 'Monitor' },
      ]);
      assert.equal(cfg.command, null);
    });
  });
});
