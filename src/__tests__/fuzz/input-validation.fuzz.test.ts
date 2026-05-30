/**
 * Property-based fuzz tests for critical input validation and transformation paths.
 *
 * Each test verifies a real application invariant - not that JS built-ins work.
 * CI runs 50k iterations (FAST_CHECK_NUM_RUNS=50000); local runs 1k.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SESSION_ID_PATTERN, getMaxSessions, REQUEST_ID_PATTERN } from '../../lib/constants';
import { escapeXml, decodeXmlEntities } from '../../lib/xml-utils';
import { getBucketName } from '../../lib/access';
import { getContainerId } from '../../lib/container-helpers';
import { sanitizeSessionName, getSessionKey, getSessionPrefix, getPresetsKey, getPreferencesKey } from '../../lib/kv-keys';
import { getR2Url, parseListObjectsXml, parseInitiateMultipartUploadXml } from '../../lib/r2-client';
import { CircuitBreaker } from '../../lib/circuit-breaker';
import { validateKey, MAX_KEY_LENGTH } from '../../routes/storage/validation';
import { toError, toErrorMessage, AppError, NotFoundError, ValidationError, SetupError, RateLimitError, CircuitBreakerOpenError } from '../../lib/error-types';
import { getDefaultTabConfig } from '../../lib/agent-config';
import { isBucketNameResponse } from '../../lib/type-guards';
import { isOnboardingLandingPageActive } from '../../lib/onboarding';
import { TabConfigSchema } from '../../lib/schemas';
import { createLogger, setLogLevel } from '../../lib/logger';
import { toApiSession } from '../../lib/session-helpers';
import { getSetupCompleteCache, setSetupCompleteCache, resetSetupCache } from '../../lib/cache-reset';
import { getConfigsForMode, getPreseedKeysNotInMode } from '../../lib/r2-seed';

const NUM_RUNS = parseInt(process.env.FAST_CHECK_NUM_RUNS || '1000');

// ---------------------------------------------------------------------------
// XML escape/decode round-trip - protects against injection in DeleteObjects
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
// XML parsing - regex-based parser must handle adversarial XML
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
// Bucket name derivation - collision resistance and format invariants
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
// Container ID - validation gate must never pass invalid session IDs
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
// Session name sanitization - must strip injection vectors, never empty
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
// getMaxSessions - must always return non-negative finite number
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
          // Negative values from parseInt are technically accepted - this documents that
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
// R2 URL construction - path traversal and format safety
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
          // Split on bucket name - the part before it should not end with extra slashes
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
// Storage key validation - path traversal, protected paths, edge cases
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
          // PROTECTED_PATHS is now empty - no path restrictions to check
        } catch {
          // Validation threw - that's fine, this is the reject path
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

  it('allows previously protected paths at root and nested positions (PROTECTED_PATHS is now empty)', () => {
    // With PROTECTED_PATHS = [], paths like .claude/, .ssh/, etc. are now allowed
    const formerlyProtected = ['.claude/', '.anthropic/', '.ssh/', '.config/', '.claude.json'];
    fc.assert(
      fc.property(
        fc.constantFrom(...formerlyProtected),
        fc.stringMatching(/^[a-z0-9]{0,20}$/),
        (path, prefix) => {
          // At root - should now pass
          expect(() => validateKey(path)).not.toThrow();
          // Nested under a prefix - should now pass
          if (prefix.length > 0) {
            expect(() => validateKey(`${prefix}/${path}`)).not.toThrow();
          }
        },
      ),
      { numRuns: Math.min(NUM_RUNS, formerlyProtected.length * 20) },
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
// KV key namespace isolation - colon injection and cross-namespace collision
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
// getBucketName with long workerName - second trailing-hyphen vector
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
// XML parser - adversarial structured XML
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
        fc.array(fc.stringMatching(/^[a-z0-9/_.-]{1,30}$/), { minLength: 1, maxLength: 20 }),
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
// ReDoS resistance - regex-based XML parser must not hang on pathological input
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
// validateKey encoding tricks - bypass attempts via encoding, null bytes, Unicode
// ---------------------------------------------------------------------------
describe('Fuzz: validateKey encoding tricks', () => {
  it('URL-encoded traversal (%2e%2e) does not bypass validation (JS string is literal)', () => {
    // CF-012: validateKey now decodes URI components before path traversal check.
    // %2e%2e decodes to '..' which IS rejected (prevents encoded traversal attacks).
    const key = 'workspace/%2e%2e/secret';
    expect(() => validateKey(key)).toThrow();
    // Direct '..' also rejected
    expect(() => validateKey('workspace/../secret')).toThrow();
  });

  it('null byte injection - null bytes stripped, but .claude/ is no longer protected', () => {
    // Null bytes are still stripped before validation.
    // After stripping \0, the key becomes 'workspace/.claude/secret'.
    // With PROTECTED_PATHS = [], this is now a valid key.
    const key = 'workspace/\0.claude/secret';
    expect(() => validateKey(key)).not.toThrow();
  });

  it('Unicode fullwidth period does not trigger ASCII ".." check', () => {
    // Fullwidth period U+FF0E: ．
    // validateKey checks for ASCII '..' only. Fullwidth periods are different codepoints.
    const fullwidthTraversal = 'workspace/\uFF0E\uFF0E/secret';
    // Should pass - no ASCII '..' present
    expect(() => validateKey(fullwidthTraversal)).not.toThrow();
    // Document: this is correct behavior - R2 treats keys as opaque strings,
    // so '．．' is genuinely different from '..'
  });

  it('zero-width characters between dots bypass ".." check', () => {
    // Zero-width space U+200B between two dots: '.\u200B.'
    // This is NOT '..' in the JS string sense, so validateKey passes.
    const zwsBypass = 'workspace/.\u200B./secret';
    expect(() => validateKey(zwsBypass)).not.toThrow();
    // Document: similar to fullwidth - R2 keys are opaque, so '.\u200B.' != '..'
  });

  it('case sensitivity: .Claude/ vs .claude/ - both allowed (PROTECTED_PATHS is now empty)', () => {
    // With PROTECTED_PATHS = [], both are valid keys
    expect(() => validateKey('.Claude/config')).not.toThrow();
    expect(() => validateKey('.claude/config')).not.toThrow();
    // R2 keys are case-sensitive, so these are genuinely different paths
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

  it('fuzz: random Unicode strings with formerly protected path fragments (now allowed)', () => {
    const formerlyProtected = ['.claude/', '.anthropic/', '.ssh/', '.config/', '.claude.json'];
    fc.assert(
      fc.property(
        fc.constantFrom(...formerlyProtected),
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
              // If validation passed, verify the general invariants still hold
              const hasTraversal = variant.includes('..');
              const startsWithSlash = variant.startsWith('/');
              expect(hasTraversal).toBe(false);
              expect(startsWithSlash).toBe(false);
            } catch {
              // Rejected - still valid for other reasons (traversal, leading slash, etc.)
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});


// ---------------------------------------------------------------------------
// Circuit breaker state machine - model-based testing with fc.commands
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

  class ExecuteSuccessCommand implements fc.AsyncCommand<CBModel, CBReal> {
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

  class ExecuteFailCommand implements fc.AsyncCommand<CBModel, CBReal> {
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
        // Expected - either the function threw or circuit was open
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

  class ResetCommand implements fc.AsyncCommand<CBModel, CBReal> {
    check(): boolean {
      return true;
    }
    async run(m: CBModel, r: CBReal): Promise<void> {
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

    // Now in HALF_OPEN on next execute - fail halfOpenMaxAttempts times
    for (let i = 0; i < CB_HALF_OPEN_MAX_ATTEMPTS; i++) {
      try {
        await cb.execute(async () => { throw new Error('fail'); });
      } catch { /* expected */ }
    }
    expect(cb.getState()).toBe('OPEN');
  });
});

// ---------------------------------------------------------------------------
// CORS matchesPattern implementation consistency - cors-cache.ts is the only copy
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
// Compound session ID parsing - terminal.ts regex /^(.+)-([1-6])$/
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

  it('always returns array of length 6 (MAX_TABS)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_AGENT_TYPES),
        (agentType) => {
          const tabs = getDefaultTabConfig(agentType);
          expect(tabs).toHaveLength(6);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('tab IDs are "1" through "6" in order', () => {
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

// ---------------------------------------------------------------------------
// TabConfigSchema - Zod schema validation must reject invalid tab configs
// ---------------------------------------------------------------------------
describe('Fuzz: TabConfigSchema', () => {
  it('safeParse never throws on arbitrary objects', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = TabConfigSchema.safeParse(input);
        expect(typeof result.success).toBe('boolean');
        // safeParse must ALWAYS return a result, never throw
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects tab IDs outside 1-6 range', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^[1-6]$/.test(s)),
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 50 }),
        (id, command, label) => {
          const result = TabConfigSchema.safeParse({ id, command, label });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects oversized command (>200 chars)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('1', '2', '3', '4', '5', '6'),
        fc.string({ minLength: 201, maxLength: 500 }),
        fc.string({ maxLength: 50 }),
        (id, command, label) => {
          const result = TabConfigSchema.safeParse({ id, command, label });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects oversized label (>50 chars)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('1', '2', '3', '4', '5', '6'),
        fc.string({ maxLength: 200 }),
        fc.string({ minLength: 51, maxLength: 200 }),
        (id, command, label) => {
          const result = TabConfigSchema.safeParse({ id, command, label });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts valid tab configs with IDs 1-6', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('1', '2', '3', '4', '5', '6'),
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 50 }),
        (id, command, label) => {
          const result = TabConfigSchema.safeParse({ id, command, label });
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects non-string field types', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (badValue) => {
          const result = TabConfigSchema.safeParse({ id: badValue, command: 'bash', label: 'shell' });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// createLogger / setLogLevel - logger must never throw on arbitrary data
// ---------------------------------------------------------------------------
describe('Fuzz: createLogger / setLogLevel', () => {
  it('createLogger never throws on arbitrary module name and context', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.dictionary(fc.string(), fc.anything()),
        (moduleName, context) => {
          // Must not throw - logger creation is unconditional
          const logger = createLogger(moduleName, context);
          expect(typeof logger.debug).toBe('function');
          expect(typeof logger.info).toBe('function');
          expect(typeof logger.warn).toBe('function');
          expect(typeof logger.error).toBe('function');
          expect(typeof logger.child).toBe('function');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('log methods never throw on arbitrary data', () => {
    // Set to silent to avoid console noise during fuzz runs
    setLogLevel('silent');
    fc.assert(
      fc.property(
        fc.string(),
        fc.dictionary(fc.string(), fc.anything()),
        (message, data) => {
          const logger = createLogger('fuzz-test');
          // None of these should throw
          logger.debug(message, data);
          logger.info(message, data);
          logger.warn(message, data);
          logger.error(message, new Error('test'), data);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('setLogLevel accepts all valid log levels without throwing', () => {
    const levels = ['debug', 'info', 'warn', 'error', 'silent'] as const;
    for (const level of levels) {
      expect(() => setLogLevel(level)).not.toThrow();
    }
    // Reset to silent for remaining tests
    setLogLevel('silent');
  });

  it('child logger inherits and merges context', () => {
    setLogLevel('silent');
    fc.assert(
      fc.property(
        fc.string(),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()),
        (moduleName, parentCtx, childCtx) => {
          const parent = createLogger(moduleName, parentCtx);
          const child = parent.child(childCtx);
          // Child must be a valid logger - never throws
          expect(typeof child.info).toBe('function');
          child.info('test');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('error serialization handles arbitrary Error subclasses', () => {
    setLogLevel('silent');
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        (name, message) => {
          const err = new Error(message);
          err.name = name;
          const logger = createLogger('fuzz-error');
          // Must not throw even with unusual error properties
          logger.error('test error', err);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// toApiSession - must strip userId and lastStatusCheck, preserve rest
// ---------------------------------------------------------------------------
describe('Fuzz: toApiSession', () => {
  it('always strips userId and lastStatusCheck', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string(),
          name: fc.string(),
          userId: fc.string(),
          createdAt: fc.string(),
          lastAccessedAt: fc.string(),
          status: fc.oneof(fc.constant('stopped' as const), fc.constant('running' as const), fc.constant(undefined)),
          lastStatusCheck: fc.oneof(fc.integer(), fc.constant(undefined)),
          lastStartedAt: fc.oneof(fc.string(), fc.constant(undefined)),
          lastActiveAt: fc.oneof(fc.string(), fc.constant(undefined)),
          agentType: fc.oneof(fc.string(), fc.constant(undefined)),
        }),
        (session) => {
          const result = toApiSession(session as any);
          // userId and lastStatusCheck MUST be stripped
          expect('userId' in result).toBe(false);
          expect('lastStatusCheck' in result).toBe(false);
          // Other fields must be preserved
          expect(result.id).toBe(session.id);
          expect(result.name).toBe(session.name);
          expect(result.createdAt).toBe(session.createdAt);
          expect(result.lastAccessedAt).toBe(session.lastAccessedAt);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not mutate the original session object', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        (id, name, userId) => {
          const session = {
            id,
            name,
            userId,
            createdAt: '2024-01-01T00:00:00Z',
            lastAccessedAt: '2024-01-01T00:00:00Z',
            lastStatusCheck: 12345,
          };
          const original = { ...session };
          toApiSession(session as any);
          // Original must not be mutated
          expect(session).toEqual(original);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves optional fields when present', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        (agentType, lastStartedAt, lastActiveAt) => {
          const session = {
            id: 'test',
            name: 'test',
            userId: 'user@test.com',
            createdAt: '2024-01-01T00:00:00Z',
            lastAccessedAt: '2024-01-01T00:00:00Z',
            agentType,
            lastStartedAt,
            lastActiveAt,
          };
          const result = toApiSession(session as any);
          expect(result.agentType).toBe(agentType);
          expect(result.lastStartedAt).toBe(lastStartedAt);
          expect(result.lastActiveAt).toBe(lastActiveAt);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// cache-reset state machine - model-based testing with fc.commands()
// ---------------------------------------------------------------------------
describe('Fuzz: cache-reset state machine', () => {
  // Model: tracks what setupCompleteCache should be
  class CacheModel {
    value: boolean | null = null;
  }

  class CacheReal {
    // Uses the actual module functions
  }

  class SetCacheCommand implements fc.Command<CacheModel, CacheReal> {
    constructor(readonly value: boolean | null) {}
    check(): boolean {
      return true;
    }
    run(m: CacheModel, _r: CacheReal): void {
      setSetupCompleteCache(this.value);
      m.value = this.value;
      expect(getSetupCompleteCache()).toBe(m.value);
    }
    toString(): string {
      return `set(${this.value})`;
    }
  }

  class GetCacheCommand implements fc.Command<CacheModel, CacheReal> {
    check(): boolean {
      return true;
    }
    run(m: CacheModel, _r: CacheReal): void {
      const actual = getSetupCompleteCache();
      expect(actual).toBe(m.value);
    }
    toString(): string {
      return 'get()';
    }
  }

  class ResetCacheCommand implements fc.Command<CacheModel, CacheReal> {
    check(): boolean {
      return true;
    }
    run(m: CacheModel, _r: CacheReal): void {
      resetSetupCache();
      m.value = null;
      expect(getSetupCompleteCache()).toBe(null);
    }
    toString(): string {
      return 'reset()';
    }
  }

  const cacheCommands = [
    fc.constantFrom(true, false, null).map((v) => new SetCacheCommand(v)),
    fc.constant(new GetCacheCommand()),
    fc.constant(new ResetCacheCommand()),
  ];

  it('resetSetupCache always returns state to null regardless of prior state', () => {
    fc.assert(
      fc.property(
        fc.commands(cacheCommands, { maxCommands: 50 }),
        (cmds) => {
          // Reset to known state before each run
          resetSetupCache();
          const model = new CacheModel();
          const real = new CacheReal();
          fc.modelRun(() => ({ model, real }), cmds);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('set then get always returns the set value', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(true, false, null),
        (value) => {
          setSetupCompleteCache(value);
          expect(getSetupCompleteCache()).toBe(value);
        },
      ),
      { numRuns: Math.min(NUM_RUNS, 3) }, // only 3 possible values
    );
  });

  it('multiple resets are idempotent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (count) => {
          setSetupCompleteCache(true);
          for (let i = 0; i < count; i++) {
            resetSetupCache();
          }
          expect(getSetupCompleteCache()).toBe(null);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// SetupError, RateLimitError, CircuitBreakerOpenError - constructor + toJSON
// ---------------------------------------------------------------------------
describe('Fuzz: error-types constructors and toJSON', () => {
  it('SetupError toJSON has { success: false, steps, error, code } shape', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(
          fc.record({
            step: fc.string(),
            status: fc.string(),
            error: fc.oneof(fc.string(), fc.constant(undefined)),
          }),
          { maxLength: 10 },
        ),
        (message, steps) => {
          const err = new SetupError(message, steps);
          const json = err.toJSON();
          expect(json.success).toBe(false);
          expect(json.steps).toBe(steps);
          expect(json.error).toBe(message);
          expect(json.code).toBe('SETUP_ERROR');
          // SetupError extends AppError
          expect(err instanceof AppError).toBe(true);
          expect(err.statusCode).toBe(400);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('RateLimitError has correct defaults and toJSON shape', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constant(undefined)),
        (message) => {
          const err = message !== undefined ? new RateLimitError(message) : new RateLimitError();
          expect(err instanceof AppError).toBe(true);
          expect(err.statusCode).toBe(429);
          expect(err.code).toBe('RATE_LIMIT_ERROR');
          const json = err.toJSON();
          expect(typeof json.error).toBe('string');
          expect(json.code).toBe('RATE_LIMIT_ERROR');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('CircuitBreakerOpenError has correct shape for any service name', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (service) => {
          const err = new CircuitBreakerOpenError(service);
          expect(err instanceof AppError).toBe(true);
          expect(err.statusCode).toBe(503);
          expect(err.code).toBe('CIRCUIT_BREAKER_OPEN');
          expect(err.message).toContain(service);
          const json = err.toJSON();
          expect(json.code).toBe('CIRCUIT_BREAKER_OPEN');
          expect(typeof json.error).toBe('string');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('AppError subclass hierarchy is correct', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        (message, service) => {
          const setup = new SetupError(message, []);
          const rateLimit = new RateLimitError(message);
          const circuitBreaker = new CircuitBreakerOpenError(service);
          // All extend AppError
          expect(setup instanceof AppError).toBe(true);
          expect(rateLimit instanceof AppError).toBe(true);
          expect(circuitBreaker instanceof AppError).toBe(true);
          // All extend Error
          expect(setup instanceof Error).toBe(true);
          expect(rateLimit instanceof Error).toBe(true);
          expect(circuitBreaker instanceof Error).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('SetupError steps array is preserved exactly (no cloning)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            step: fc.string(),
            status: fc.constantFrom('pending', 'running', 'done', 'error'),
          }),
          { maxLength: 20 },
        ),
        (steps) => {
          const err = new SetupError('test', steps);
          // Reference equality - steps are not cloned
          expect(err.steps).toBe(steps);
          expect(err.toJSON().steps).toBe(steps);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// isTextContentType / isImageContentType - replicated from preview.ts (non-exported)
// ---------------------------------------------------------------------------
describe('Fuzz: isTextContentType / isImageContentType', () => {
  // Replicated from src/routes/storage/preview.ts (not exported)
  function isTextContentType(contentType: string): boolean {
    if (contentType.startsWith('text/')) return true;
    if (contentType === 'application/json') return true;
    if (contentType === 'application/xml') return true;
    if (contentType === 'application/javascript') return true;
    if (contentType === 'application/typescript') return true;
    if (contentType === 'application/x-yaml') return true;
    if (contentType === 'application/toml') return true;
    if (contentType === 'application/x-sh') return true;
    return false;
  }

  // Replicated from src/routes/storage/preview.ts (not exported)
  function isImageContentType(contentType: string): boolean {
    return contentType.startsWith('image/');
  }

  it('isTextContentType never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (ct) => {
        const result = isTextContentType(ct);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('isImageContentType never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (ct) => {
        const result = isImageContentType(ct);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('all text/* types are recognized as text', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9._-]{1,30}$/),
        (subtype) => {
          expect(isTextContentType(`text/${subtype}`)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('all image/* types are recognized as image', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9._+-]{1,30}$/),
        (subtype) => {
          expect(isImageContentType(`image/${subtype}`)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('text and image are mutually exclusive', () => {
    fc.assert(
      fc.property(fc.string(), (ct) => {
        const isText = isTextContentType(ct);
        const isImage = isImageContentType(ct);
        // A content type cannot be both text and image
        expect(isText && isImage).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('known application/* text types are recognized', () => {
    const textAppTypes = [
      'application/json',
      'application/xml',
      'application/javascript',
      'application/typescript',
      'application/x-yaml',
      'application/toml',
      'application/x-sh',
    ];
    for (const ct of textAppTypes) {
      expect(isTextContentType(ct)).toBe(true);
    }
  });

  it('unknown application/* types are not recognized as text', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,20}$/).filter(
          (s) => !['json', 'xml', 'javascript', 'typescript', 'x-yaml', 'toml', 'x-sh'].includes(s),
        ),
        (subtype) => {
          expect(isTextContentType(`application/${subtype}`)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('non-image non-text types return false for both', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('audio/', 'video/', 'font/', 'model/', 'multipart/'),
        fc.stringMatching(/^[a-z0-9._+-]{1,20}$/),
        (prefix, subtype) => {
          const ct = prefix + subtype;
          expect(isTextContentType(ct)).toBe(false);
          expect(isImageContentType(ct)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Session mode - agent config filtering invariants
// ---------------------------------------------------------------------------
describe('Session mode config filtering', () => {
  it('filtering by any valid mode always returns non-empty', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('default' as const, 'advanced' as const),
        (mode) => {
          const configs = getConfigsForMode(mode);
          expect(configs.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('"advanced" filtered count >= "default" filtered count', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const defaultCount = getConfigsForMode('default').length;
          const advancedCount = getConfigsForMode('advanced').length;
          expect(advancedCount).toBeGreaterThanOrEqual(defaultCount);
        },
      ),
      { numRuns: 10 },
    );
  });

  it('getPreseedKeysNotInMode("advanced", true) is always empty', () => {
    // contextModeEnabled=true: full advanced set is in scope, nothing to clean up.
    // The default for the optional flag is false (fail-closed for tier gating),
    // so omitting it would correctly flag context-mode keys for cleanup; pass
    // true here to assert the "advanced superset" property explicitly.
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          expect(getPreseedKeysNotInMode('advanced', true)).toEqual([]);
        },
      ),
      { numRuns: 10 },
    );
  });
});
