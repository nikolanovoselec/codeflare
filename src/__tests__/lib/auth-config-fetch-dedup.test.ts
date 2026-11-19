import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function independently<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Independent request stalled behind held I/O')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

const configured = {
  'setup:auth_domain': 'team.cloudflareaccess.com',
  'setup:access_aud_list': null,
  'setup:access_aud': 'aud-123',
};

function environment(values: Record<string, string | null>): Env {
  return { KV: { get: async (key: string) => values[key] ?? null } } as unknown as Env;
}

function unsignedRequest() {
  return new Request('https://example.test/protected', {
    headers: { 'cf-access-authenticated-user-email': 'setup@example.test' },
  });
}

// These public-API races model independent request-owned storage reads. They do
// not emulate workerd's request-lifetime enforcement; that needs deployed evidence.
describe('REQ-SEC-016: request-owned auth config reads and completed snapshots', () => {
  let getUserFromRequest: typeof import('../../lib/access').getUserFromRequest;
  let resetAuthConfigCache: typeof import('../../lib/access').resetAuthConfigCache;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../lib/access');
    getUserFromRequest = mod.getUserFromRequest;
    resetAuthConfigCache = mod.resetAuthConfigCache;
    resetAuthConfigCache();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['setup:auth_domain', 'setup:access_aud_list', 'setup:access_aud'])(
    'REQ-SEC-016 AC1/AC2: a held first request at %s does not stall independent authentication', async heldKey => {
      const started = deferred<void>();
      const held = deferred<string | null>();
      let hold = true;
      const env = { KV: { get: async (key: string) => {
        if (key === heldKey && hold) { hold = false; started.resolve(); return held.promise; }
        return configured[key as keyof typeof configured] ?? null;
      } } } as unknown as Env;
      const first = getUserFromRequest(unsignedRequest(), env);
      await started.promise;
      try {
        // Deliberately leave the first read unresolved until the second request
        // has returned. Awaiting shared request-owned I/O would time out here.
        expect(await independently(getUserFromRequest(unsignedRequest(), env))).toMatchObject({ authenticated: false, email: '' });
      } finally {
        held.resolve(configured[heldKey as keyof typeof configured]);
        expect(await first).toMatchObject({ authenticated: false, email: '' });
      }
    },
  );

  it('REQ-SEC-001 AC4: a request arriving between domain and audience reads cannot trust an unsigned header', async () => {
    const started = deferred<void>();
    const audience = deferred<string | null>();
    let hold = true;
    const env = { KV: { get: async (key: string) => {
      if (key === 'setup:access_aud_list' && hold) { hold = false; started.resolve(); return audience.promise; }
      return configured[key as keyof typeof configured] ?? null;
    } } } as unknown as Env;
    const first = getUserFromRequest(unsignedRequest(), env);
    await started.promise;
    try {
      expect(await independently(getUserFromRequest(unsignedRequest(), env))).toMatchObject({ authenticated: false, email: '' });
    } finally {
      audience.resolve(null);
      expect(await first).toMatchObject({ authenticated: false, email: '' });
    }
  });

  it.each(['setup:auth_domain', 'setup:access_aud_list', 'setup:access_aud'])(
    'REQ-SEC-001 AC5: failure reading %s cannot publish partial auth config for a repeated request', async failedKey => {
      let fail = true;
      const env = { KV: { get: async (key: string) => {
        if (key === failedKey && fail) throw new Error('Synthetic KV outage');
        return configured[key as keyof typeof configured] ?? null;
      } } } as unknown as Env;
      await expect(getUserFromRequest(unsignedRequest(), env)).rejects.toThrow('Synthetic KV outage');
      await expect(getUserFromRequest(unsignedRequest(), env)).rejects.toThrow('Synthetic KV outage');
      fail = false;
      expect(await getUserFromRequest(unsignedRequest(), env)).toMatchObject({ authenticated: false, email: '' });
    },
  );

  it('REQ-SEC-016 AC2: a rejected first request does not poison another request or the completed cache', async () => {
    const started = deferred<void>();
    const held = deferred<string | null>();
    let hold = true;
    const env = { KV: { get: async (key: string) => {
      if (hold) { hold = false; started.resolve(); return held.promise; }
      return configured[key as keyof typeof configured] ?? null;
    } } } as unknown as Env;
    const first = getUserFromRequest(unsignedRequest(), env);
    const failure = expect(first).rejects.toThrow('Request ended');
    await started.promise;
    try {
      expect(await independently(getUserFromRequest(unsignedRequest(), env))).toMatchObject({ authenticated: false, email: '' });
    } finally { held.reject(new Error('Request ended')); await failure; }
    expect(await getUserFromRequest(unsignedRequest(), env)).toMatchObject({ authenticated: false, email: '' });
  });

  it('REQ-SEC-016 AC3: reset fences a held old configuration from repopulating the cache or configured latch', async () => {
    const started = deferred<void>();
    const held = deferred<string | null>();
    const oldEnv = { KV: { get: async (key: string) => {
      if (key === 'setup:auth_domain') { started.resolve(); return held.promise; }
      return configured[key as keyof typeof configured] ?? null;
    } } } as unknown as Env;
    const first = getUserFromRequest(unsignedRequest(), oldEnv);
    await started.promise;
    resetAuthConfigCache();
    const currentEnv = environment({});
    try {
      expect(await getUserFromRequest(unsignedRequest(), currentEnv)).toMatchObject({ authenticated: true, email: 'setup@example.test' });
    } finally {
      held.resolve(configured['setup:auth_domain']);
      expect(await first).toMatchObject({ authenticated: false, email: '' });
    }
    expect(await getUserFromRequest(unsignedRequest(), currentEnv)).toMatchObject({ authenticated: true, email: 'setup@example.test' });
  });

  it('REQ-SEC-016 AC3: reset after a completed snapshot makes the saved configuration visible', async () => {
    const values: Record<string, string | null> = {};
    const env = environment(values);
    expect((await getUserFromRequest(unsignedRequest(), env)).authenticated).toBe(true);
    Object.assign(values, configured);
    resetAuthConfigCache();
    expect(await getUserFromRequest(unsignedRequest(), env)).toMatchObject({ authenticated: false, email: '' });
  });

  it.each([
    { domain: null, ttl: 30_000, state: 'negative' },
    { domain: 'team.cloudflareaccess.com', ttl: 300_000, state: 'domain-populated, audience not yet saved' },
  ])('REQ-SEC-016 AC3: $state cache expires and freshly saved configuration rejects header trust', async ({ domain, ttl }) => {
    const values: Record<string, string | null> = { 'setup:auth_domain': domain };
    const env = environment(values);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect((await getUserFromRequest(unsignedRequest(), env)).authenticated).toBe(true);
    Object.assign(values, configured);
    clock.mockReturnValue(1_000_000 + ttl - 1);
    expect((await getUserFromRequest(unsignedRequest(), env)).authenticated).toBe(true);
    clock.mockReturnValue(1_000_000 + ttl + 1);
    expect(await getUserFromRequest(unsignedRequest(), env)).toMatchObject({ authenticated: false, email: '' });
  });

  it('REQ-AUTH-010: a configured snapshot still disables header trust after TTL and empty storage', async () => {
    const values: Record<string, string | null> = { ...configured };
    const env = environment(values);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect((await getUserFromRequest(unsignedRequest(), env)).authenticated).toBe(false);
    for (const key of Object.keys(values)) values[key] = null;
    clock.mockReturnValue(1_300_001);
    expect(await getUserFromRequest(unsignedRequest(), env)).toMatchObject({ authenticated: false, email: '' });
  });
});
