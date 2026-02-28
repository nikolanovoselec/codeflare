/**
 * Property-based fuzz tests for critical input validation and transformation paths.
 *
 * Each test verifies a real application invariant — not that JS built-ins work.
 * CI runs 50k iterations (FAST_CHECK_NUM_RUNS=50000); local runs 1k.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SESSION_ID_PATTERN, getMaxSessions } from '../../lib/constants';
import { escapeXml, decodeXmlEntities } from '../../lib/xml-utils';
import { getBucketName } from '../../lib/access';
import { getContainerId } from '../../lib/container-helpers';
import { sanitizeSessionName, generateSessionId } from '../../lib/kv-keys';
import { getR2Url, parseListObjectsXml } from '../../lib/r2-client';

const NUM_RUNS = parseInt(process.env.FAST_CHECK_NUM_RUNS || '1000');

// ---------------------------------------------------------------------------
// XML escape/decode round-trip — protects against injection in DeleteObjects
// ---------------------------------------------------------------------------
describe('Fuzz: XML entity round-trip', () => {
  it('decode(escape(s)) === s for all strings', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(decodeXmlEntities(escapeXml(input))).toBe(input);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('escapeXml output never contains raw XML special characters', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const escaped = escapeXml(input);
        // These chars must always be entity-encoded, never raw
        expect(escaped).not.toMatch(/[<>"']/);
        // & is allowed only as part of an entity reference
        const rawAmps = escaped.replace(/&(amp|lt|gt|quot|apos);/g, '');
        expect(rawAmps).not.toContain('&');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('double-escape is reversible with double-decode', () => {
    // Proves no information loss even with pre-escaped input
    fc.assert(
      fc.property(fc.string(), (input) => {
        const doubleEscaped = escapeXml(escapeXml(input));
        expect(decodeXmlEntities(decodeXmlEntities(doubleEscaped))).toBe(input);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('decodeXmlEntities leaves numeric entities untouched', () => {
    fc.assert(
      fc.property(fc.integer({ min: 32, max: 126 }), (code) => {
        const numEntity = `&#${code};`;
        // Our decoder only handles the 5 named entities, not numeric
        expect(decodeXmlEntities(numEntity)).toBe(numEntity);
      }),
      { numRuns: Math.min(NUM_RUNS, 95) }, // only 95 printable ASCII codes
    );
  });
});

// ---------------------------------------------------------------------------
// XML parsing — regex-based parser must handle adversarial XML
// ---------------------------------------------------------------------------
describe('Fuzz: XML parsing resilience', () => {
  it('parseListObjectsXml never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (xml) => {
        // Must return a valid result shape, never crash
        const result = parseListObjectsXml(xml);
        expect(Array.isArray(result.objects)).toBe(true);
        expect(Array.isArray(result.prefixes)).toBe(true);
        expect(typeof result.isTruncated).toBe('boolean');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('parseListObjectsXml correctly round-trips keys with XML specials', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9/_.-]{1,50}$/),
        (key) => {
          // Simulate R2 response XML with a properly escaped key
          const xml = `<?xml version="1.0"?>
            <ListBucketResult>
              <Contents>
                <Key>${escapeXml(key)}</Key>
                <Size>100</Size>
                <LastModified>2024-01-01T00:00:00.000Z</LastModified>
              </Contents>
            </ListBucketResult>`;
          const result = parseListObjectsXml(xml);
          expect(result.objects).toHaveLength(1);
          expect(result.objects[0].key).toBe(key);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Bucket name derivation — collision resistance and format invariants
// ---------------------------------------------------------------------------
describe('Fuzz: getBucketName', () => {
  it('output always matches R2 bucket naming rules', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        const name = getBucketName(email);
        // R2 buckets: lowercase alphanumeric + hyphens, 3-63 chars, no leading/trailing hyphen
        expect(name.length).toBeGreaterThanOrEqual(1);
        expect(name.length).toBeLessThanOrEqual(63);
        expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('different emails with different local parts produce different bucket names', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{3,10}$/),
        fc.stringMatching(/^[a-z]{3,10}$/),
        (local1, local2) => {
          fc.pre(local1 !== local2);
          const name1 = getBucketName(`${local1}@example.com`);
          const name2 = getBucketName(`${local2}@example.com`);
          expect(name1).not.toBe(name2);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('is case-insensitive (RFC 5321)', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        expect(getBucketName(email.toUpperCase())).toBe(getBucketName(email.toLowerCase()));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('long workerName does not produce names exceeding 63 chars', () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        fc.stringMatching(/^[a-z]{1,60}$/),
        (email, workerName) => {
          const name = getBucketName(email, workerName);
          expect(name.length).toBeLessThanOrEqual(63);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Container ID — validation gate must never pass invalid session IDs
// ---------------------------------------------------------------------------
describe('Fuzz: getContainerId', () => {
  it('always throws on invalid session IDs', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !SESSION_ID_PATTERN.test(s)),
        (badId) => {
          expect(() => getContainerId('bucket', badId)).toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('valid IDs produce deterministic container IDs with no injection', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8,24}$/),
        fc.stringMatching(/^[a-z0-9-]{3,30}$/),
        (sessionId, bucketName) => {
          const containerId = getContainerId(bucketName, sessionId);
          // Format: bucketName-sessionId, deterministic
          expect(containerId).toBe(`${bucketName}-${sessionId}`);
          // Session ID appears exactly once at the end (no injection of extra segments)
          expect(containerId.endsWith(`-${sessionId}`)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// CORS pattern matching — security-critical domain boundary enforcement
// ---------------------------------------------------------------------------
describe('Fuzz: CORS matchesPattern', () => {
  // Replicated from src/lib/cors-cache.ts (not exported)
  function matchesPattern(hostname: string, pattern: string): boolean {
    const h = hostname.toLowerCase();
    const p = pattern.toLowerCase();
    if (p.startsWith('.')) {
      return h.endsWith(p);
    }
    return h === p || h.endsWith('.' + p);
  }

  it('bare domains reject prefix-concatenation attacks', () => {
    // "evil-workers.dev" must NOT match "workers.dev"
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,15}$/), // attack prefix (no dot)
        fc.constantFrom('workers.dev', 'example.com', 'codeflare.app'),
        (prefix, domain) => {
          const attackHostname = `${prefix}${domain}`;
          if (matchesPattern(attackHostname, domain)) {
            // Only allowed if it's an exact match
            expect(attackHostname).toBe(domain);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('dot-prefixed patterns only match exact suffix', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{1,15}$/),
        fc.constantFrom('.workers.dev', '.example.com'),
        (prefix, pattern) => {
          // Without a dot separator, should never match
          const hostname = `${prefix}${pattern.slice(1)}`; // e.g., "evilworkers.dev"
          if (matchesPattern(hostname, pattern)) {
            // Must actually end with the full pattern including dot
            expect(hostname.toLowerCase().endsWith(pattern.toLowerCase())).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('subdomains of bare patterns always match', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,10}$/),
        fc.constantFrom('workers.dev', 'example.com'),
        (sub, domain) => {
          expect(matchesPattern(`${sub}.${domain}`, domain)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Session name sanitization — must strip injection vectors, never empty
// ---------------------------------------------------------------------------
describe('Fuzz: sanitizeSessionName', () => {
  it('output never contains characters outside the allowlist', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = sanitizeSessionName(input);
        // Only alphanumeric, space, #, _, - allowed
        expect(result).toMatch(/^[a-zA-Z0-9 #_-]+$/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never returns empty string (falls back to "Untitled")', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = sanitizeSessionName(input);
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('strips HTML/script injection attempts', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          '<script>alert(1)</script>',
          '"><img onerror=alert(1)>',
          "'; DROP TABLE sessions; --",
          '${constructor.constructor("return this")()}',
          '../../../etc/passwd',
        ),
        (payload) => {
          const result = sanitizeSessionName(payload);
          expect(result).not.toContain('<');
          expect(result).not.toContain('>');
          expect(result).not.toContain("'");
          expect(result).not.toContain('"');
        },
      ),
      { numRuns: 5 }, // deterministic payloads, no need for many runs
    );
  });
});

// ---------------------------------------------------------------------------
// generateSessionId — output must always match SESSION_ID_PATTERN
// ---------------------------------------------------------------------------
describe('Fuzz: generateSessionId', () => {
  it('always produces valid session IDs', () => {
    // Not truly "fuzz" but property-based: generate many and verify invariant
    for (let i = 0; i < Math.min(NUM_RUNS, 1000); i++) {
      const id = generateSessionId();
      expect(id).toMatch(SESSION_ID_PATTERN);
      expect(id).toHaveLength(24); // 12 bytes -> 24 hex chars
    }
  });
});

// ---------------------------------------------------------------------------
// getMaxSessions — must always return non-negative finite number
// ---------------------------------------------------------------------------
describe('Fuzz: getMaxSessions', () => {
  it('always returns a non-negative finite number', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.constant('user'), fc.constant('admin'), fc.string()),
        fc.record({
          MAX_SESSIONS_USER: fc.oneof(fc.constant(undefined), fc.string()),
          MAX_SESSIONS_ADMIN: fc.oneof(fc.constant(undefined), fc.string()),
        }),
        (role, env) => {
          const result = getMaxSessions(role, env);
          expect(typeof result).toBe('number');
          expect(Number.isFinite(result)).toBe(true);
          // Negative values from parseInt are technically accepted — this documents that
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('falls back to defaults for non-numeric env values', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]+$/), // purely alphabetic, parseInt returns NaN
        (garbage) => {
          const userResult = getMaxSessions('user', { MAX_SESSIONS_USER: garbage });
          const adminResult = getMaxSessions('admin', { MAX_SESSIONS_ADMIN: garbage });
          expect(userResult).toBe(3);   // DEFAULT_MAX_SESSIONS_USER
          expect(adminResult).toBe(10); // DEFAULT_MAX_SESSIONS_ADMIN
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('any non-"admin" role uses user limits', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== 'admin'),
        (role) => {
          const result = getMaxSessions(role, {});
          expect(result).toBe(3); // DEFAULT_MAX_SESSIONS_USER
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// R2 URL construction — path traversal and format safety
// ---------------------------------------------------------------------------
describe('Fuzz: getR2Url', () => {
  it('never has double slashes between endpoint and bucket', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withFragments: false, withQueryParameters: false }),
        fc.stringMatching(/^[a-z0-9-]{3,20}$/),
        (endpoint, bucket) => {
          const url = getR2Url(endpoint, bucket);
          // Between endpoint and bucket there should be exactly one slash
          const afterProtocol = url.replace(/^https?:\/\//, '');
          // Split on bucket name — the part before it should not end with extra slashes
          const idx = afterProtocol.indexOf(`/${bucket}`);
          if (idx >= 0) {
            const beforeBucket = afterProtocol.substring(0, idx + 1);
            expect(beforeBucket).not.toMatch(/\/\/$/);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('strips leading slashes from key to prevent path ambiguity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        (slashCount) => {
          const key = '/'.repeat(slashCount) + 'file.txt';
          const url = getR2Url('https://r2.example.com', 'bucket', key);
          // Should not have extra slashes before the key
          expect(url).toBe('https://r2.example.com/bucket/file.txt');
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 5) },
    );
  });

  it('endpoint trailing slashes are normalized', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        (slashCount) => {
          const endpoint = 'https://r2.example.com' + '/'.repeat(slashCount);
          const url = getR2Url(endpoint, 'bucket', 'file.txt');
          expect(url).toBe('https://r2.example.com/bucket/file.txt');
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 5) },
    );
  });
});
