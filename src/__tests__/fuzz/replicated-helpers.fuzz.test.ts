/**
 * Property-based fuzz tests for critical input validation and transformation paths.
 *
 * Each test verifies a real application invariant - not that JS built-ins work.
 * CI runs 50k iterations (FAST_CHECK_NUM_RUNS=50000); local runs 1k.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { escapeXml, decodeXmlEntities } from '../../lib/xml-utils';
import { getBucketName } from '../../lib/access';
import { toError, toErrorMessage, AppError, NotFoundError, ValidationError } from '../../lib/error-types';
import { getDefaultTabConfig } from '../../lib/agent-config';
import { isBucketNameResponse } from '../../lib/type-guards';
import { isOnboardingLandingPageActive } from '../../lib/onboarding';

const NUM_RUNS = parseInt(process.env.FAST_CHECK_NUM_RUNS || '1000');

// ---------------------------------------------------------------------------
// XML escape/decode round-trip - protects against injection in DeleteObjects
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// normalizeEmail (replicated from access.ts:12-14)
// ---------------------------------------------------------------------------

/** Replicated from src/lib/access.ts - not exported */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

describe('Fuzz: normalizeEmail (replicated)', () => {
  it('is idempotent: normalizeEmail(normalizeEmail(s)) === normalizeEmail(s)', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(normalizeEmail(normalizeEmail(input))).toBe(normalizeEmail(input));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('output is always lowercase and trimmed', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = normalizeEmail(input);
        expect(result).toBe(result.toLowerCase());
        expect(result).toBe(result.trim());
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('consistent with getBucketName: getBucketName(normalizeEmail(e)) === getBucketName(e)', () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        (email) => {
          expect(getBucketName(normalizeEmail(email))).toBe(getBucketName(email));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// getCookieValue (replicated from access.ts:26-36)
// ---------------------------------------------------------------------------

/** Replicated from src/lib/access.ts - not exported */
function getCookieValue(cookieHeader: string | null, key: string): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const [rawKey, ...rest] = pair.trim().split('=');
    if (rawKey === key) {
      return rest.join('=') || null;
    }
  }
  return null;
}

describe('Fuzz: getCookieValue (replicated)', () => {
  it('returns null for null header', () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        expect(getCookieValue(null, key)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns null when key not present', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes('=')),
        fc.string().filter((s) => !s.includes('=') && !s.includes(';')),
        (header, key) => {
          const prefixed = `other_key=value; another=val`;
          if (key !== 'other_key' && key !== 'another') {
            expect(getCookieValue(prefixed, key)).toBeNull();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('handles = in values: token=abc=def extracts abc=def', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !/[;=\s]/.test(s)),
        fc.string({ minLength: 1 }).filter((s) => !s.includes(';') && s === s.trim() && s.length > 0),
        (key, value) => {
          const cookie = `${key}=${value}`;
          expect(getCookieValue(cookie, key)).toBe(value);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws on arbitrary cookie strings', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (header, key) => {
        expect(() => getCookieValue(header, key)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('round-trip: set cookie key=value, extract key returns value', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !/[;=\s]/.test(s)),
        fc.string({ minLength: 1 }).filter((s) => !s.includes(';') && s === s.trim() && s.length > 0),
        (key, value) => {
          const cookie = `prefix=abc; ${key}=${value}; suffix=xyz`;
          expect(getCookieValue(cookie, key)).toBe(value);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// toError and toErrorMessage
// ---------------------------------------------------------------------------
describe('Fuzz: toError and toErrorMessage', () => {
  it('toError always returns Error instance for any input', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(toError(input)).toBeInstanceOf(Error);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('toErrorMessage always returns string for any input', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(typeof toErrorMessage(input)).toBe('string');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('for Error instances: toError(e) === e (identity)', () => {
    fc.assert(
      fc.property(fc.string(), (msg) => {
        const e = new Error(msg);
        expect(toError(e)).toBe(e);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('for non-Error: toErrorMessage(x) === String(x)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (input) => {
          expect(toErrorMessage(input)).toBe(String(input));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// AppError hierarchy
// ---------------------------------------------------------------------------
describe('Fuzz: AppError hierarchy', () => {
  it('AppError.toJSON() always has error and code string fields', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer(), fc.string(), (code, status, msg) => {
        const err = new AppError(code, status, msg);
        const json = err.toJSON();
        expect(typeof json.error).toBe('string');
        expect(typeof json.code).toBe('string');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('NotFoundError toJSON error contains "not found"', () => {
    fc.assert(
      fc.property(fc.string(), (resource) => {
        const err = new NotFoundError(resource);
        const json = err.toJSON();
        expect(json.error.toLowerCase()).toContain('not found');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('constructors never throw for any string inputs', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(() => new AppError(a, 500, b)).not.toThrow();
        expect(() => new NotFoundError(a, b)).not.toThrow();
        expect(() => new ValidationError(a)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// isBucketNameResponse type guard
// ---------------------------------------------------------------------------
describe('Fuzz: isBucketNameResponse type guard', () => {
  it('returns true only for objects with bucketName that is string or null', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constant(null)),
        (bucketName) => {
          expect(isBucketNameResponse({ bucketName })).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns false for null, undefined, arrays, primitives, missing field', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.array(fc.anything()),
          fc.integer(),
          fc.string(),
          fc.boolean(),
          fc.record({ notBucketName: fc.string() }),
        ),
        (input) => {
          expect(isBucketNameResponse(input)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws for ANY input', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(() => isBucketNameResponse(input)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// isOnboardingLandingPageActive
// ---------------------------------------------------------------------------
describe('Fuzz: isOnboardingLandingPageActive', () => {
  it('returns true only for "active" (case-insensitive, trimmed)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('active', 'ACTIVE', 'Active', ' active ', '  ACTIVE  '),
        (value) => {
          expect(isOnboardingLandingPageActive(value)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns false for undefined, empty string, random strings', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.trim().toLowerCase() !== 'active'),
        (value) => {
          expect(isOnboardingLandingPageActive(value)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constant(undefined)),
        (value) => {
          expect(() => isOnboardingLandingPageActive(value)).not.toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// getDefaultTabConfig
// ---------------------------------------------------------------------------
describe('Fuzz: getDefaultTabConfig', () => {
  const VALID_AGENT_TYPES = ['claude-code', 'codex', 'copilot', 'antigravity', 'opencode', 'bash'] as const;

  it('always returns one primary outer terminal configuration', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_AGENT_TYPES),
        (agentType) => {
          const tabs = getDefaultTabConfig(agentType);
          expect(tabs).toHaveLength(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('uses only internal terminal ID "1"', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_AGENT_TYPES),
        (agentType) => {
          const tabs = getDefaultTabConfig(agentType);
          tabs.forEach((tab, i) => {
            expect(tab.id).toBe(String(i + 1));
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('tab 1 has non-empty command for all agent types except bash', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_AGENT_TYPES),
        (agentType) => {
          const tabs = getDefaultTabConfig(agentType);
          if (agentType === 'bash') {
            expect(tabs[0].command).toBe('');
          } else {
            expect(tabs[0].command.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// extractTag (replicated from r2-client.ts:153-156)
// ---------------------------------------------------------------------------

/** Replicated from src/lib/r2-client.ts - not exported */
function extractTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? decodeXmlEntities(match[1]) : undefined;
}

describe('Fuzz: extractTag (replicated)', () => {
  it('returns undefined when tag not present', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes('<')),
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]*$/),
        (block, tag) => {
          expect(extractTag(block, tag)).toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('round-trip with escapeXml: extractTag wrapping escapeXml recovers value', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes('<')),
        (value) => {
          const xml = `<Key>${escapeXml(value)}</Key>`;
          expect(extractTag(xml, 'Key')).toBe(value);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws for valid XML tag names', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]*$/),
        (block, tag) => {
          expect(() => extractTag(block, tag)).not.toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// isRetryable (replicated from r2-admin.ts:109-111)
// ---------------------------------------------------------------------------

/** Replicated from src/lib/r2-admin.ts - not exported */
function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}

describe('Fuzz: isRetryable (replicated)', () => {
  it('true for 500+ and 429', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 500, max: 599 }),
          fc.constant(429),
        ),
        (status) => {
          expect(isRetryable(status)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('false for all 2xx, 3xx, 4xx (except 429)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 499 }).filter((s) => s !== 429),
        (status) => {
          expect(isRetryable(status)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
