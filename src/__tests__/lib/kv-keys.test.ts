import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  getNextUtcMonthStart,
  getIsoWeekStart,
  SETUP_KEYS,
  buildSessionMetadata,
  expandSessionMetadata,
  putSessionWithMetadata,
  reconcileStaleStatus,
  STALE_RUNNING_MS,
  getBaseUrl,
} from '../../lib/kv-keys';
import type { Session } from '../../types';
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
          keys: [{ name: 'key:1', metadata: null }, { name: 'key:2', metadata: null }],
          list_complete: false as boolean,
          cursor: 'next-cursor',
        };
      }
      return {
        keys: [{ name: 'key:3', metadata: null }],
        list_complete: true as boolean,
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
        keys: [{ name: `key:${callCount}`, metadata: null }],
        list_complete: false as boolean,
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

describe('getNextUtcMonthStart', () => {
  it('returns unix timestamp for 1st of next UTC month', () => {
    const date = new Date('2026-04-20T14:30:00Z');
    const expected = Math.floor(Date.UTC(2026, 4, 1, 0, 0, 0) / 1000); // May 1 2026
    expect(getNextUtcMonthStart(date)).toBe(expected);
  });

  it('handles last day of month', () => {
    const date = new Date('2026-04-30T23:59:59Z');
    const expected = Math.floor(Date.UTC(2026, 4, 1, 0, 0, 0) / 1000); // May 1 2026
    expect(getNextUtcMonthStart(date)).toBe(expected);
  });

  it('rolls year boundary on December', () => {
    const date = new Date('2026-12-31T23:59:59Z');
    const expected = Math.floor(Date.UTC(2027, 0, 1, 0, 0, 0) / 1000); // Jan 1 2027
    expect(getNextUtcMonthStart(date)).toBe(expected);
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

describe('buildSessionMetadata', () => {
  it('produces correct metadata for a running session with metrics', () => {
    const session: Session = {
      id: 'abc', name: 'Test', userId: 'user', createdAt: '2026-01-01T00:00:00Z', lastAccessedAt: '2026-01-01T00:00:00Z',
      status: 'running', lastStartedAt: '2026-01-01T01:00:00Z', lastActiveAt: '2026-01-01T02:00:00Z',
      metrics: { cpu: '42%', mem: '512MB', hdd: '2.0GB', syncStatus: 'synced', updatedAt: '2026-01-01T02:00:00Z' },
    };
    const meta = buildSessionMetadata(session);
    expect(meta.s).toBe('r');
    expect(meta.la).toBe('2026-01-01T02:00:00Z');
    expect(meta.sa).toBe('2026-01-01T01:00:00Z');
    expect(meta.m?.c).toBe('42%');
    expect(meta.m?.e).toBe('512MB');
  });

  it('produces correct metadata for a stopped session without metrics', () => {
    const session: Session = {
      id: 'def', name: 'Stopped', userId: 'user', createdAt: '2026-01-01T00:00:00Z', lastAccessedAt: '2026-01-01T00:00:00Z',
    };
    const meta = buildSessionMetadata(session);
    expect(meta.s).toBe('s');
    expect(meta.m).toBeUndefined();
  });

  it('serializes under 1024 bytes for max-size session', () => {
    const session: Session = {
      id: 'a'.repeat(24), name: 'A'.repeat(100), userId: 'user', createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      status: 'running', lastStartedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      metrics: { cpu: '100%', mem: '4096/8192MB', hdd: '50.0/100.0GB', syncStatus: 'syncing', updatedAt: new Date().toISOString() },
    };
    const meta = buildSessionMetadata(session);
    expect(JSON.stringify(meta).length).toBeLessThan(1024);
  });
});

describe('expandSessionMetadata', () => {
  it('expands running metadata correctly', () => {
    const result = expandSessionMetadata({ s: 'r', la: '2026-01-01T00:00:00Z', sa: '2026-01-01T00:00:00Z', m: { c: '5%', e: '128MB' } });
    expect(result.status).toBe('running');
    expect(result.ptyActive).toBe(true);
    expect(result.metrics?.cpu).toBe('5%');
  });

  it('expands stopped metadata without metrics', () => {
    const result = expandSessionMetadata({ s: 's' });
    expect(result.status).toBe('stopped');
    expect(result.ptyActive).toBe(false);
    expect(result.metrics).toBeUndefined();
  });
});

describe('putSessionWithMetadata', () => {
  it('calls kv.put with both value and metadata', async () => {
    const mockKV = { put: vi.fn().mockResolvedValue(undefined) };
    const session: Session = {
      id: 'xyz', name: 'Test', userId: 'user', createdAt: '2026-01-01T00:00:00Z', lastAccessedAt: '2026-01-01T00:00:00Z', status: 'running',
    };
    await putSessionWithMetadata(mockKV as unknown as KVNamespace, 'session:b:xyz', session);
    expect(mockKV.put).toHaveBeenCalledWith(
      'session:b:xyz',
      JSON.stringify(session),
      { metadata: expect.objectContaining({ s: 'r' }) },
    );
  });
});


describe('reconcileStaleStatus', () => {
  const NOW = Date.parse('2026-06-01T12:00:00Z');
  const fresh = new Date(NOW - 10_000).toISOString(); // 10s ago
  const stale = new Date(NOW - (STALE_RUNNING_MS + 60_000)).toISOString(); // >3min ago

  it('downgrades running -> stopped when metrics heartbeat is stale', () => {
    const result = reconcileStaleStatus({ s: 'r', m: { u: stale } }, NOW);
    expect(result.s).toBe('s');
  });

  it('keeps running when metrics heartbeat is fresh', () => {
    const result = reconcileStaleStatus({ s: 'r', m: { u: fresh } }, NOW);
    expect(result.s).toBe('r');
  });

  it('downgrades running -> stopped when no metrics but lastStartedAt is old (startup grace expired)', () => {
    const result = reconcileStaleStatus({ s: 'r', sa: stale }, NOW);
    expect(result.s).toBe('s');
  });

  it('keeps running when no metrics and lastStartedAt is recent (startup grace)', () => {
    const result = reconcileStaleStatus({ s: 'r', sa: fresh }, NOW);
    expect(result.s).toBe('r');
  });

  it('keeps running when no metrics and no lastStartedAt (startup grace)', () => {
    const result = reconcileStaleStatus({ s: 'r' }, NOW);
    expect(result.s).toBe('r');
  });

  it('leaves stopped sessions stopped', () => {
    const result = reconcileStaleStatus({ s: 's', m: { u: stale } }, NOW);
    expect(result.s).toBe('s');
  });

  it('treats an unparseable metrics heartbeat (NaN) as not-stale -> keeps running', () => {
    const result = reconcileStaleStatus({ s: 'r', m: { u: 'not-a-date' } }, NOW);
    expect(result.s).toBe('r');
  });

  it('treats an unparseable lastStartedAt (NaN) as not-stale -> keeps running', () => {
    const result = reconcileStaleStatus({ s: 'r', sa: 'not-a-date' }, NOW);
    expect(result.s).toBe('r');
  });

  it('does not mutate the input metadata (immutable)', () => {
    const input = { s: 'r' as const, m: { u: stale } };
    const result = reconcileStaleStatus(input, NOW);
    expect(input.s).toBe('r');
    expect(result).not.toBe(input);
  });

  it('returns the same reference when unchanged', () => {
    const input = { s: 'r' as const, m: { u: fresh } };
    expect(reconcileStaleStatus(input, NOW)).toBe(input);
  });
});

describe('getBaseUrl', () => {
  it('uses a valid custom domain over the request origin', async () => {
    const kv = createMockKV();
    kv._store.set(SETUP_KEYS.CUSTOM_DOMAIN, 'codeflare.ch');
    const url = await getBaseUrl(kv as unknown as KVNamespace, 'https://worker.example.com/path');
    expect(url).toBe('https://codeflare.ch');
  });

  it('accepts a multi-label subdomain', async () => {
    const kv = createMockKV();
    kv._store.set(SETUP_KEYS.CUSTOM_DOMAIN, 'app.codeflare.ch');
    const url = await getBaseUrl(kv as unknown as KVNamespace, 'https://worker.example.com/');
    expect(url).toBe('https://app.codeflare.ch');
  });

  it('falls back to request origin when no custom domain is set', async () => {
    const kv = createMockKV();
    const url = await getBaseUrl(kv as unknown as KVNamespace, 'https://worker.example.com/path?x=1');
    expect(url).toBe('https://worker.example.com');
  });

  it('falls back to request origin for an invalid custom domain (scheme included)', async () => {
    const kv = createMockKV();
    kv._store.set(SETUP_KEYS.CUSTOM_DOMAIN, 'https://evil.com');
    const url = await getBaseUrl(kv as unknown as KVNamespace, 'https://worker.example.com/x');
    expect(url).toBe('https://worker.example.com');
  });

  it('falls back to request origin for an invalid custom domain (path included)', async () => {
    const kv = createMockKV();
    kv._store.set(SETUP_KEYS.CUSTOM_DOMAIN, 'evil.com/redirect');
    const url = await getBaseUrl(kv as unknown as KVNamespace, 'https://worker.example.com/x');
    expect(url).toBe('https://worker.example.com');
  });

  it('falls back to request origin for a custom domain with consecutive dots', async () => {
    const kv = createMockKV();
    kv._store.set(SETUP_KEYS.CUSTOM_DOMAIN, 'evil..com');
    const url = await getBaseUrl(kv as unknown as KVNamespace, 'https://worker.example.com/x');
    expect(url).toBe('https://worker.example.com');
  });

  it('falls back to request origin for a custom domain with a port', async () => {
    const kv = createMockKV();
    kv._store.set(SETUP_KEYS.CUSTOM_DOMAIN, 'evil.com:8080');
    const url = await getBaseUrl(kv as unknown as KVNamespace, 'https://worker.example.com/x');
    expect(url).toBe('https://worker.example.com');
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
