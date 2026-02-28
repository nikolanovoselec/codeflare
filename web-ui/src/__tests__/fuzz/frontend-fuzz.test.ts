import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { md5 } from '../../lib/md5';
import { isActionableUrl } from '../../stores/terminal-url-detection';
import { cleanupMapByPrefix } from '../../stores/terminal';

const NUM_RUNS = parseInt(process.env.FAST_CHECK_NUM_RUNS || '1000');

// ---------------------------------------------------------------------------
// MD5
// ---------------------------------------------------------------------------
describe('fuzz: md5', () => {
  it('always produces a 32-char hex string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const hash = md5(s);
        expect(hash).toMatch(/^[0-9a-f]{32}$/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(md5(s)).toBe(md5(s));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('matches known test vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('never throws on any string input', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => md5(s)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('different inputs produce different hashes (statistical)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        fc.pre(a !== b);
        expect(md5(a)).not.toBe(md5(b));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// isActionableUrl / ACTIONABLE_URL_PATTERNS ReDoS
// ---------------------------------------------------------------------------
describe('fuzz: isActionableUrl', () => {
  it('returns true for known auth URLs', () => {
    const authUrls = [
      'https://github.com/login/device?code=ABCD-1234',
      'https://accounts.google.com/o/oauth2/auth?client_id=123',
      'https://console.anthropic.com/settings',
      'https://example.com/oauth/authorize?redirect_uri=http://localhost',
      'https://example.com/device/code',
    ];
    for (const url of authUrls) {
      expect(isActionableUrl(url)).toBe(true);
    }
  });

  it('returns false for normal URLs', () => {
    const normalUrls = [
      'https://example.com',
      'https://google.com/search?q=test',
      'https://github.com/user/repo',
      'http://localhost:3000',
    ];
    for (const url of normalUrls) {
      expect(isActionableUrl(url)).toBe(false);
    }
  });

  it('ReDoS resistance: pathological URL strings complete in <500ms', () => {
    // Craft pathological inputs that could cause catastrophic backtracking
    const pathological = [
      'https://' + 'a'.repeat(10000) + '/oauth/authorize',
      'https://example.com/' + '/'.repeat(10000),
      'https://' + 'a/'.repeat(5000),
      'https://accounts.google.com' + '/o/oauth2'.repeat(1000),
    ];
    for (const url of pathological) {
      const start = performance.now();
      isActionableUrl(url);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(500);
    }
  });

  it('never throws for any string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => isActionableUrl(s)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// cleanupMapByPrefix
// ---------------------------------------------------------------------------
describe('fuzz: cleanupMapByPrefix', () => {
  it('removes only keys matching the prefix', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string(), fc.integer()), { maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (entries, prefix) => {
          const map = new Map<string, number>(entries);
          const originalSize = map.size;
          const matchingBefore = [...map.keys()].filter((k) => k.startsWith(prefix)).length;
          const nonMatchingBefore = originalSize - matchingBefore;

          cleanupMapByPrefix(map, prefix);

          // No keys with the prefix remain
          for (const key of map.keys()) {
            expect(key.startsWith(prefix)).toBe(false);
          }
          // Non-matching keys are untouched
          expect(map.size).toBe(nonMatchingBefore);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('calls teardown on each removed value', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string(), fc.integer()), { minLength: 1, maxLength: 20 }),
        (entries) => {
          const map = new Map<string, number>(entries);
          // Use first key's prefix (first char)
          const firstKey = [...map.keys()][0];
          const prefix = firstKey.charAt(0);
          const expectedRemovals = [...map.entries()].filter(([k]) => k.startsWith(prefix));

          const tornDown: number[] = [];
          cleanupMapByPrefix(map, prefix, (val) => tornDown.push(val));

          expect(tornDown.length).toBe(expectedRemovals.length);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('empty prefix removes all keys', () => {
    const map = new Map([['a', 1], ['b', 2], ['c', 3]]);
    cleanupMapByPrefix(map, '');
    expect(map.size).toBe(0);
  });

  it('no-op on empty map', () => {
    const map = new Map<string, number>();
    cleanupMapByPrefix(map, 'anything');
    expect(map.size).toBe(0);
  });
});
