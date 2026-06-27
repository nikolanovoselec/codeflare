/**
 * REQ-ENTERPRISE-016: strict Gateway egress transport primitives.
 *
 * - hasStrictGatewayEgress: true ONLY when enterprise mode AND the KV toggle is
 *   'active'; default OFF on an absent key or non-enterprise deploy.
 * - controllerFetch: fail-closed — 503 EGRESS_UNAVAILABLE (no global-fetch fallback)
 *   when env.EGRESS is unbound; routes through env.EGRESS.fetch when bound.
 * - isDisallowedEgressHost: SSRF guard — rejects loopback / RFC 1918 / link-local /
 *   metadata / IPv6 literals, allows public hosts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../types';
import { hasStrictGatewayEgress, controllerFetch, isDisallowedEgressHost } from '../../lib/controller-egress';

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
});

describe('REQ-ENTERPRISE-016: controllerFetch fail-closed transport', () => {
  it('returns 503 EGRESS_UNAVAILABLE when env.EGRESS is unbound (no global-fetch fallback)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await controllerFetch(makeEnv({ EGRESS: undefined } as Partial<Env>), new Request('https://example.com/'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_UNAVAILABLE');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('routes the request through env.EGRESS.fetch when bound', async () => {
    const egressFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const env = makeEnv({ EGRESS: { fetch: egressFetch } } as unknown as Partial<Env>);
    const req = new Request('https://example.com/');
    const res = await controllerFetch(env, req);
    expect(res.status).toBe(200);
    expect(egressFetch).toHaveBeenCalledWith(req);
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
