/** Contract tests for values duplicated across backend and frontend builds. */
import { describe, it, expect } from 'vitest';
import { SESSION_ID_PATTERN } from '../../lib/constants';

describe('backend/frontend constant parity', () => {
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
