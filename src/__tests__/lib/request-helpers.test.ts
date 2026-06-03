import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { firstZodError, validateSessionId, maskSecret, parseJsonBody } from '../../lib/request-helpers';
import { ValidationError } from '../../lib/error-types';

function createJsonContext(body: unknown, reject = false) {
  return {
    req: {
      json: async () => {
        if (reject) throw new SyntaxError('Unexpected token');
        return body;
      },
    },
  } as any;
}

describe('parseJsonBody', () => {
  it('returns the raw body unchecked when no schema is given', async () => {
    const c = createJsonContext({ anything: 1, extra: 'x' });
    const result = await parseJsonBody(c);
    expect(result).toEqual({ anything: 1, extra: 'x' });
  });

  it('throws ValidationError on malformed JSON when no schema is given', async () => {
    const c = createJsonContext(undefined, true);
    await expect(parseJsonBody(c)).rejects.toThrow(ValidationError);
    await expect(parseJsonBody(c)).rejects.toThrow('Invalid JSON body');
  });

  it('returns the validated typed value when a schema is given and the body is valid', async () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const c = createJsonContext({ name: 'ada', age: 36 });
    const result = await parseJsonBody(c, schema);
    expect(result).toEqual({ name: 'ada', age: 36 });
  });

  it('throws the validation error when a schema is given and the body is invalid', async () => {
    const schema = z.object({ name: z.string() });
    const c = createJsonContext({ name: 42 });
    await expect(parseJsonBody(c, schema)).rejects.toThrow(ValidationError);
    await expect(parseJsonBody(c, schema)).rejects.toThrow('expected string, received number');
  });

  it('throws ValidationError on malformed JSON before schema validation runs', async () => {
    const schema = z.object({ name: z.string() });
    const c = createJsonContext(undefined, true);
    await expect(parseJsonBody(c, schema)).rejects.toThrow('Invalid JSON body');
  });
});

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
