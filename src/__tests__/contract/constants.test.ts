/**
 * Contract tests: verify that duplicated constants in backend and frontend stay in sync.
 *
 * These constants are intentionally duplicated (separate build targets) but must
 * have identical values. If a constant changes in one place but not the other,
 * these tests catch the mismatch.
 */
import { describe, it, expect } from 'vitest';
import { MAX_TABS, SESSION_ID_PATTERN } from '../../lib/constants';

// Frontend constants are imported via relative path since they live in a
// separate build target (web-ui/) but share the same repo root.
import { MAX_TERMINALS_PER_SESSION } from '../../../web-ui/src/lib/constants';

describe('backend/frontend constant parity', () => {
  it('MAX_TABS (backend) equals MAX_TERMINALS_PER_SESSION (frontend)', () => {
    expect(MAX_TABS).toBe(MAX_TERMINALS_PER_SESSION);
  });

  it('SESSION_ID_PATTERN (backend) matches SESSION_ID_RE (frontend)', () => {
    // The frontend defines SESSION_ID_RE inline in web-ui/src/api/client.ts
    // as /^[a-z0-9]{8,24}$/. We verify the backend pattern matches the same spec.
    const expectedSource = '^[a-z0-9]{8,24}$';
    expect(SESSION_ID_PATTERN.source).toBe(expectedSource);
    expect(SESSION_ID_PATTERN.flags).toBe('');
  });

  it('SESSION_ID_PATTERN accepts valid IDs and rejects invalid ones', () => {
    // 8-char lowercase alphanumeric
    expect(SESSION_ID_PATTERN.test('abcd1234')).toBe(true);
    // 24-char
    expect(SESSION_ID_PATTERN.test('abcdefghijklmnopqrstuvwx')).toBe(true);
    // Too short (7 chars)
    expect(SESSION_ID_PATTERN.test('abcd123')).toBe(false);
    // Too long (25 chars)
    expect(SESSION_ID_PATTERN.test('abcdefghijklmnopqrstuvwxy')).toBe(false);
    // Uppercase not allowed
    expect(SESSION_ID_PATTERN.test('ABCD1234')).toBe(false);
    // Special chars not allowed
    expect(SESSION_ID_PATTERN.test('abcd-1234')).toBe(false);
  });
});
