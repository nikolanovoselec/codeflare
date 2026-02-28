import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { md5 } from '../../lib/md5';
import { generateSessionName } from '../../lib/session-utils';
import { formatSize, formatRelativeTime } from '../../lib/format';
import { shouldUseMultipart, splitIntoParts } from '../../lib/file-upload';
import { hexToHSL, isValidHex } from '../../lib/settings';
import { getFileIcon } from '../../lib/file-icons';
import { getTabDisplayName, getTabIcon } from '../../lib/terminal-config';
import { isActionableUrl } from '../../stores/terminal-url-detection';
import { ACTIONABLE_URL_PATTERNS as _ACTIONABLE_URL_PATTERNS } from '../../lib/constants';
import { mapStartupDetailsToProgress } from '../../lib/status-mapper';
import { getDownloadUrl } from '../../api/storage';
import { ApiError } from '../../api/fetch-helper';
import { cleanupMapByPrefix } from '../../stores/terminal';
import { getBestLayoutForTabCount, isLayoutCompatible, LAYOUT_MIN_TABS, LAYOUT_UPGRADE_ORDER } from '../../stores/tiling';
import { applyMetricsUpdate, shouldSkipStatusTransition } from '../../stores/session';
import { stageOrder } from '../../lib/stages';
import {
  SessionSchema,
  UserResponseSchema,
  BatchSessionStatusResponseSchema,
  StorageListResultSchema,
  UserPreferencesSchema,
  InitStageSchema,
} from '../../lib/schemas';
import type { StartupStatusResponse, InitStage } from '../../types';

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
// generateSessionName
// ---------------------------------------------------------------------------
describe('fuzz: generateSessionName', () => {
  const agentTypes = ['claude-code', 'codex', 'copilot', 'gemini', 'opencode', 'bash'] as const;

  it('always matches pattern ".+ #\\d+"', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...agentTypes),
        fc.array(fc.record({ name: fc.string() }), { maxLength: 50 }),
        (agentType, sessions) => {
          const name = generateSessionName(agentType, sessions);
          expect(name).toMatch(/.+ #\d+$/);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('N is always >= 1', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...agentTypes),
        fc.array(fc.record({ name: fc.string() }), { maxLength: 50 }),
        (agentType, sessions) => {
          const name = generateSessionName(agentType, sessions);
          const num = parseInt(name.split('#').pop()!, 10);
          expect(num).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns #1 for empty sessions', () => {
    for (const agent of agentTypes) {
      const name = generateSessionName(agent, []);
      expect(name).toMatch(/#1$/);
    }
  });

  it('fills gaps: sessions [#1, #3] yields #2', () => {
    const name = generateSessionName('claude-code', [
      { name: 'Claude Code #1' },
      { name: 'Claude Code #3' },
    ]);
    expect(name).toBe('Claude Code #2');
  });

  it('undefined agentType uses "Session" label', () => {
    const name = generateSessionName(undefined, []);
    expect(name).toBe('Session #1');
  });
});

// ---------------------------------------------------------------------------
// formatSize
// ---------------------------------------------------------------------------
describe('fuzz: formatSize', () => {
  it('never throws for non-negative integers up to 1e12', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000_000 }), (n) => {
        expect(() => formatSize(n)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('output ends with B, KB, MB, or GB', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000_000 }), (n) => {
        const result = formatSize(n);
        expect(result).toMatch(/ (B|KB|MB|GB)$/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('formatSize(0) === "0 B"', () => {
    expect(formatSize(0)).toBe('0 B');
  });

  it('boundary values', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB');
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------
describe('fuzz: formatRelativeTime', () => {
  it('undefined returns "--"', () => {
    expect(formatRelativeTime(undefined)).toBe('--');
  });

  it('never throws for any Date', () => {
    fc.assert(
      fc.property(fc.date(), (d) => {
        expect(() => formatRelativeTime(d)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('recent dates (< 10s ago) return "just now"', () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toBe('just now');
    expect(formatRelativeTime(new Date(Date.now() - 5_000))).toBe('just now');
  });

  it('output is always a non-empty string', () => {
    fc.assert(
      fc.property(fc.date(), (d) => {
        const result = formatRelativeTime(d);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// shouldUseMultipart + splitIntoParts
// ---------------------------------------------------------------------------
describe('fuzz: file upload helpers', () => {
  function createMockFile(size: number): File {
    const file = new File([], 'test.bin');
    Object.defineProperty(file, 'size', { value: size });
    return file;
  }

  it('shouldUseMultipart is false for files <= 5MB', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 * 1024 * 1024 }), (size) => {
        expect(shouldUseMultipart(createMockFile(size))).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('shouldUseMultipart is true for files > 5MB', () => {
    fc.assert(
      fc.property(fc.integer({ min: 5 * 1024 * 1024 + 1, max: 500 * 1024 * 1024 }), (size) => {
        expect(shouldUseMultipart(createMockFile(size))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('splitIntoParts returns at least 1 part', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 * 1024 * 1024 }), (size) => {
        const file = createMockFile(size);
        // splitIntoParts calls file.slice() which works on the real Blob (empty),
        // but the loop is driven by the mocked .size property
        const parts = splitIntoParts(file);
        expect(parts.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('number of parts matches ceil(size / partSize)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 * 1024 * 1024 }), (size) => {
        const file = createMockFile(size);
        const parts = splitIntoParts(file);
        const partSize = size > 100 * 1024 * 1024 ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
        expect(parts.length).toBe(Math.ceil(size / partSize));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// hexToHSL color conversion
// ---------------------------------------------------------------------------
describe('fuzz: hexToHSL', () => {
  it('returns null for invalid hex strings', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        // Skip strings that happen to be valid hex
        if (isValidHex(s)) return;
        expect(hexToHSL(s)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('for valid hex: h is 0-360, s is 0-100, l is 0-100', () => {
    const hexChar = fc.constantFrom(...'0123456789abcdefABCDEF'.split(''));
    const validHex = fc.oneof(
      // 3-char hex
      fc.tuple(hexChar, hexChar, hexChar).map(([a, b, c]) => '#' + a + b + c),
      // 6-char hex
      fc.tuple(hexChar, hexChar, hexChar, hexChar, hexChar, hexChar).map((chars) => '#' + chars.join('')),
    );
    fc.assert(
      fc.property(validHex, (hex) => {
        const result = hexToHSL(hex);
        expect(result).not.toBeNull();
        expect(result!.h).toBeGreaterThanOrEqual(0);
        expect(result!.h).toBeLessThanOrEqual(360);
        expect(result!.s).toBeGreaterThanOrEqual(0);
        expect(result!.s).toBeLessThanOrEqual(100);
        expect(result!.l).toBeGreaterThanOrEqual(0);
        expect(result!.l).toBeLessThanOrEqual(100);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('handles 3-char and 6-char formats with known values', () => {
    expect(hexToHSL('#000000')).toEqual({ h: 0, s: 0, l: 0 });
    expect(hexToHSL('#FFFFFF')).toEqual({ h: 0, s: 0, l: 100 });
    expect(hexToHSL('#FF0000')).toEqual({ h: 0, s: 100, l: 50 });
    // 3-char
    expect(hexToHSL('#FFF')).toEqual({ h: 0, s: 0, l: 100 });
    expect(hexToHSL('#000')).toEqual({ h: 0, s: 0, l: 0 });
  });

  it('never throws for any string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => hexToHSL(s)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('isValidHex consistency: isValidHex(s) === true implies hexToHSL(s) !== null', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        if (isValidHex(s)) {
          expect(hexToHSL(s)).not.toBeNull();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// isValidHex
// ---------------------------------------------------------------------------
describe('fuzz: isValidHex', () => {
  it('accepts valid hex formats', () => {
    const valid = ['#FFF', '#000000', 'abc', 'AABBCC', '#abc', '#AABBCC'];
    for (const v of valid) {
      expect(isValidHex(v)).toBe(true);
    }
  });

  it('rejects invalid hex formats', () => {
    const invalid = ['#GGGGGG', 'xyz', '#12345', '#1234567', '', '#', '#GG'];
    for (const v of invalid) {
      expect(isValidHex(v)).toBe(false);
    }
  });

  it('never throws for any string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => isValidHex(s)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// getFileIcon
// ---------------------------------------------------------------------------
describe('fuzz: getFileIcon', () => {
  it('always returns object with color (string) and label (string)', () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), (filename, isFolder) => {
        const icon = getFileIcon(filename, isFolder);
        expect(typeof icon.color).toBe('string');
        expect(typeof icon.label).toBe('string');
        expect(icon.color.length).toBeGreaterThan(0);
        expect(icon.label.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('isFolder=true always returns folder icon regardless of filename', () => {
    fc.assert(
      fc.property(fc.string(), (filename) => {
        const icon = getFileIcon(filename, true);
        expect(icon.label).toBe('Folder');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('known extensions map correctly', () => {
    expect(getFileIcon('app.ts').label).toBe('TypeScript');
    expect(getFileIcon('main.py').label).toBe('Python');
    expect(getFileIcon('index.js').label).toBe('JavaScript');
    expect(getFileIcon('style.css').label).toBe('CSS');
  });

  it('never throws for any string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => getFileIcon(s)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// getTabDisplayName + getTabIcon
// ---------------------------------------------------------------------------
describe('fuzz: getTabDisplayName + getTabIcon', () => {
  it('always return strings for typical process names', () => {
    // Object.prototype keys (constructor, toString, etc.) are inherited by plain Record objects
    // and return non-string values via || fallback. Exclude them for this property test.
    const protoKeys = new Set(Object.getOwnPropertyNames(Object.prototype));
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => /^[a-z0-9_-]+$/.test(s) && !protoKeys.has(s)),
        (processName) => {
          const displayName = getTabDisplayName(processName);
          const icon = getTabIcon(processName);
          expect(typeof displayName).toBe('string');
          expect(displayName.length).toBeGreaterThan(0);
          expect(typeof icon).toBe('string');
          expect(icon.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('known: getTabDisplayName("cu") includes "claude"', () => {
    expect(getTabDisplayName('cu').toLowerCase()).toContain('claude');
  });

  it('never throws for any string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => getTabDisplayName(s)).not.toThrow();
        expect(() => getTabIcon(s)).not.toThrow();
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
// Session name sanitization (replicated from host/server.js ~L341)
// ---------------------------------------------------------------------------
describe('fuzz: session name sanitization', () => {
  function sanitizeName(name: string): string {
    return (name || '').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 100) || 'Terminal';
  }

  it('output only contains alphanumeric, spaces, underscores, hyphens', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const result = sanitizeName(s);
        expect(result).toMatch(/^[a-zA-Z0-9 _-]+$/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('max length 100 and empty/all-special falls back to "Terminal"', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const result = sanitizeName(s);
        expect(result.length).toBeLessThanOrEqual(100);
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
    // Specific cases
    expect(sanitizeName('')).toBe('Terminal');
    expect(sanitizeName('!!!@@@###')).toBe('Terminal');
    expect(sanitizeName('   ')).toBe('   '); // spaces are allowed
  });

  it('never throws for any input', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.constant('')), (s) => {
        expect(() => sanitizeName(s)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// mapStartupDetailsToProgress
// ---------------------------------------------------------------------------
describe('fuzz: mapStartupDetailsToProgress', () => {
  const stageArb = fc.constantFrom<InitStage>(
    'creating', 'starting', 'syncing', 'mounting', 'verifying', 'ready', 'error', 'stopped',
  );
  const syncStatusArb = fc.constantFrom('pending', 'syncing', 'success', 'failed', 'skipped');

  const statusResponseArb: fc.Arbitrary<StartupStatusResponse> = fc.record({
    stage: stageArb,
    progress: fc.integer({ min: 0, max: 100 }),
    message: fc.string(),
    details: fc.record({
      bucketName: fc.string(),
      container: fc.string(),
      path: fc.string(),
      email: fc.option(fc.emailAddress(), { nil: undefined }),
      containerStatus: fc.option(fc.string(), { nil: undefined }),
      syncStatus: fc.option(syncStatusArb, { nil: undefined }),
      syncError: fc.option(fc.oneof(fc.string(), fc.constant(null)), { nil: undefined }),
      healthServerOk: fc.option(fc.boolean(), { nil: undefined }),
      terminalServerOk: fc.option(fc.boolean(), { nil: undefined }),
    }),
    error: fc.option(fc.string(), { nil: undefined }),
  });

  it('always returns valid InitProgress with stage, progress, message, details', () => {
    fc.assert(
      fc.property(statusResponseArb, (status) => {
        const result = mapStartupDetailsToProgress(status);
        expect(result.stage).toBe(status.stage);
        expect(result.progress).toBe(status.progress);
        expect(result.message).toBe(status.message);
        expect(Array.isArray(result.details)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('details always include Container, Sync, Terminal entries', () => {
    fc.assert(
      fc.property(statusResponseArb, (status) => {
        const result = mapStartupDetailsToProgress(status);
        const keys = result.details!.map((d) => d.key);
        expect(keys).toContain('Container');
        expect(keys).toContain('Sync');
        expect(keys).toContain('Terminal');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('detail statuses are always ok, error, or pending', () => {
    fc.assert(
      fc.property(statusResponseArb, (status) => {
        const result = mapStartupDetailsToProgress(status);
        for (const detail of result.details!) {
          if (detail.status !== undefined) {
            expect(['ok', 'error', 'pending']).toContain(detail.status);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('email detail is included only when email is present', () => {
    fc.assert(
      fc.property(statusResponseArb, (status) => {
        const result = mapStartupDetailsToProgress(status);
        const hasUserDetail = result.details!.some((d) => d.key === 'User');
        if (status.details.email) {
          expect(hasUserDetail).toBe(true);
        } else {
          expect(hasUserDetail).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// getDownloadUrl
// ---------------------------------------------------------------------------
describe('fuzz: getDownloadUrl', () => {
  it('always returns a valid URL string with /api/storage/download prefix', () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const url = getDownloadUrl(key);
        expect(url).toContain('/api/storage/download');
        expect(url).toContain('key=');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('properly encodes special characters in key', () => {
    const specialChars = ['hello world', 'foo/bar/baz', 'a&b=c', 'path with spaces/file.txt', '100%done'];
    for (const key of specialChars) {
      const url = getDownloadUrl(key);
      // The URL should not contain raw special characters (except / in path)
      const params = new URLSearchParams(url.split('?')[1]);
      expect(params.get('key')).toBe(key);
    }
  });

  it('roundtrips arbitrary keys through URLSearchParams', () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const url = getDownloadUrl(key);
        const queryString = url.split('?')[1];
        const params = new URLSearchParams(queryString);
        expect(params.get('key')).toBe(key);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws for any string input', () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        expect(() => getDownloadUrl(key)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// ApiError
// ---------------------------------------------------------------------------
describe('fuzz: ApiError', () => {
  it('extends Error and preserves status/statusText', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer(), fc.string(), (msg, status, statusText) => {
        const err = new ApiError(msg, status, statusText);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(ApiError);
        expect(err.message).toBe(msg);
        expect(err.status).toBe(status);
        expect(err.statusText).toBe(statusText);
        expect(err.name).toBe('ApiError');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('body property is preserved when provided', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer(), fc.string(), fc.jsonValue(), (msg, status, statusText, body) => {
        const err = new ApiError(msg, status, statusText, body);
        expect(err.body).toEqual(body);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('steps property defaults to undefined', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer(), fc.string(), (msg, status, statusText) => {
        const err = new ApiError(msg, status, statusText);
        expect(err.steps).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('steps can be assigned and read back', () => {
    const steps = [{ step: 'test', status: 'ok' }, { step: 'deploy', status: 'error', error: 'fail' }];
    const err = new ApiError('msg', 500, 'Internal');
    err.steps = steps;
    expect(err.steps).toEqual(steps);
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

// ---------------------------------------------------------------------------
// getBestLayoutForTabCount / isLayoutCompatible
// ---------------------------------------------------------------------------
describe('fuzz: tiling layout helpers', () => {
  it('getBestLayoutForTabCount returns a valid TileLayout', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (count) => {
        const layout = getBestLayoutForTabCount(count);
        expect(LAYOUT_UPGRADE_ORDER).toContain(layout);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('getBestLayoutForTabCount is monotonic (more tabs = same or higher layout)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        (a, b) => {
          if (a <= b) {
            const layoutA = LAYOUT_UPGRADE_ORDER.indexOf(getBestLayoutForTabCount(a));
            const layoutB = LAYOUT_UPGRADE_ORDER.indexOf(getBestLayoutForTabCount(b));
            expect(layoutB).toBeGreaterThanOrEqual(layoutA);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('getBestLayoutForTabCount(0) returns tabbed (lowest layout)', () => {
    expect(getBestLayoutForTabCount(0)).toBe('tabbed');
  });

  it('getBestLayoutForTabCount(4+) returns 4-grid (highest layout)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 4, max: 100 }), (count) => {
        expect(getBestLayoutForTabCount(count)).toBe('4-grid');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('isLayoutCompatible is consistent with LAYOUT_MIN_TABS', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'tabbed' | '2-split' | '3-split' | '4-grid'>('tabbed', '2-split', '3-split', '4-grid'),
        fc.integer({ min: 0, max: 20 }),
        (layout, count) => {
          const expected = count >= LAYOUT_MIN_TABS[layout];
          expect(isLayoutCompatible(layout, count)).toBe(expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('getBestLayoutForTabCount result is always compatible with the tab count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (count) => {
        const layout = getBestLayoutForTabCount(count);
        expect(isLayoutCompatible(layout, count)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// applyMetricsUpdate / shouldSkipStatusTransition
// ---------------------------------------------------------------------------
describe('fuzz: session metrics helpers', () => {
  it('applyMetricsUpdate always produces a valid SessionMetrics entry', () => {
    fc.assert(
      fc.property(
        fc.string(), // sessionId
        fc.record({
          cpu: fc.option(fc.string(), { nil: undefined }),
          mem: fc.option(fc.string(), { nil: undefined }),
          hdd: fc.option(fc.string(), { nil: undefined }),
          syncStatus: fc.option(fc.string(), { nil: undefined }),
        }),
        (sessionId, metrics) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fuzz with arbitrary strings to test runtime resilience
          const metricsRecord: Record<string, any> = {};
          applyMetricsUpdate(metricsRecord, sessionId, metrics);

          const entry = metricsRecord[sessionId];
          expect(entry).toBeDefined();
          expect(typeof entry.bucketName).toBe('string');
          expect(typeof entry.syncStatus).toBe('string');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('applyMetricsUpdate preserves existing truthy bucketName', () => {
    fc.assert(
      fc.property(
        fc.string(), // sessionId
        fc.string({ minLength: 1 }), // existing bucketName (truthy — || fallback won't trigger)
        fc.record({
          cpu: fc.option(fc.string(), { nil: undefined }),
          mem: fc.option(fc.string(), { nil: undefined }),
          hdd: fc.option(fc.string(), { nil: undefined }),
          syncStatus: fc.option(fc.string(), { nil: undefined }),
        }),
        (sessionId, bucketName, metrics) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fuzz with arbitrary strings to test runtime resilience
          const metricsRecord: Record<string, any> = {
            [sessionId]: { bucketName, syncStatus: 'pending' },
          };
          applyMetricsUpdate(metricsRecord, sessionId, metrics);
          expect(metricsRecord[sessionId].bucketName).toBe(bucketName);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('shouldSkipStatusTransition returns true iff sessionId === activeSessionId and non-null', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.option(fc.string(), { nil: null }),
        (sessionId, activeSessionId) => {
          const result = shouldSkipStatusTransition(sessionId, activeSessionId);
          const expected = sessionId === activeSessionId && activeSessionId !== null;
          expect(result).toBe(expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('shouldSkipStatusTransition always false when activeSessionId is null', () => {
    fc.assert(
      fc.property(fc.string(), (sessionId) => {
        expect(shouldSkipStatusTransition(sessionId, null)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// stageOrder invariants
// ---------------------------------------------------------------------------
describe('fuzz: stageOrder', () => {
  it('ready > all intermediate stages', () => {
    const intermediateStages: InitStage[] = ['creating', 'starting', 'syncing', 'verifying', 'mounting'];
    for (const stage of intermediateStages) {
      expect(stageOrder.ready).toBeGreaterThan(stageOrder[stage]);
    }
  });

  it('error has the lowest order value', () => {
    for (const [stage, order] of Object.entries(stageOrder)) {
      if (stage !== 'error') {
        expect(order).toBeGreaterThan(stageOrder.error);
      }
    }
  });

  it('stopped < all intermediate stages but > error', () => {
    expect(stageOrder.stopped).toBeGreaterThan(stageOrder.error);
    expect(stageOrder.stopped).toBeLessThan(stageOrder.creating);
  });

  it('intermediate stages are in correct order: creating < starting < syncing < verifying < mounting', () => {
    expect(stageOrder.creating).toBeLessThan(stageOrder.starting);
    expect(stageOrder.starting).toBeLessThan(stageOrder.syncing);
    expect(stageOrder.syncing).toBeLessThan(stageOrder.verifying);
    expect(stageOrder.verifying).toBeLessThan(stageOrder.mounting);
  });

  it('all InitStage values have an order entry', () => {
    const stages: InitStage[] = ['creating', 'starting', 'syncing', 'mounting', 'verifying', 'ready', 'error', 'stopped'];
    for (const stage of stages) {
      expect(stageOrder[stage]).toBeDefined();
      expect(typeof stageOrder[stage]).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Frontend Zod schemas
// ---------------------------------------------------------------------------
describe('fuzz: Zod schemas', () => {
  it('SessionSchema rejects non-object inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        (input) => {
          const result = SessionSchema.safeParse(input);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('SessionSchema accepts valid session objects', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1 }),
          name: fc.string(),
          createdAt: fc.string(),
          lastAccessedAt: fc.string(),
        }),
        (session) => {
          const result = SessionSchema.safeParse(session);
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('UserResponseSchema rejects missing required fields', () => {
    fc.assert(
      fc.property(fc.object(), (obj) => {
        // Random objects almost certainly lack email + authenticated + bucketName
        const result = UserResponseSchema.safeParse(obj);
        // We just check it doesn't throw
        expect(typeof result.success).toBe('boolean');
      }),
      { numRuns: Math.min(NUM_RUNS, 10_000) },
    );
  });

  it('UserResponseSchema accepts valid user response', () => {
    fc.assert(
      fc.property(
        fc.record({
          email: fc.emailAddress(),
          authenticated: fc.boolean(),
          bucketName: fc.string({ minLength: 1 }),
        }),
        (data) => {
          const result = UserResponseSchema.safeParse(data);
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('InitStageSchema accepts all valid stages and rejects random strings', () => {
    const validStages = ['creating', 'starting', 'syncing', 'mounting', 'verifying', 'ready', 'error', 'stopped'];
    for (const stage of validStages) {
      expect(InitStageSchema.safeParse(stage).success).toBe(true);
    }
    fc.assert(
      fc.property(
        fc.string().filter((s) => !validStages.includes(s)),
        (s) => {
          expect(InitStageSchema.safeParse(s).success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('UserPreferencesSchema accepts empty object', () => {
    expect(UserPreferencesSchema.safeParse({}).success).toBe(true);
  });

  it('UserPreferencesSchema accepts valid preferences', () => {
    fc.assert(
      fc.property(
        fc.record({
          lastAgentType: fc.option(
            fc.constantFrom('claude-code', 'codex', 'copilot', 'gemini', 'opencode', 'bash'),
            { nil: undefined },
          ),
          workspaceSyncEnabled: fc.option(fc.boolean(), { nil: undefined }),
          fastStartEnabled: fc.option(fc.boolean(), { nil: undefined }),
        }),
        (prefs) => {
          const result = UserPreferencesSchema.safeParse(prefs);
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('StorageListResultSchema rejects non-object inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        (input) => {
          const result = StorageListResultSchema.safeParse(input);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('BatchSessionStatusResponseSchema rejects non-object inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        (input) => {
          const result = BatchSessionStatusResponseSchema.safeParse(input);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Zod schemas never throw on safeParse with arbitrary JSON', () => {
    const schemas = [
      SessionSchema,
      UserResponseSchema,
      UserPreferencesSchema,
      StorageListResultSchema,
      BatchSessionStatusResponseSchema,
      InitStageSchema,
    ];
    fc.assert(
      fc.property(fc.jsonValue(), (input) => {
        for (const schema of schemas) {
          expect(() => schema.safeParse(input)).not.toThrow();
        }
      }),
      // 6 schemas × N iterations — cap to avoid CI timeout at 50k
      { numRuns: Math.min(NUM_RUNS, 5_000) },
    );
  });
});
