/**
 * Property-based fuzz tests for critical input validation paths.
 *
 * Uses fast-check to generate arbitrary inputs and verify that:
 * 1. SESSION_ID_PATTERN correctly rejects all non-matching strings
 * 2. CORS matchesPattern never crashes on arbitrary hostnames/patterns
 * 3. Zod schemas handle malformed input gracefully (no uncaught throws)
 * 4. getMaxSessions returns sensible values for arbitrary env input
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SESSION_ID_PATTERN, REQUEST_ID_PATTERN, getMaxSessions } from '../../lib/constants';
import { TabConfigSchema } from '../../lib/schemas';

// Number of runs — CI fuzz workflow overrides via FAST_CHECK_NUM_RUNS env var
const NUM_RUNS = parseInt(process.env.FAST_CHECK_NUM_RUNS || '1000');

describe('Fuzz: Session ID validation', () => {
  it('accepts only lowercase alphanumeric strings of length 8-24', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const matches = SESSION_ID_PATTERN.test(input);
        if (matches) {
          // If it matched, it MUST be 8-24 chars of [a-z0-9]
          expect(input).toMatch(/^[a-z0-9]{8,24}$/);
        }
        // Pattern must never throw
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects strings with special characters', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[!@#$%^&*<>/\\"'; \n\t]+$/),
        (input) => {
          expect(SESSION_ID_PATTERN.test(input)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects strings outside length bounds', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Too short (1-7 chars)
          fc.stringMatching(/^[a-z0-9]{1,7}$/),
          // Too long (25-50 chars)
          fc.stringMatching(/^[a-z0-9]{25,50}$/),
        ),
        (input) => {
          expect(SESSION_ID_PATTERN.test(input)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Fuzz: Request ID validation', () => {
  it('never crashes on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        // Must not throw
        const result = REQUEST_ID_PATTERN.test(input);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Fuzz: CORS pattern matching', () => {
  // matchesPattern is not exported, so we replicate the logic to fuzz in isolation.
  function matchesPattern(hostname: string, pattern: string): boolean {
    const h = hostname.toLowerCase();
    const p = pattern.toLowerCase();
    if (p.startsWith('.')) {
      return h.endsWith(p);
    }
    return h === p || h.endsWith('.' + p);
  }

  it('never crashes on arbitrary hostname/pattern pairs', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (hostname, pattern) => {
        // Must never throw, regardless of input
        const result = matchesPattern(hostname, pattern);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('dot-prefixed patterns enforce suffix boundary', () => {
    fc.assert(
      fc.property(
        fc.webUrl().map((url) => { try { return new URL(url).hostname; } catch { return 'example.com'; } }),
        fc.constantFrom('.workers.dev', '.example.com', '.test.org'),
        (hostname, pattern) => {
          const result = matchesPattern(hostname, pattern);
          if (result) {
            expect(hostname.toLowerCase()).toContain(pattern.toLowerCase());
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('bare patterns prevent prefix attacks', () => {
    // "evil-example.com" must NOT match "example.com"
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9-]{1,20}$/),
        fc.constantFrom('example.com', 'workers.dev', 'test.org'),
        (prefix, domain) => {
          const attackHostname = prefix + domain; // e.g., "evil-example.com"
          const result = matchesPattern(attackHostname, domain);
          if (result && attackHostname !== domain) {
            // If it matched and isn't exact, it must end with ".domain"
            expect(attackHostname.toLowerCase()).toContain('.' + domain.toLowerCase());
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Fuzz: Zod TabConfigSchema', () => {
  it('never throws on arbitrary objects', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        // safeParse must never throw, even on completely invalid input
        const result = TabConfigSchema.safeParse(input);
        expect(typeof result.success).toBe('boolean');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects objects with invalid tab IDs', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string().filter((s) => !/^[1-6]$/.test(s)),
          command: fc.string({ maxLength: 200 }),
          label: fc.string({ maxLength: 50 }),
        }),
        (input) => {
          const result = TabConfigSchema.safeParse(input);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Fuzz: getMaxSessions', () => {
  it('always returns a finite number (never NaN or Infinity)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.string()),
        fc.record({
          MAX_SESSIONS_USER: fc.oneof(fc.constant(undefined), fc.string()),
          MAX_SESSIONS_ADMIN: fc.oneof(fc.constant(undefined), fc.string()),
        }),
        (role, env) => {
          const result = getMaxSessions(role, env);
          expect(typeof result).toBe('number');
          expect(Number.isFinite(result)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('respects explicit zero values', () => {
    expect(getMaxSessions('user', { MAX_SESSIONS_USER: '0' })).toBe(0);
    expect(getMaxSessions('admin', { MAX_SESSIONS_ADMIN: '0' })).toBe(0);
  });
});
