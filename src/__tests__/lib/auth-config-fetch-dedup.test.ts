import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * REQ-SEC-016: Concurrent cache deduplication for auth config.
 *
 * AC1: auth-config fetch wrapped in `pendingAuthConfigFetch` Promise sentinel.
 * AC2: Two concurrent cold-start requests reuse the in-flight fetch instead
 *      of issuing redundant KV reads.
 * AC3: The sentinel is cleared on TTL expiry and `resetAuthConfigCache()`.
 * AC4: Pattern mirrors `pendingJWKSFetch` in jwt.ts.
 *
 * We exercise AC1+AC2+AC3 here. We construct a slow KV mock that resolves
 * after a tick, fire N concurrent getUserFromRequest calls, and assert
 * `kv.get` was called exactly the per-config-key count (3 keys: AUTH_DOMAIN,
 * ACCESS_AUD_LIST, ACCESS_AUD) plus the per-request user-lookup reads — NOT
 * N times the config-key count.
 */
describe('Concurrent auth-config fetch deduplication / REQ-SEC-016 AC1/AC2/AC3 (pendingAuthConfigFetch sentinel coalesces concurrent cold-start KV reads; cleared on cache reset)', () => {
  let getUserFromRequest: typeof import('../../lib/access').getUserFromRequest;
  let resetAuthConfigCache: typeof import('../../lib/access').resetAuthConfigCache;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../lib/access');
    getUserFromRequest = mod.getUserFromRequest;
    resetAuthConfigCache = mod.resetAuthConfigCache;
    resetAuthConfigCache();
  });

  function makeSlowKv(values: Record<string, string | null>) {
    const calls: string[] = [];
    const kv = {
      get: vi.fn(async (key: string) => {
        calls.push(key);
        // simulate ~1 macrotask of KV latency so concurrent requests pile up
        await new Promise((r) => setTimeout(r, 5));
        return values[key] ?? null;
      }),
    };
    return { kv, calls };
  }

  it('AC2: ten concurrent cold-start requests issue exactly one round of config-key reads', async () => {
    const { kv, calls } = makeSlowKv({
      'setup:auth_domain': 'team.cloudflareaccess.com',
      'setup:access_aud': 'aud-123',
      'setup:access_aud_list': null,
    });
    const env = { KV: kv } as any;

    const requests = Array.from({ length: 10 }, () =>
      getUserFromRequest(new Request('http://localhost/x'), env)
    );
    await Promise.all(requests);

    // Each of the three setup:* config keys must be read exactly once
    // across all 10 concurrent calls.
    const configReads = calls.filter((k) => k.startsWith('setup:'));
    const authDomainReads = configReads.filter((k) => k === 'setup:auth_domain').length;
    const audReads = configReads.filter((k) => k === 'setup:access_aud').length;
    const audListReads = configReads.filter((k) => k === 'setup:access_aud_list').length;

    expect(authDomainReads).toBe(1);
    expect(audReads).toBe(1);
    expect(audListReads).toBe(1);
  });

  it('AC3: after resetAuthConfigCache(), the next concurrent batch re-issues a single round of config reads', async () => {
    const { kv, calls } = makeSlowKv({
      'setup:auth_domain': 'team.cloudflareaccess.com',
      'setup:access_aud': 'aud-123',
      'setup:access_aud_list': null,
    });
    const env = { KV: kv } as any;

    await Promise.all(
      Array.from({ length: 5 }, () => getUserFromRequest(new Request('http://localhost/x'), env))
    );
    // First batch: 1 read per config key
    expect(calls.filter((k) => k === 'setup:auth_domain').length).toBe(1);

    resetAuthConfigCache();

    await Promise.all(
      Array.from({ length: 5 }, () => getUserFromRequest(new Request('http://localhost/x'), env))
    );
    // Cache reset forces re-fetch: total reads = 2 per config key, not 10.
    expect(calls.filter((k) => k === 'setup:auth_domain').length).toBe(2);
    expect(calls.filter((k) => k === 'setup:access_aud').length).toBe(2);
    expect(calls.filter((k) => k === 'setup:access_aud_list').length).toBe(2);
  });

  it('AC1: the sentinel is a Promise that is awaited (concurrent callers see consistent post-fetch state)', async () => {
    const { kv } = makeSlowKv({
      'setup:auth_domain': 'team.cloudflareaccess.com',
      'setup:access_aud': 'aud-123',
      'setup:access_aud_list': null,
    });
    const env = { KV: kv } as any;

    // All four callers must observe the configured-auth state (header
    // trust must be rejected since auth_domain + aud are set).
    const results = await Promise.all([
      getUserFromRequest(
        new Request('http://localhost/x', { headers: { 'cf-access-authenticated-user-email': 'attacker@x.com' } }),
        env
      ),
      getUserFromRequest(
        new Request('http://localhost/x', { headers: { 'cf-access-authenticated-user-email': 'attacker@x.com' } }),
        env
      ),
      getUserFromRequest(
        new Request('http://localhost/x', { headers: { 'cf-access-authenticated-user-email': 'attacker@x.com' } }),
        env
      ),
      getUserFromRequest(
        new Request('http://localhost/x', { headers: { 'cf-access-authenticated-user-email': 'attacker@x.com' } }),
        env
      ),
    ]);
    for (const r of results) {
      // FIX-1: with auth configured, header trust is rejected (no JWT).
      expect(r.authenticated).toBe(false);
    }
  });
});
