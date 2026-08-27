/** Contract tests for values duplicated across backend and frontend builds. */
import { describe, it, expect } from 'vitest';
import { SESSION_ID_PATTERN } from '../../lib/constants';
import { SESSION_ID_RE } from '../../../web-ui/src/lib/constants';

describe('backend/frontend constant parity', () => {
  it('SESSION_ID_PATTERN (backend) matches SESSION_ID_RE (frontend)', () => {
    expect(SESSION_ID_PATTERN.source).toBe(SESSION_ID_RE.source);
    expect(SESSION_ID_PATTERN.flags).toBe(SESSION_ID_RE.flags);
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
