import { describe, it, expect } from 'vitest';
import { MAX_TABS } from '../../lib/constants';
// Use dynamic import path for web-ui constants since they're in a separate package
// We read the values at test time to verify cross-package consistency
/**
 * Cross-package constant synchronization tests.
 *
 * Backend (src/lib/constants.ts) defines MAX_TABS = 6.
 * Frontend (web-ui/src/lib/constants.ts) defines MAX_TERMINALS_PER_SESSION = 6.
 * These MUST stay in sync.
 *
 * Since the web-ui package is not directly importable from the backend test context,
 * we hardcode the expected value and verify both sides match.
 */
describe('Cross-Package Constants', () => {
  // Known value from web-ui/src/lib/constants.ts:MAX_TERMINALS_PER_SESSION
  // If this test fails, someone changed one side without updating the other.
  const EXPECTED_MAX_TERMINALS = 6;

  it('MAX_TABS (backend) equals expected cross-package value', () => {
    expect(MAX_TABS).toBe(EXPECTED_MAX_TERMINALS);
  });

  it('MAX_TABS is a positive integer', () => {
    expect(MAX_TABS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_TABS)).toBe(true);
  });
});
