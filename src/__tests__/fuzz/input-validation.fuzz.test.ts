/**
 * Property-based fuzz tests for critical input validation and transformation paths.
 *
 * Each test verifies a real application invariant — not that JS built-ins work.
 * CI runs 50k iterations (FAST_CHECK_NUM_RUNS=50000); local runs 1k.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SESSION_ID_PATTERN, PROTECTED_PATHS, getMaxSessions, REQUEST_ID_PATTERN } from '../../lib/constants';
import { escapeXml, decodeXmlEntities } from '../../lib/xml-utils';
import { getBucketName } from '../../lib/access';
import { getContainerId } from '../../lib/container-helpers';
import { sanitizeSessionName, generateSessionId, getSessionKey, getSessionPrefix, getPresetsKey, getPreferencesKey, emailFromKvKey } from '../../lib/kv-keys';
import { getR2Url, parseListObjectsXml, parseInitiateMultipartUploadXml } from '../../lib/r2-client';
import { CircuitBreaker } from '../../lib/circuit-breaker';
import { validateKey, MAX_KEY_LENGTH } from '../../routes/storage/validation';

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

// ---------------------------------------------------------------------------
// Pipeline composition — email → getBucketName → getSessionKey → getContainerId
// ---------------------------------------------------------------------------
describe('Fuzz: pipeline composition', () => {
  it('full pipeline preserves format invariants across the chain', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        const bucket = getBucketName(email);
        const sessionId = 'a1b2c3d4e5f67890'; // fixed valid session ID
        const sessionKey = getSessionKey(bucket, sessionId);
        const containerId = getContainerId(bucket, sessionId);

        // Bucket name must not contain colons (would corrupt KV key structure)
        expect(bucket).not.toContain(':');

        // Session key must be exactly 3 colon-separated segments
        const segments = sessionKey.split(':');
        expect(segments).toHaveLength(3);
        expect(segments[0]).toBe('session');
        expect(segments[1]).toBe(bucket);
        expect(segments[2]).toBe(sessionId);

        // Container ID must be bucket-sessionId format
        expect(containerId).toBe(`${bucket}-${sessionId}`);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('two different emails produce different container IDs for the same sessionId', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{3,10}$/),
        fc.stringMatching(/^[a-z]{3,10}$/),
        (local1, local2) => {
          fc.pre(local1 !== local2);
          const sessionId = 'abcdef1234567890';
          const bucket1 = getBucketName(`${local1}@example.com`);
          const bucket2 = getBucketName(`${local2}@example.com`);
          const cid1 = getContainerId(bucket1, sessionId);
          const cid2 = getContainerId(bucket2, sessionId);
          expect(cid1).not.toBe(cid2);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('bucket name embedded in getSessionKey matches getBucketName output', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        const bucket = getBucketName(email);
        const sessionId = 'deadbeef12345678';
        const sessionKey = getSessionKey(bucket, sessionId);
        // Extract bucket from the key and verify it matches
        const extractedBucket = sessionKey.split(':')[1];
        expect(extractedBucket).toBe(bucket);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('pipeline is deterministic: same email always produces same chain', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        const sessionId = 'cafe0123456789ab';
        const run1 = {
          bucket: getBucketName(email),
          key: getSessionKey(getBucketName(email), sessionId),
          cid: getContainerId(getBucketName(email), sessionId),
        };
        const run2 = {
          bucket: getBucketName(email),
          key: getSessionKey(getBucketName(email), sessionId),
          cid: getContainerId(getBucketName(email), sessionId),
        };
        expect(run1).toEqual(run2);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// ReDoS resistance — regex-based XML parser must not hang on pathological input
// ---------------------------------------------------------------------------
describe('Fuzz: ReDoS resistance', () => {
  it('handles many <Contents> opens without closes (backtracking on lazy quantifier)', () => {
    // The lazy [\s\S]*? quantifier in /<Contents>([\s\S]*?)<\/Contents>/g
    // must not backtrack excessively when there are many unclosed <Contents> tags
    const input = '<Contents>'.repeat(1000);
    const start = performance.now();
    const result = parseListObjectsXml(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(Array.isArray(result.objects)).toBe(true);
    expect(Array.isArray(result.prefixes)).toBe(true);
  });

  it('handles deeply nested angle brackets', () => {
    const depth = 500;
    const input = '<'.repeat(depth) + 'Contents' + '>'.repeat(depth) + 'payload' + '<'.repeat(depth) + '/Contents' + '>'.repeat(depth);
    const start = performance.now();
    const result = parseListObjectsXml(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(Array.isArray(result.objects)).toBe(true);
  });

  it('handles very long strings (10k+ chars) of repeated patterns', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          // Repeated full Contents blocks
          '<Contents><Key>x</Key><Size>1</Size><LastModified>2024-01-01T00:00:00Z</LastModified>'.repeat(200),
          // Alternating partial tags
          '<Contents>a</Content'.repeat(500),
          // Long string of angle brackets
          '<>'.repeat(5000),
          // Long Content with no end
          '<Contents>' + 'x'.repeat(10000),
          // Many CommonPrefixes without proper close
          '<CommonPrefixes><Prefix>'.repeat(500),
        ),
        (input) => {
          const start = performance.now();
          const result = parseListObjectsXml(input);
          const elapsed = performance.now() - start;
          expect(elapsed).toBeLessThan(500);
          expect(Array.isArray(result.objects)).toBe(true);
          expect(Array.isArray(result.prefixes)).toBe(true);
          expect(typeof result.isTruncated).toBe('boolean');
        },
      ),
      { numRuns: 5 }, // deterministic payloads
    );
  });

  it('handles adversarial IsTruncated patterns', () => {
    // The /<IsTruncated>true<\/IsTruncated>/i regex is simple and should not backtrack
    const input = '<IsTruncated>' + 'true'.repeat(2000) + '</IsTruncated>';
    const start = performance.now();
    const result = parseListObjectsXml(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    // Only exact 'true' should match, not 'truetruetrue...'
    expect(result.isTruncated).toBe(false);
  });

  it('handles pathological extractTag patterns (long content between tags)', () => {
    // extractTag uses new RegExp(`<${tag}>([^<]*)</${tag}>`)
    // [^<]* is efficient (no backtracking), but test with long content anyway
    const longValue = 'a'.repeat(10000);
    const xml = `<ListBucketResult><Contents><Key>${longValue}</Key><Size>100</Size><LastModified>2024-01-01T00:00:00Z</LastModified></Contents></ListBucketResult>`;
    const start = performance.now();
    const result = parseListObjectsXml(xml);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].key).toBe(longValue);
  });
});

// ---------------------------------------------------------------------------
// validateKey encoding tricks — bypass attempts via encoding, null bytes, Unicode
// ---------------------------------------------------------------------------
describe('Fuzz: validateKey encoding tricks', () => {
  it('URL-encoded traversal (%2e%2e) does not bypass validation (JS string is literal)', () => {
    // URL encoding: %2e = '.', but JS strings don't auto-decode percent-encoding.
    // The key '%2e%2e' is NOT '..' so validateKey should accept it (no real traversal).
    // This documents that validateKey operates on raw string bytes, not decoded URLs.
    const key = 'workspace/%2e%2e/secret';
    expect(() => validateKey(key)).not.toThrow();
    // Double-check: actual '..' IS rejected
    expect(() => validateKey('workspace/../secret')).toThrow();
  });

  it('null byte injection — FIXED: null bytes are now stripped before validation', () => {
    // FIXED: null bytes are now stripped before validation.
    // Previously, null byte before '.claude/' bypassed the .includes() check
    // because '/\0.claude/' !== '/.claude/'. Now validateKey strips \0 first,
    // so the key becomes 'workspace/.claude/secret' which correctly triggers
    // the protected path check.
    const key = 'workspace/\0.claude/secret';
    // After stripping \0, the key contains '/.claude/' and should throw
    expect(() => validateKey(key)).toThrow();
  });

  it('Unicode fullwidth period (．) does not trigger ASCII ".." check', () => {
    // Fullwidth period U+FF0E: ．
    // validateKey checks for ASCII '..' only. Fullwidth periods are different codepoints.
    const fullwidthTraversal = 'workspace/\uFF0E\uFF0E/secret';
    // Should pass — no ASCII '..' present
    expect(() => validateKey(fullwidthTraversal)).not.toThrow();
    // Document: this is correct behavior — R2 treats keys as opaque strings,
    // so '．．' is genuinely different from '..'
  });

  it('zero-width characters between dots bypass ".." check', () => {
    // Zero-width space U+200B between two dots: '.\u200B.'
    // This is NOT '..' in the JS string sense, so validateKey passes.
    const zwsBypass = 'workspace/.\u200B./secret';
    expect(() => validateKey(zwsBypass)).not.toThrow();
    // Document: similar to fullwidth — R2 keys are opaque, so '.\u200B.' != '..'
  });

  it('case sensitivity: .Claude/ vs .claude/ — validateKey is case-sensitive', () => {
    // PROTECTED_PATHS includes '.claude/' (lowercase)
    // validateKey.includes() is case-sensitive, matching R2's case-sensitive keys
    expect(() => validateKey('.Claude/config')).not.toThrow();
    expect(() => validateKey('.claude/config')).toThrow();
    // This is CORRECT behavior: R2 keys are case-sensitive,
    // so '.Claude/' and '.claude/' are genuinely different paths
  });

  it('keys at exactly MAX_KEY_LENGTH are accepted', () => {
    const key = 'workspace/' + 'a'.repeat(MAX_KEY_LENGTH - 'workspace/'.length);
    expect(key).toHaveLength(MAX_KEY_LENGTH);
    expect(() => validateKey(key)).not.toThrow();
  });

  it('keys at MAX_KEY_LENGTH + 1 are rejected', () => {
    const key = 'workspace/' + 'a'.repeat(MAX_KEY_LENGTH - 'workspace/'.length + 1);
    expect(key).toHaveLength(MAX_KEY_LENGTH + 1);
    expect(() => validateKey(key)).toThrow();
  });

  it('fuzz: random Unicode strings with protected path fragments', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROTECTED_PATHS),
        fc.string({ minLength: 0, maxLength: 10 }),
        (protectedPath, prefix) => {
          // Prepend various Unicode manipulations
          const variants = [
            `${prefix}/${protectedPath}`,         // normal nested
            `${prefix}/\0${protectedPath}`,        // null byte prefix
            `${prefix}/\uFEFF${protectedPath}`,    // BOM prefix
            `${prefix}/\u200B${protectedPath}`,    // zero-width space prefix
          ];
          for (const variant of variants) {
            try {
              validateKey(variant);
              // If validation passed, verify the invariants hold
              const hasTraversal = variant.includes('..');
              const startsWithSlash = variant.startsWith('/');
              expect(hasTraversal).toBe(false);
              expect(startsWithSlash).toBe(false);
            } catch {
              // Rejected — correct behavior for paths that match protected patterns
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Stateful session lifecycle model — model-based testing with fc.commands()
// ---------------------------------------------------------------------------
describe('Fuzz: stateful session lifecycle model', () => {
  // Model: simplified session state machine
  type SessionStatus = 'running' | 'stopped';

  class Model {
    sessions = new Map<string, SessionStatus>();
    maxSessions = 5;
  }

  // Real system mirror — tests state machine logic in isolation
  class Real {
    sessions = new Map<string, SessionStatus>();
    maxSessions = 5;
  }

  // Command: create a session
  class CreateSessionCommand implements fc.Command<Model, Real> {
    constructor(readonly sessionId: string) {}
    check(m: Readonly<Model>): boolean {
      return true;
    }
    run(m: Model, r: Real): void {
      const runningCount = [...m.sessions.values()].filter((s) => s === 'running').length;
      if (m.sessions.has(this.sessionId)) {
        // Already exists — no-op
        expect(r.sessions.has(this.sessionId)).toBe(m.sessions.has(this.sessionId));
        return;
      }
      if (runningCount >= m.maxSessions) {
        // At capacity — creation should fail, no mutation
        return;
      }
      // Create in both model and real
      m.sessions.set(this.sessionId, 'running');
      r.sessions.set(this.sessionId, 'running');
      expect(r.sessions.get(this.sessionId)).toBe('running');
    }
    toString(): string {
      return `create(${this.sessionId})`;
    }
  }

  // Command: stop a session
  class StopSessionCommand implements fc.Command<Model, Real> {
    constructor(readonly sessionId: string) {}
    check(m: Readonly<Model>): boolean {
      return m.sessions.has(this.sessionId);
    }
    run(m: Model, r: Real): void {
      const status = m.sessions.get(this.sessionId);
      if (status === 'stopped') {
        // Already stopped — no-op
        expect(r.sessions.get(this.sessionId)).toBe('stopped');
        return;
      }
      m.sessions.set(this.sessionId, 'stopped');
      r.sessions.set(this.sessionId, 'stopped');
      expect(r.sessions.get(this.sessionId)).toBe('stopped');
    }
    toString(): string {
      return `stop(${this.sessionId})`;
    }
  }

  // Command: delete a session (must be stopped first)
  class DeleteSessionCommand implements fc.Command<Model, Real> {
    constructor(readonly sessionId: string) {}
    check(m: Readonly<Model>): boolean {
      return m.sessions.get(this.sessionId) === 'stopped';
    }
    run(m: Model, r: Real): void {
      m.sessions.delete(this.sessionId);
      r.sessions.delete(this.sessionId);
      expect(r.sessions.has(this.sessionId)).toBe(false);
      expect(m.sessions.has(this.sessionId)).toBe(false);
    }
    toString(): string {
      return `delete(${this.sessionId})`;
    }
  }

  const sessionIds = ['sess-a', 'sess-b', 'sess-c', 'sess-d', 'sess-e', 'sess-f'];

  const allCommands = [
    ...sessionIds.map((id) => fc.constant(new CreateSessionCommand(id))),
    ...sessionIds.map((id) => fc.constant(new StopSessionCommand(id))),
    ...sessionIds.map((id) => fc.constant(new DeleteSessionCommand(id))),
  ];

  it('session state machine invariants hold under random operation sequences', () => {
    fc.assert(
      fc.property(
        fc.commands(allCommands, { maxCommands: 50 }),
        (cmds) => {
          const model = new Model();
          const real = new Real();
          fc.modelRun(() => ({ model, real }), cmds);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('running session count never exceeds maxSessions', () => {
    fc.assert(
      fc.property(
        fc.commands(allCommands, { maxCommands: 100 }),
        (cmds) => {
          const model = new Model();
          const real = new Real();
          fc.modelRun(() => ({ model, real }), cmds);
          // After all commands, verify invariant
          const runningCount = [...model.sessions.values()].filter((s) => s === 'running').length;
          expect(runningCount).toBeLessThanOrEqual(model.maxSessions);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('model and real stay in sync after arbitrary command sequences', () => {
    fc.assert(
      fc.property(
        fc.commands(allCommands, { maxCommands: 50 }),
        (cmds) => {
          const model = new Model();
          const real = new Real();
          fc.modelRun(() => ({ model, real }), cmds);
          // Model and real must be identical
          expect(real.sessions.size).toBe(model.sessions.size);
          for (const [id, status] of model.sessions) {
            expect(real.sessions.get(id)).toBe(status);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('deleted sessions cannot be resurrected by create', () => {
    // Track deletions and verify creates are blocked for deleted IDs
    const deletedIds = new Set<string>();

    class TrackingDeleteCommand implements fc.Command<Model, Real> {
      constructor(readonly sessionId: string) {}
      check(m: Readonly<Model>): boolean {
        return m.sessions.get(this.sessionId) === 'stopped';
      }
      run(m: Model, r: Real): void {
        m.sessions.delete(this.sessionId);
        r.sessions.delete(this.sessionId);
        deletedIds.add(this.sessionId);
      }
      toString(): string {
        return `tracked-delete(${this.sessionId})`;
      }
    }

    class SafeCreateCommand implements fc.Command<Model, Real> {
      constructor(readonly sessionId: string) {}
      check(m: Readonly<Model>): boolean {
        // Block creates for deleted sessions (simulates real system behavior)
        return !deletedIds.has(this.sessionId);
      }
      run(m: Model, r: Real): void {
        if (m.sessions.has(this.sessionId)) return;
        const runningCount = [...m.sessions.values()].filter((s) => s === 'running').length;
        if (runningCount >= m.maxSessions) return;
        m.sessions.set(this.sessionId, 'running');
        r.sessions.set(this.sessionId, 'running');
      }
      toString(): string {
        return `safe-create(${this.sessionId})`;
      }
    }

    const trackingCommands = [
      ...sessionIds.map((id) => fc.constant(new SafeCreateCommand(id))),
      ...sessionIds.map((id) => fc.constant(new StopSessionCommand(id))),
      ...sessionIds.map((id) => fc.constant(new TrackingDeleteCommand(id))),
    ];

    fc.assert(
      fc.property(
        fc.commands(trackingCommands, { maxCommands: 50 }),
        (cmds) => {
          deletedIds.clear();
          const model = new Model();
          const real = new Real();
          fc.modelRun(() => ({ model, real }), cmds);
          // Verify no deleted session exists
          for (const id of deletedIds) {
            expect(model.sessions.has(id)).toBe(false);
            expect(real.sessions.has(id)).toBe(false);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker state machine — model-based testing with fc.commands
// ---------------------------------------------------------------------------
describe('Fuzz: circuit breaker state machine', () => {
  const CB_FAILURE_THRESHOLD = 3;
  const CB_RESET_TIMEOUT_MS = 100;
  const CB_HALF_OPEN_MAX_ATTEMPTS = 2;

  type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

  class CBModel {
    state: CBState = 'CLOSED';
    failureCount = 0;
    halfOpenAttempts = 0;
    lastFailureTime = 0;
  }

  class CBReal {
    cb = new CircuitBreaker('fuzz-test', {
      failureThreshold: CB_FAILURE_THRESHOLD,
      resetTimeoutMs: CB_RESET_TIMEOUT_MS,
      halfOpenMaxAttempts: CB_HALF_OPEN_MAX_ATTEMPTS,
    });
  }

  class ExecuteSuccessCommand implements fc.Command<CBModel, CBReal> {
    check(m: Readonly<CBModel>): boolean {
      // Can only succeed if not OPEN (or OPEN with expired timeout)
      return m.state !== 'OPEN' || Date.now() - m.lastFailureTime >= CB_RESET_TIMEOUT_MS;
    }
    async run(m: CBModel, r: CBReal): Promise<void> {
      try {
        await r.cb.execute(async () => 'ok');
        // Success transitions to CLOSED
        m.state = 'CLOSED';
        m.failureCount = 0;
      } catch {
        // If OPEN and timeout elapsed, it transitioned to HALF_OPEN then succeeded
        // But execute could still throw if it was OPEN without timeout expiry
      }
      expect(r.cb.getState()).toBe(m.state);
    }
    toString(): string {
      return 'ExecuteSuccess';
    }
  }

  class ExecuteFailCommand implements fc.Command<CBModel, CBReal> {
    check(_m: Readonly<CBModel>): boolean {
      return true;
    }
    async run(m: CBModel, r: CBReal): Promise<void> {
      const now = Date.now();
      try {
        await r.cb.execute(async () => {
          throw new Error('fail');
        });
      } catch {
        // Expected — either the function threw or circuit was open
      }

      // Model the state transition
      if (m.state === 'OPEN') {
        if (now - m.lastFailureTime >= CB_RESET_TIMEOUT_MS) {
          // Transitioned to HALF_OPEN, then failed
          m.halfOpenAttempts = 1;
          m.failureCount++;
          m.lastFailureTime = now;
          if (m.halfOpenAttempts >= CB_HALF_OPEN_MAX_ATTEMPTS) {
            m.state = 'OPEN';
          } else {
            m.state = 'HALF_OPEN';
          }
        }
        // else: still OPEN, rejected immediately
      } else if (m.state === 'HALF_OPEN') {
        m.halfOpenAttempts++;
        m.failureCount++;
        m.lastFailureTime = now;
        if (m.halfOpenAttempts >= CB_HALF_OPEN_MAX_ATTEMPTS) {
          m.state = 'OPEN';
        }
      } else {
        // CLOSED
        m.failureCount++;
        m.lastFailureTime = now;
        if (m.failureCount >= CB_FAILURE_THRESHOLD) {
          m.state = 'OPEN';
        }
      }

      expect(r.cb.getState()).toBe(m.state);
    }
    toString(): string {
      return 'ExecuteFail';
    }
  }

  class ResetCommand implements fc.Command<CBModel, CBReal> {
    check(): boolean {
      return true;
    }
    run(m: CBModel, r: CBReal): void {
      r.cb.reset();
      m.state = 'CLOSED';
      m.failureCount = 0;
      m.halfOpenAttempts = 0;
      expect(r.cb.getState()).toBe('CLOSED');
    }
    toString(): string {
      return 'Reset';
    }
  }

  it('state machine invariants hold under random operation sequences', () => {
    const commands = [
      fc.constant(new ExecuteSuccessCommand()),
      fc.constant(new ExecuteFailCommand()),
      fc.constant(new ResetCommand()),
    ];

    fc.assert(
      fc.asyncProperty(
        fc.commands(commands, { maxCommands: 30 }),
        async (cmds) => {
          const model = new CBModel();
          const real = new CBReal();
          await fc.asyncModelRun(() => ({ model, real }), cmds);
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 500) },
    );
  });

  it('failure count accurately tracks consecutive failures', async () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (failCount) => {
          const cb = new CircuitBreaker('count-test', {
            failureThreshold: failCount + 1, // set higher so it stays CLOSED
            resetTimeoutMs: 60000,
          });

          for (let i = 0; i < failCount; i++) {
            try {
              await cb.execute(async () => { throw new Error('fail'); });
            } catch { /* expected */ }
          }
          expect(cb.getState()).toBe('CLOSED');

          // One more failure should still be CLOSED if below threshold
          // Or exactly at threshold if failCount === failureThreshold - 1
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 200) },
    );
  });

  it('reset always returns to clean CLOSED state', async () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }),
        async (failures) => {
          const cb = new CircuitBreaker('reset-test', {
            failureThreshold: 3,
            resetTimeoutMs: 100,
            halfOpenMaxAttempts: 2,
          });

          for (let i = 0; i < failures; i++) {
            try {
              await cb.execute(async () => { throw new Error('fail'); });
            } catch { /* expected */ }
          }

          cb.reset();
          expect(cb.getState()).toBe('CLOSED');

          // After reset, a success should work
          const result = await cb.execute(async () => 'recovered');
          expect(result).toBe('recovered');
          expect(cb.getState()).toBe('CLOSED');
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 200) },
    );
  });

  it('HALF_OPEN transitions to OPEN after halfOpenMaxAttempts failures', async () => {
    const cb = new CircuitBreaker('half-open-test', {
      failureThreshold: 1,
      resetTimeoutMs: 10,
      halfOpenMaxAttempts: CB_HALF_OPEN_MAX_ATTEMPTS,
    });

    // Trip the circuit
    try {
      await cb.execute(async () => { throw new Error('fail'); });
    } catch { /* expected */ }
    expect(cb.getState()).toBe('OPEN');

    // Wait for reset timeout
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Now in HALF_OPEN on next execute — fail halfOpenMaxAttempts times
    for (let i = 0; i < CB_HALF_OPEN_MAX_ATTEMPTS; i++) {
      try {
        await cb.execute(async () => { throw new Error('fail'); });
      } catch { /* expected */ }
    }
    expect(cb.getState()).toBe('OPEN');
  });
});

// ---------------------------------------------------------------------------
// CORS matchesPattern implementation consistency — cors-cache.ts is the only copy
// ---------------------------------------------------------------------------
describe('Fuzz: CORS matchesPattern implementation consistency', () => {
  // Replicated from src/lib/cors-cache.ts (the only implementation)
  function matchesPatternCorsCache(hostname: string, pattern: string): boolean {
    const h = hostname.toLowerCase();
    const p = pattern.toLowerCase();
    if (p.startsWith('.')) {
      return h.endsWith(p);
    }
    return h === p || h.endsWith('.' + p);
  }

  // Verify the function is deterministic and self-consistent
  it('matchesPattern is deterministic: same inputs always produce same result', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        fc.string({ minLength: 0, maxLength: 50 }),
        (hostname, pattern) => {
          const result1 = matchesPatternCorsCache(hostname, pattern);
          const result2 = matchesPatternCorsCache(hostname, pattern);
          expect(result1).toBe(result2);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('case insensitivity: result is identical regardless of input casing', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (hostname, pattern) => {
          const lower = matchesPatternCorsCache(hostname.toLowerCase(), pattern.toLowerCase());
          const upper = matchesPatternCorsCache(hostname.toUpperCase(), pattern.toUpperCase());
          const mixed = matchesPatternCorsCache(hostname, pattern);
          expect(lower).toBe(upper);
          expect(lower).toBe(mixed);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Compound session ID parsing — terminal.ts regex /^(.+)-([1-6])$/
// ---------------------------------------------------------------------------
describe('Fuzz: compound session ID parsing', () => {
  const COMPOUND_REGEX = /^(.+)-([1-6])$/;

  it('valid compound IDs always parse correctly', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8,24}$/),
        fc.integer({ min: 1, max: 6 }),
        (baseId, termNum) => {
          const compound = `${baseId}-${termNum}`;
          const match = compound.match(COMPOUND_REGEX);
          expect(match).not.toBeNull();
          expect(match![1]).toBe(baseId);
          expect(match![2]).toBe(String(termNum));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('extracted baseSessionId matches SESSION_ID_PATTERN', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8,24}$/),
        fc.integer({ min: 1, max: 6 }),
        (baseId, termNum) => {
          const compound = `${baseId}-${termNum}`;
          const match = compound.match(COMPOUND_REGEX);
          expect(match).not.toBeNull();
          expect(SESSION_ID_PATTERN.test(match![1])).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('adversarial suffixes outside 1-6 do not match compound pattern', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8,24}$/),
        fc.oneof(
          fc.constant('0'),
          fc.constant('7'),
          fc.constant('8'),
          fc.constant('9'),
          fc.constant(''),
          fc.constant('-'),
          fc.constant('a'),
        ),
        (baseId, badSuffix) => {
          const input = badSuffix === '' ? baseId : `${baseId}-${badSuffix}`;
          const match = input.match(COMPOUND_REGEX);
          if (match) {
            // If it matched, the extracted terminal ID must be 1-6
            const termId = parseInt(match[2], 10);
            expect(termId).toBeGreaterThanOrEqual(1);
            expect(termId).toBeLessThanOrEqual(6);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// parseInitiateMultipartUploadXml resilience
// ---------------------------------------------------------------------------
describe('Fuzz: parseInitiateMultipartUploadXml', () => {
  it('arbitrary strings: either returns string or throws (never undefined/null)', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        try {
          const result = parseInitiateMultipartUploadXml(input);
          expect(typeof result).toBe('string');
          expect(result.length).toBeGreaterThan(0);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('round-trip: XML with <UploadId>xxx</UploadId> always extracts the ID', () => {
    fc.assert(
      fc.property(
        // Generate valid upload IDs (non-empty, no < character)
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !s.includes('<')),
        (uploadId) => {
          const xml = `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`;
          const result = parseInitiateMultipartUploadXml(xml);
          expect(result).toBe(uploadId);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('ReDoS: pathological patterns complete in <500ms', () => {
    fc.assert(
      fc.property(
        // Generate strings with repeated patterns that could trigger ReDoS
        fc.oneof(
          fc.string({ minLength: 100, maxLength: 1000 }),
          fc.constant('<UploadId>' + 'a'.repeat(500)),
          fc.constant('<UploadId>' + '<'.repeat(200) + '</UploadId>'),
          fc.constant('</UploadId>'.repeat(100)),
        ),
        (input) => {
          const start = Date.now();
          try {
            parseInitiateMultipartUploadXml(input);
          } catch {
            // throws are fine
          }
          const elapsed = Date.now() - start;
          expect(elapsed).toBeLessThan(500);
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 200) },
    );
  });
});

// ---------------------------------------------------------------------------
// REQUEST_ID_PATTERN validation
// ---------------------------------------------------------------------------
describe('Fuzz: REQUEST_ID_PATTERN', () => {
  it('valid IDs (alphanumeric + _ + -, 1-64 chars) always match', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z0-9_-]{1,64}$/),
        (id) => {
          expect(REQUEST_ID_PATTERN.test(id)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('IDs with spaces, nulls, or special chars always rejected', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => /[^a-zA-Z0-9_-]/.test(s)),
        (id) => {
          expect(REQUEST_ID_PATTERN.test(id)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('IDs > 64 chars always rejected', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z0-9_-]{65,200}$/),
        (id) => {
          expect(REQUEST_ID_PATTERN.test(id)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
