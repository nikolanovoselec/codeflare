import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for the quiescence-vs-pattern readiness decision.
 *
 * When a readyPattern is configured (e.g. /╭/ for cu/claude-unleashed),
 * the quiescence fallback must be disabled — otherwise 500ms of startup
 * silence fires "ready" before the TUI actually renders.
 */

import { shouldUseQuiescence } from '../prewarm-config.js';

describe('shouldUseQuiescence', () => {
  it('returns true when no readyPattern is configured (shell commands)', () => {
    assert.equal(shouldUseQuiescence(null), true);
  });

  it('returns true for undefined readyPattern', () => {
    assert.equal(shouldUseQuiescence(undefined), true);
  });

  it('returns false when readyPattern is /╭/ (cu/claude-unleashed)', () => {
    assert.equal(shouldUseQuiescence(/╭/), false);
  });

  it('returns false when readyPattern is />/ (opencode)', () => {
    assert.equal(shouldUseQuiescence(/>/), false);
  });
});
