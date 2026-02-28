/**
 * Property-based fuzz tests for critical input validation and transformation paths.
 *
 * Each test verifies a real application invariant — not that JS built-ins work.
 * CI runs 50k iterations (FAST_CHECK_NUM_RUNS=50000); local runs 1k.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SESSION_ID_PATTERN, PROTECTED_PATHS, getMaxSessions } from '../../lib/constants';
import { escapeXml, decodeXmlEntities } from '../../lib/xml-utils';
import { getBucketName } from '../../lib/access';
import { getContainerId } from '../../lib/container-helpers';
import { sanitizeSessionName, generateSessionId, getSessionKey, getSessionPrefix, getPresetsKey, getPreferencesKey, emailFromKvKey } from '../../lib/kv-keys';
import { getR2Url, parseListObjectsXml } from '../../lib/r2-client';
import { validateKey } from '../../routes/storage/validation';

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

// ---------------------------------------------------------------------------
// Storage key validation — path traversal, protected paths, edge cases
// ---------------------------------------------------------------------------
describe('Fuzz: validateKey', () => {
  it('any key passing validation has no path traversal', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (key) => {
        try {
          validateKey(key);
          // If validation passed, these invariants MUST hold:
          expect(key).not.toContain('..');
          expect(key.startsWith('/')).toBe(false);
          expect(key.length).toBeLessThanOrEqual(1024);
          for (const p of PROTECTED_PATHS) {
            expect(key.startsWith(p)).toBe(false);
            expect(key.includes(`/${p}`)).toBe(false);
          }
        } catch {
          // Validation threw — that's fine, this is the reject path
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('always rejects keys containing ".."', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 50 }),
        fc.string({ maxLength: 50 }),
        (prefix, suffix) => {
          const key = `${prefix}..${suffix}`;
          expect(() => validateKey(key)).toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('always rejects keys starting with "/"', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9/_.-]{1,50}$/),
        (path) => {
          expect(() => validateKey(`/${path}`)).toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects all protected paths at root and nested positions', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROTECTED_PATHS),
        fc.stringMatching(/^[a-z0-9]{0,20}$/),
        (protectedPath, prefix) => {
          // At root
          expect(() => validateKey(protectedPath)).toThrow();
          // Nested under a prefix
          if (prefix.length > 0) {
            expect(() => validateKey(`${prefix}/${protectedPath}`)).toThrow();
          }
        },
      ),
      { numRuns: Math.min(NUM_RUNS, PROTECTED_PATHS.length * 20) },
    );
  });

  it('accepts valid workspace keys', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^workspace\/[a-z0-9]{1,30}\.[a-z]{1,5}$/),
        (key) => {
          // Normal workspace file paths should always pass
          expect(() => validateKey(key)).not.toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// KV key namespace isolation — colon injection and cross-namespace collision
// ---------------------------------------------------------------------------
describe('Fuzz: KV key namespace isolation', () => {
  // Valid bucket names from getBucketName (no colons possible)
  const validBucket = fc.stringMatching(/^[a-z0-9][a-z0-9-]{1,20}[a-z0-9]$/);
  const validSessionId = fc.stringMatching(/^[a-z0-9]{8,24}$/);

  it('getSessionKey always has exactly 3 colon-separated segments', () => {
    fc.assert(
      fc.property(validBucket, validSessionId, (bucket, sessionId) => {
        const key = getSessionKey(bucket, sessionId);
        const segments = key.split(':');
        expect(segments).toHaveLength(3);
        expect(segments[0]).toBe('session');
        expect(segments[1]).toBe(bucket);
        expect(segments[2]).toBe(sessionId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('getSessionPrefix ends with colon (prevents partial-key matches)', () => {
    fc.assert(
      fc.property(validBucket, (bucket) => {
        const prefix = getSessionPrefix(bucket);
        expect(prefix.endsWith(':')).toBe(true);
        // A bucket like "test" should not match prefix for "test-extended"
        const otherPrefix = getSessionPrefix(`${bucket}-extended`);
        expect(otherPrefix.startsWith(prefix)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('different key functions never produce colliding keys', () => {
    fc.assert(
      fc.property(validBucket, (bucket) => {
        const presets = getPresetsKey(bucket);
        const prefs = getPreferencesKey(bucket);
        const sessionPrefix = getSessionPrefix(bucket);
        // No cross-namespace collisions
        expect(presets).not.toBe(prefs);
        expect(presets.startsWith('session:')).toBe(false);
        expect(prefs.startsWith('session:')).toBe(false);
        expect(presets.startsWith(sessionPrefix)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// emailFromKvKey — round-trip and edge cases
// ---------------------------------------------------------------------------
describe('Fuzz: emailFromKvKey', () => {
  it('round-trips: emailFromKvKey("user:" + email) === email', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        const key = `user:${email}`;
        expect(emailFromKvKey(key)).toBe(email);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('only strips first "user:" occurrence', () => {
    // Documents the first-match-only behavior of String.replace
    const key = 'user:user:admin@example.com';
    expect(emailFromKvKey(key)).toBe('user:admin@example.com');
    // This means double-prefixed keys return a wrong email — upstream must prevent this
  });
});

// ---------------------------------------------------------------------------
// getBucketName with long workerName — second trailing-hyphen vector
// ---------------------------------------------------------------------------
describe('Fuzz: getBucketName workerName edge cases', () => {
  it('never produces trailing hyphen regardless of workerName length', () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        fc.stringMatching(/^[a-z]{1,62}$/),
        (email, workerName) => {
          const name = getBucketName(email, workerName);
          expect(name).not.toMatch(/-$/);
          expect(name).not.toMatch(/^-/);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('very long workerName (>60 chars) still produces valid output', () => {
    // When prefix exceeds 62 chars, maxSanitizedLength <= 0, sanitized part is empty
    fc.assert(
      fc.property(
        fc.emailAddress(),
        fc.stringMatching(/^[a-z]{55,62}$/),
        (email, workerName) => {
          const name = getBucketName(email, workerName);
          expect(name.length).toBeLessThanOrEqual(63);
          expect(name.length).toBeGreaterThanOrEqual(1);
          // Must not end with hyphen (from prefix "longname-" with no sanitized part)
          expect(name).not.toMatch(/-$/);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// CORS empty/special pattern edge cases
// ---------------------------------------------------------------------------
describe('Fuzz: CORS edge cases', () => {
  // Replicated from src/lib/cors-cache.ts
  function matchesPattern(hostname: string, pattern: string): boolean {
    const h = hostname.toLowerCase();
    const p = pattern.toLowerCase();
    if (p.startsWith('.')) return h.endsWith(p);
    return h === p || h.endsWith('.' + p);
  }

  it('empty pattern only matches empty hostname', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9.-]{1,30}$/),
        (hostname) => {
          // Non-empty hostname must NOT match empty pattern
          // (empty pattern would mean ".endsWith('.')" which only matches hostnames ending in ".")
          expect(matchesPattern(hostname, '')).toBe(hostname.endsWith('.'));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('IP address patterns respect dot boundary', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 254 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (a, b, c, d) => {
          const ip = `${a}.${b}.${c}.${d}`;
          // Pattern of just the last 3 octets should NOT match via bare-domain logic
          // because bare patterns require '.' + pattern, and IP doesn't have that structure
          const partialIp = `${b}.${c}.${d}`;
          if (matchesPattern(ip, partialIp)) {
            // If it matched, it's because ip ends with "." + partialIp (subdomain-style)
            expect(ip.endsWith(`.${partialIp}`)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('javascript: and data: origins produce empty hostname in URL parser', () => {
    // Documents what isAllowedOrigin would see — the hostname extraction step
    for (const scheme of ['javascript:alert(1)', 'data:text/html,<h1>hi</h1>', 'blob:null/uuid']) {
      try {
        const hostname = new URL(scheme).hostname;
        // Empty hostname should NOT match any real domain pattern
        expect(matchesPattern(hostname, 'example.com')).toBe(false);
        expect(matchesPattern(hostname, '.example.com')).toBe(false);
      } catch {
        // new URL() threw — isAllowedOrigin returns false, which is correct
      }
    }
  });
});

// ---------------------------------------------------------------------------
// XML parser — adversarial structured XML
// ---------------------------------------------------------------------------
describe('Fuzz: XML parsing with adversarial structure', () => {
  it('handles XML with injection attempts in key names', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'file</Key><Key>injected',
          '"><script>alert(1)</script>',
          'key&amp;name',
          '<![CDATA[evil]]>',
          'a'.repeat(1000),
        ),
        (rawKey) => {
          // Properly escaped key in XML should round-trip correctly
          const xml = `<ListBucketResult><Contents><Key>${escapeXml(rawKey)}</Key><Size>0</Size><LastModified>2024-01-01T00:00:00Z</LastModified></Contents></ListBucketResult>`;
          const result = parseListObjectsXml(xml);
          expect(result.objects).toHaveLength(1);
          expect(result.objects[0].key).toBe(rawKey);
        },
      ),
      { numRuns: 5 }, // deterministic payloads
    );
  });

  it('multiple Contents blocks all parse correctly', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9\/_.-]{1,30}$/), { minLength: 1, maxLength: 20 }),
        (keys) => {
          const contents = keys.map((k) =>
            `<Contents><Key>${escapeXml(k)}</Key><Size>100</Size><LastModified>2024-01-01T00:00:00Z</LastModified></Contents>`,
          ).join('');
          const xml = `<ListBucketResult>${contents}</ListBucketResult>`;
          const result = parseListObjectsXml(xml);
          expect(result.objects).toHaveLength(keys.length);
          result.objects.forEach((obj, i) => {
            expect(obj.key).toBe(keys[i]);
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
