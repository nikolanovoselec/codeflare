import { describe, it, expect, beforeEach } from 'vitest';
import {
  emailFromKvKey,
  sanitizeSessionName,
  getSessionKey,
  getSessionPrefix,
  generateSessionId,
  getSessionOrThrow,
  listAllKvKeys,
  getTiersConfigKey,
  getTimekeeperKey,
  getUtcDateString,
  getUtcMonthString,
  getIsoWeekStart,
  SETUP_KEYS,
  getMetricsKey,
} from '../../lib/kv-keys';
import { NotFoundError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

describe('emailFromKvKey', () => {
  it('strips user: prefix from key', () => {
    expect(emailFromKvKey('user:alice@example.com')).toBe('alice@example.com');
  });

  it('returns key unchanged if no user: prefix', () => {
    expect(emailFromKvKey('alice@example.com')).toBe('alice@example.com');
  });

  it('strips only first user: prefix', () => {
    expect(emailFromKvKey('user:user:nested')).toBe('user:nested');
  });
});

describe('sanitizeSessionName', () => {
  it('keeps alphanumeric, spaces, hyphens, and underscores', () => {
    expect(sanitizeSessionName('My Session-1_test')).toBe('My Session-1_test');
  });

  it('strips shell metacharacters', () => {
    // $, (, ), / are stripped; then .trim() removes trailing space
    expect(sanitizeSessionName('$(rm -rf /)')).toBe('rm -rf');
  });

  it('strips pipe and semicolons', () => {
    expect(sanitizeSessionName('foo|bar;baz')).toBe('foobarbaz');
  });

  it('strips backticks', () => {
    expect(sanitizeSessionName('`whoami`')).toBe('whoami');
  });

  it('falls back to Untitled for empty string', () => {
    expect(sanitizeSessionName('')).toBe('Untitled');
  });

  it('falls back to Untitled when only special chars', () => {
    expect(sanitizeSessionName('${}|;&`')).toBe('Untitled');
  });

  it('trims whitespace after sanitization', () => {
    expect(sanitizeSessionName('  hello  ')).toBe('hello');
  });

  it('preserves # character in session names like "Claude Code #1"', () => {
    expect(sanitizeSessionName('Claude Code #1')).toBe('Claude Code #1');
  });

  it('preserves # in various positions', () => {
    expect(sanitizeSessionName('Bash #3')).toBe('Bash #3');
    expect(sanitizeSessionName('Session #10')).toBe('Session #10');
  });
});

describe('getSessionKey', () => {
  it('formats session:{bucket}:{id}', () => {
    expect(getSessionKey('codeflare-alice', 'abc123')).toBe('session:codeflare-alice:abc123');
  });
});

describe('getSessionPrefix', () => {
  it('formats session:{bucket}:', () => {
    expect(getSessionPrefix('codeflare-alice')).toBe('session:codeflare-alice:');
  });
});

describe('generateSessionId', () => {
  it('produces a 24-char lowercase hex string', () => {
    const id = generateSessionId();
    expect(id).toHaveLength(24);
    expect(id).toMatch(/^[a-f0-9]{24}$/);
  });

  it('produces unique IDs on successive calls', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateSessionId()));
    expect(ids.size).toBe(10);
  });
});

describe('getSessionOrThrow', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  it('returns session when it exists', async () => {
    const session = { id: 'abc123', name: 'Test', createdAt: '2024-01-01', lastAccessedAt: '2024-01-01' };
    mockKV._set('session:bucket:abc123', session);

    const result = await getSessionOrThrow(mockKV as unknown as KVNamespace, 'session:bucket:abc123');
    expect(result).toEqual(session);
  });

  it('throws NotFoundError when session does not exist', async () => {
    await expect(
      getSessionOrThrow(mockKV as unknown as KVNamespace, 'session:bucket:nonexistent')
    ).rejects.toThrow(NotFoundError);
  });

  it('thrown error has correct message', async () => {
    await expect(
      getSessionOrThrow(mockKV as unknown as KVNamespace, 'session:bucket:missing')
    ).rejects.toThrow('Session not found');
  });
});

describe('listAllKvKeys', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  it('returns all keys with matching prefix', async () => {
    mockKV._set('session:bucket:a', {});
    mockKV._set('session:bucket:b', {});
    mockKV._set('session:other:c', {});

    const keys = await listAllKvKeys(mockKV as unknown as KVNamespace, 'session:bucket:');
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.name)).toContain('session:bucket:a');
    expect(keys.map((k) => k.name)).toContain('session:bucket:b');
  });

  it('returns empty array when no keys match', async () => {
    mockKV._set('other:key', {});

    const keys = await listAllKvKeys(mockKV as unknown as KVNamespace, 'session:bucket:');
    expect(keys).toHaveLength(0);
  });

  it('handles pagination across multiple list calls', async () => {
    // Simulate paginated KV response
    let callCount = 0;
    mockKV.list.mockImplementation(async (_opts?: { prefix?: string; cursor?: string }) => {
      callCount++;
      if (callCount === 1) {
        return {
          keys: [{ name: 'key:1' }, { name: 'key:2' }],
          list_complete: false,
          cursor: 'next-cursor',
        };
      }
      return {
        keys: [{ name: 'key:3' }],
        list_complete: true,
      };
    });

    const keys = await listAllKvKeys(mockKV as unknown as KVNamespace, 'key:');
    expect(keys).toHaveLength(3);
    expect(callCount).toBe(2);
  });

  it('respects MAX_KV_LIST_ITERATIONS to prevent infinite loops', async () => {
    // Return an infinite paginated response - should stop after 100 iterations
    let callCount = 0;
    mockKV.list.mockImplementation(async () => {
      callCount++;
      return {
        keys: [{ name: `key:${callCount}` }],
        list_complete: false,
        cursor: `cursor-${callCount}`,
      };
    });

    const keys = await listAllKvKeys(mockKV as unknown as KVNamespace, 'key:');
    // Should stop at 100 iterations (MAX_KV_LIST_ITERATIONS)
    expect(callCount).toBe(100);
    expect(keys).toHaveLength(100);
  });
});

describe('getTiersConfigKey', () => {
  it('returns tiers:config', () => {
    expect(getTiersConfigKey()).toBe('tiers:config');
  });
});

describe('getTimekeeperKey', () => {
  it('returns timekeeper:{bucketName}', () => {
    expect(getTimekeeperKey('codeflare-alice')).toBe('timekeeper:codeflare-alice');
  });

  it('handles bucket names with special chars', () => {
    expect(getTimekeeperKey('cf-user-test-123')).toBe('timekeeper:cf-user-test-123');
  });
});

describe('getUtcDateString', () => {
  it('returns YYYY-MM-DD in UTC', () => {
    const date = new Date('2026-03-18T15:30:00Z');
    expect(getUtcDateString(date)).toBe('2026-03-18');
  });

  it('uses UTC regardless of time', () => {
    // 23:30 UTC on March 18 is still March 18 in UTC
    const date = new Date('2026-03-18T23:30:00Z');
    expect(getUtcDateString(date)).toBe('2026-03-18');
  });

  it('pads single-digit months and days', () => {
    const date = new Date('2026-01-05T00:00:00Z');
    expect(getUtcDateString(date)).toBe('2026-01-05');
  });
});

describe('getUtcMonthString', () => {
  it('returns YYYY-MM in UTC', () => {
    const date = new Date('2026-03-18T15:30:00Z');
    expect(getUtcMonthString(date)).toBe('2026-03');
  });

  it('pads single-digit months', () => {
    const date = new Date('2026-01-05T00:00:00Z');
    expect(getUtcMonthString(date)).toBe('2026-01');
  });

  it('handles December correctly', () => {
    const date = new Date('2026-12-31T23:59:59Z');
    expect(getUtcMonthString(date)).toBe('2026-12');
  });
});

describe('getIsoWeekStart', () => {
  it('returns Monday date string for a Wednesday', () => {
    // 2026-03-18 is a Wednesday, Monday is 2026-03-16
    const date = new Date('2026-03-18T12:00:00Z');
    expect(getIsoWeekStart(date)).toBe('2026-03-16');
  });

  it('returns same date for a Monday', () => {
    // 2026-03-16 is a Monday
    const date = new Date('2026-03-16T12:00:00Z');
    expect(getIsoWeekStart(date)).toBe('2026-03-16');
  });

  it('returns Monday for a Sunday', () => {
    // 2026-03-22 is a Sunday, Monday is 2026-03-16
    const date = new Date('2026-03-22T12:00:00Z');
    expect(getIsoWeekStart(date)).toBe('2026-03-16');
  });

  it('handles year boundary (Dec 31 → previous Monday)', () => {
    // 2025-12-31 is a Wednesday, Monday is 2025-12-29
    const date = new Date('2025-12-31T12:00:00Z');
    expect(getIsoWeekStart(date)).toBe('2025-12-29');
  });

  it('handles week spanning year boundary (Jan 1 → previous year Monday)', () => {
    // 2026-01-01 is a Thursday, Monday is 2025-12-29
    const date = new Date('2026-01-01T12:00:00Z');
    expect(getIsoWeekStart(date)).toBe('2025-12-29');
  });

  it('handles first Monday of year', () => {
    // 2026-01-05 is a Monday
    const date = new Date('2026-01-05T12:00:00Z');
    expect(getIsoWeekStart(date)).toBe('2026-01-05');
  });
});

describe('getMetricsKey', () => {
  it('returns metrics:{bucketName}:{sessionId}', () => {
    expect(getMetricsKey('cf-alice', 'abc123')).toBe('metrics:cf-alice:abc123');
  });
});

describe('SETUP_KEYS', () => {
  it('contains 20 setup keys', () => {
    expect(Object.keys(SETUP_KEYS)).toHaveLength(20);
  });

  it('all values start with "setup:"', () => {
    for (const value of Object.values(SETUP_KEYS)) {
      expect(value).toMatch(/^setup:/);
    }
  });

  it('all values are unique', () => {
    const values = Object.values(SETUP_KEYS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('has correct values for commonly used keys', () => {
    expect(SETUP_KEYS.CUSTOM_DOMAIN).toBe('setup:custom_domain');
    expect(SETUP_KEYS.ACCOUNT_ID).toBe('setup:account_id');
    expect(SETUP_KEYS.TURNSTILE_SITE_KEY).toBe('setup:turnstile_site_key');
    expect(SETUP_KEYS.MAX_USERS).toBe('setup:max_users');
    expect(SETUP_KEYS.COMPLETE).toBe('setup:complete');
    expect(SETUP_KEYS.IDP_LIST).toBe('setup:idp_list');
  });
});
