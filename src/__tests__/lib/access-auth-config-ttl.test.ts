import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * CF-149: split TTL for the module-level auth-config cache.
 *
 *   - Negative / null (pre-setup) config expires after AUTH_CONFIG_NULL_TTL_MS
 *     (30s) so the spoofable cf-access-authenticated-user-email trust window
 *     shrinks from 5min to 30s after the instance is configured.
 *   - Populated config keeps the 5min AUTH_CONFIG_CACHE_TTL_MS.
 *
 * The TTLs are module-internal (no exported control), so we drive them through
 * getUserFromRequest with fake timers and count KV config-key reads across the
 * relevant time boundaries. vi.resetModules() gives each test a fresh,
 * empty-cache module instance (mirrors auth-config-fetch-dedup.test.ts).
 */

const NULL_TTL_MS = 30 * 1000;
const FULL_TTL_MS = 5 * 60 * 1000;

describe('auth-config cache TTL split / CF-149 (null config 30s TTL, populated config 5min TTL)', () => {
  let getUserFromRequest: typeof import('../../lib/access').getUserFromRequest;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const mod = await import('../../lib/access');
    getUserFromRequest = mod.getUserFromRequest;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeKv(values: Record<string, string | null>) {
    const calls: string[] = [];
    const kv = {
      get: vi.fn(async (key: string) => {
        calls.push(key);
        return values[key] ?? null;
      }),
    };
    return { kv, calls };
  }

  function configReads(calls: string[]): number {
    return calls.filter((k) => k === 'setup:auth_domain').length;
  }

  it('null config: re-reads KV after the 30s NULL TTL elapses', async () => {
    // No auth_domain in KV -> negative/null cache state.
    const { kv, calls } = makeKv({
      'setup:auth_domain': null,
      'setup:access_aud': null,
      'setup:access_aud_list': null,
    });
    const env = { KV: kv } as any;
    const req = () => new Request('http://localhost/x');

    await getUserFromRequest(req(), env);
    expect(configReads(calls)).toBe(1);

    // Just before the NULL TTL: still cached, no re-read.
    vi.advanceTimersByTime(NULL_TTL_MS - 100);
    await getUserFromRequest(req(), env);
    expect(configReads(calls)).toBe(1);

    // Past the NULL TTL: cache invalidated -> re-read.
    vi.advanceTimersByTime(200);
    await getUserFromRequest(req(), env);
    expect(configReads(calls)).toBe(2);
  });

  it('populated config: does NOT re-read at 30s, keeps the 5min TTL', async () => {
    const { kv, calls } = makeKv({
      'setup:auth_domain': 'team.cloudflareaccess.com',
      'setup:access_aud': 'aud-123',
      'setup:access_aud_list': null,
    });
    const env = { KV: kv } as any;
    const req = () => new Request('http://localhost/x');

    await getUserFromRequest(req(), env);
    expect(configReads(calls)).toBe(1);

    // At 30s + a bit: populated config is still well within the 5min TTL.
    vi.advanceTimersByTime(NULL_TTL_MS + 1000);
    await getUserFromRequest(req(), env);
    expect(configReads(calls)).toBe(1);

    // Just before the full TTL: still cached.
    vi.advanceTimersByTime(FULL_TTL_MS - NULL_TTL_MS - 2000);
    await getUserFromRequest(req(), env);
    expect(configReads(calls)).toBe(1);

    // Past the full 5min TTL: re-read.
    vi.advanceTimersByTime(3000);
    await getUserFromRequest(req(), env);
    expect(configReads(calls)).toBe(2);
  });
});
