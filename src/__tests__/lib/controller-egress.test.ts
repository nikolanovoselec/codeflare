/**
 * REQ-ENTERPRISE-016: strict Gateway egress transport primitives.
 *
 * - hasStrictGatewayEgress: true ONLY when enterprise mode AND the KV toggle is
 *   'active'; default OFF on an absent key or non-enterprise deploy.
 * - isAccountScopedDestination: true ONLY for THIS deployment's own account — its R2
 *   endpoint (path-style + vhost-bucket) and its account-scoped CF API path. Any other
 *   account's host, and an absent/empty accountId, are NOT exempt (fail-secure).
 * - controllerFetch: account-scoped destinations egress DIRECT (global fetch); every
 *   other host rides env.EGRESS, fail-closed with 503 EGRESS_UNAVAILABLE (no global-fetch
 *   fallback) when the binding is unbound.
 * - isDisallowedEgressHost: SSRF guard — rejects loopback / RFC 1918 / link-local /
 *   metadata / IPv6 literals, allows public hosts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../types';
import {
  hasStrictGatewayEgress,
  controllerFetch,
  isDisallowedEgressHost,
  isAccountScopedDestination,
} from '../../lib/controller-egress';

// The literal KV key is the persisted contract (SETUP_KEYS.STRICT_EGRESS); keying the
// stub store with it locks the read path to the real key, not a renamed constant.
const STRICT_KEY = 'setup:strict_egress';

function makeEnv(overrides: Partial<Env> & { __kv?: Record<string, string> } = {}): Env {
  const kvStore = overrides.__kv ?? {};
  return {
    ENTERPRISE_MODE: 'active',
    KV: { get: async (k: string) => kvStore[k] ?? null },
    ...overrides,
  } as unknown as Env;
}

describe('REQ-ENTERPRISE-016: hasStrictGatewayEgress', () => {
  it('is true only when enterprise mode AND the KV toggle is active', async () => {
    expect(await hasStrictGatewayEgress(makeEnv({ __kv: { [STRICT_KEY]: 'active' } }))).toBe(true);
  });

  it('is false when the KV toggle is inactive', async () => {
    expect(await hasStrictGatewayEgress(makeEnv({ __kv: { [STRICT_KEY]: 'inactive' } }))).toBe(false);
  });

  it('defaults OFF when the KV key is absent', async () => {
    expect(await hasStrictGatewayEgress(makeEnv({ __kv: {} }))).toBe(false);
  });

  it('is false in non-enterprise mode even when the toggle is active', async () => {
    const env = makeEnv({ ENTERPRISE_MODE: 'inactive', __kv: { [STRICT_KEY]: 'active' } } as Partial<Env>);
    expect(await hasStrictGatewayEgress(env)).toBe(false);
  });

  it('defaults OFF (resolves false, never throws) when the KV read rejects at the start seam', async () => {
    // A transient KV error at the container-start seam must degrade to OFF, not fault
    // setupEnterpriseInterception -> startAndWaitForPorts. Removing the try/catch makes this throw.
    const env = { ENTERPRISE_MODE: 'active', KV: { get: async () => { throw new Error('kv unavailable'); } } } as unknown as Env;
    await expect(hasStrictGatewayEgress(env)).resolves.toBe(false);
  });
});

describe('REQ-ENTERPRISE-016 / AD86: isAccountScopedDestination (own account only)', () => {
  const ACCT = 'acc123';
  it.each([
    'https://acc123.r2.cloudflarestorage.com/bucket/key', // own R2 S3 endpoint (rclone, path-style)
    'https://mybucket.acc123.r2.cloudflarestorage.com/key', // own R2 virtual-hosted bucket form
    'https://acc123.r2.cloudflarestorage.com./b/k', // trailing-dot FQDN form normalizes
    'https://ACC123.R2.CLOUDFLARESTORAGE.COM/b/k', // case-insensitive host
    'https://api.cloudflare.com/client/v4/accounts/acc123/browser-rendering/snapshot', // own CF API path
    'https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1/chat/completions', // own CF API path
  ])('exempts THIS account destination %s', (url) => {
    expect(isAccountScopedDestination(new URL(url), ACCT)).toBe(true);
  });

  it.each([
    'https://other.r2.cloudflarestorage.com/bucket/key', // ANOTHER account R2 -> Gateway
    'https://b.other.r2.cloudflarestorage.com/key', // another account vhost -> Gateway
    'https://api.cloudflare.com/client/v4/accounts/other/browser-rendering/snapshot', // another account CF path
    'https://api.cloudflare.com/client/v4/zones', // CF API but not the account path
    'https://gateway.ai.cloudflare.com/v1/acc123/gw/compat/chat/completions', // AIG compat is NOT container-direct
    'https://evilacc123.r2.cloudflarestorage.com/k', // suffix without the dot boundary
    'https://acc123.r2.cloudflarestorage.com.attacker.example/k', // suffix-spoof
    'https://api.openai.com/v1/chat/completions',
    'https://example.com/',
  ])('does NOT exempt %s (rides the Gateway)', (url) => {
    expect(isAccountScopedDestination(new URL(url), ACCT)).toBe(false);
  });

  it('fail-secure: an absent/empty accountId exempts nothing, even an own-looking host', () => {
    const own = new URL('https://acc123.r2.cloudflarestorage.com/b/k');
    expect(isAccountScopedDestination(own, undefined)).toBe(false);
    expect(isAccountScopedDestination(own, '')).toBe(false);
    expect(isAccountScopedDestination(own, '   ')).toBe(false);
  });
});

describe('REQ-ENTERPRISE-016: controllerFetch transport selection', () => {
  it('returns 503 EGRESS_UNAVAILABLE when env.EGRESS is unbound for a non-scoped host (no global-fetch fallback)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await controllerFetch(makeEnv({ EGRESS: undefined } as Partial<Env>), new Request('https://example.com/'), 'acc');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_UNAVAILABLE');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('routes a direct-internet (non-scoped) request through env.EGRESS.fetch when bound', async () => {
    const egressFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const env = makeEnv({ EGRESS: { fetch: egressFetch } } as unknown as Partial<Env>);
    const req = new Request('https://example.com/');
    const res = await controllerFetch(env, req, 'acc');
    expect(res.status).toBe(200);
    expect(egressFetch).toHaveBeenCalledWith(req);
  });

  it('egresses THIS account R2 DIRECT via global fetch — never env.EGRESS — even when the binding is bound', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const egressFetch = vi.fn(async () => new Response('should-not-be-reached', { status: 500 }));
    const env = makeEnv({ EGRESS: { fetch: egressFetch } } as unknown as Partial<Env>);
    const req = new Request('https://acc123.r2.cloudflarestorage.com/bucket/key');
    const res = await controllerFetch(env, req, 'acc123');
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(req);
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('egresses THIS account destinations DIRECT even when env.EGRESS is unbound — no 503', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    for (const url of [
      'https://acc123.r2.cloudflarestorage.com/b/k',
      'https://api.cloudflare.com/client/v4/accounts/acc123/browser-rendering/devtools',
    ]) {
      const res = await controllerFetch(makeEnv({ EGRESS: undefined } as Partial<Env>), new Request(url), 'acc123');
      expect(res.status).toBe(200);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it('routes ANOTHER account R2 through env.EGRESS (Gateway), NOT direct — closes cross-account exfil', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const egressFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const env = makeEnv({ EGRESS: { fetch: egressFetch } } as unknown as Partial<Env>);
    const req = new Request('https://other.r2.cloudflarestorage.com/bucket/key');
    await controllerFetch(env, req, 'acc123');
    expect(egressFetch).toHaveBeenCalledWith(req);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('fail-secure: with no accountId, an own-looking R2 host rides env.EGRESS (nothing exempt)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const egressFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const env = makeEnv({ EGRESS: { fetch: egressFetch } } as unknown as Partial<Env>);
    const req = new Request('https://acc123.r2.cloudflarestorage.com/b/k');
    await controllerFetch(env, req, undefined);
    expect(egressFetch).toHaveBeenCalledWith(req);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('REQ-ENTERPRISE-016: isDisallowedEgressHost SSRF guard', () => {
  it.each([
    'localhost',
    'foo.localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '[::1]',
    '100.64.0.1', // CGNAT (RFC 6598) lower bound
    '100.127.255.255', // CGNAT upper bound
    '::ffff:127.0.0.1', // IPv4-mapped IPv6 loopback (dotted)
    '::ffff:169.254.169.254', // IPv4-mapped IPv6 cloud metadata
    '::ffff:10.0.0.1', // IPv4-mapped IPv6 RFC1918
    '::ffff:7f00:1', // IPv4-mapped IPv6 loopback (WHATWG hex form)
    '[::ffff:7f00:1]', // bracketed mapped loopback
  ])('rejects internal/metadata host %s', (host) => {
    expect(isDisallowedEgressHost(host)).toBe(true);
  });

  it.each([
    'api.openai.com',
    'github.com',
    'api.github.com',
    '8.8.8.8',
    '172.32.0.1',
    '100.63.255.255', // just below CGNAT -> public
    '100.128.0.1', // just above CGNAT -> public
    '93.184.216.34',
    '2606:2800::1',
  ])(
    'allows public host %s',
    (host) => {
      expect(isDisallowedEgressHost(host)).toBe(false);
    },
  );
});
