import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { firstZodError, validateSessionId, maskSecret } from '../../lib/request-helpers';
import { ValidationError } from '../../lib/error-types';

describe('firstZodError', () => {
  it('returns the first issue message', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(firstZodError(result.error)).toContain('expected string, received number');
    }
  });

  it('returns fallback for empty issues array', () => {
    const emptyError = new z.ZodError([]);
    expect(firstZodError(emptyError)).toBe('Validation error');
  });
});

describe('validateSessionId', () => {
  it('accepts valid session IDs', () => {
    expect(() => validateSessionId('abc123de')).not.toThrow();
    expect(() => validateSessionId('a1b2c3d4e5f6a7b8c9d0e1f2')).not.toThrow();
  });

  it('throws ValidationError for invalid IDs', () => {
    expect(() => validateSessionId('INVALID!')).toThrow(ValidationError);
    expect(() => validateSessionId('short')).toThrow(ValidationError);
    expect(() => validateSessionId('')).toThrow(ValidationError);
    expect(() => validateSessionId('ABC-not-lowercase')).toThrow(ValidationError);
  });

  it('throws with correct message', () => {
    expect(() => validateSessionId('!@#$')).toThrow('Invalid session ID format');
  });
});

describe('maskSecret / REQ-SEC-018 AC1 (API responses always return masked values)', () => {
  it('returns undefined for undefined', () => {
    expect(maskSecret(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(maskSecret('')).toBeUndefined();
  });

  it('returns **** for short values', () => {
    expect(maskSecret('ab')).toBe('****');
    expect(maskSecret('abcd')).toBe('****');
  });

  it('masks all but last 4 chars', () => {
    expect(maskSecret('abcdefgh')).toBe('****efgh');
    expect(maskSecret('sk-proj-1234567890')).toBe('****7890');
  });
});
