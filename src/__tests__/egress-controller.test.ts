/**
 * REQ-ENTERPRISE-016: EgressController — the transparent proxy for strict Gateway egress.
 *
 * A WorkerEntrypoint the container DO wires as a catch-all when the strict-egress
 * toggle is ON. Unlike the identity-stamping LLM/GitHub interceptors it adds NO
 * credential and preserves the caller's authorization / cookie / set-cookie; its only
 * job is to force traffic through the mandatory env.EGRESS Workers VPC binding.
 *
 * AC. SSRF target -> 403 EGRESS_TARGET_BLOCKED, before any send (EGRESS.fetch not called).
 * AC. Strict ON but EGRESS unbound -> 503 EGRESS_UNAVAILABLE (no global-fetch fallback).
 * AC. Toggle OFF -> 503 EGRESS_NOT_CONFIGURED (defense-in-depth re-check), not forwarded.
 * AC. No Authorization / cf-aig-* / identity header is ever added (transparent proxy).
 * AC. A caller-supplied authorization + cookie are forwarded verbatim.
 * AC. The forwarded request uses redirect:'manual'.
 * AC. set-cookie survives on the response; hop-by-hop response headers are stripped.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../types';
import { EgressController } from '../egress-controller';

const STRICT_KEY = 'setup:strict_egress';

function makeController(envOverrides: Partial<Env> & { __kv?: Record<string, string> } = {}) {
  const kvStore = envOverrides.__kv ?? { [STRICT_KEY]: 'active' };
  const egressFetch = vi.fn(
    async (_req: Request) =>
      new Response('upstream', {
        status: 200,
        headers: { 'set-cookie': 'sess=abc', connection: 'keep-alive' },
      }),
  );
  const env = {
    ENTERPRISE_MODE: 'active',
    KV: { get: async (k: string) => kvStore[k] ?? null },
    EGRESS: { fetch: egressFetch },
    ...envOverrides,
  } as unknown as Env;
  // The DO instantiates this via ctx.exports.EgressController({ props }); a minimal
  // ctx stub mirrors that shape for the unit test.
  const ctx = {} as unknown as ExecutionContext;
  return { controller: new EgressController(ctx, env), egressFetch };
}

describe('REQ-ENTERPRISE-016: EgressController fail-closed guards', () => {
  it('returns 403 EGRESS_TARGET_BLOCKED for an SSRF target and never forwards', async () => {
    const { controller, egressFetch } = makeController();
    const res = await controller.fetch(new Request('https://169.254.169.254/latest/meta-data'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('EGRESS_TARGET_BLOCKED');
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('returns 503 EGRESS_UNAVAILABLE when strict is ON but EGRESS is unbound', async () => {
    const { controller } = makeController({ EGRESS: undefined } as Partial<Env>);
    const res = await controller.fetch(new Request('https://example.com/'));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('EGRESS_UNAVAILABLE');
  });

  it('returns 503 EGRESS_NOT_CONFIGURED (defense-in-depth) when the toggle is OFF and never forwards', async () => {
    const { controller, egressFetch } = makeController({ __kv: { [STRICT_KEY]: 'inactive' } });
    const res = await controller.fetch(new Request('https://example.com/'));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('EGRESS_NOT_CONFIGURED');
    expect(egressFetch).not.toHaveBeenCalled();
  });
});

describe('REQ-ENTERPRISE-016: EgressController transparent proxy', () => {
  it('never adds an Authorization or identity header', async () => {
    const { controller, egressFetch } = makeController();
    await controller.fetch(new Request('https://example.com/', { method: 'GET' }));
    const fwd = egressFetch.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).toBeNull();
    expect(fwd.headers.get('cf-aig-authorization')).toBeNull();
    expect(fwd.headers.get('cf-aig-metadata')).toBeNull();
    expect(fwd.headers.get('cf-aig-gateway-id')).toBeNull();
    expect(fwd.headers.get('x-access-token')).toBeNull();
  });

  it('forwards a caller-supplied authorization and cookie verbatim', async () => {
    const { controller, egressFetch } = makeController();
    await controller.fetch(
      new Request('https://example.com/', {
        method: 'GET',
        headers: { authorization: 'Bearer caller-token', cookie: 'a=1' },
      }),
    );
    const fwd = egressFetch.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).toBe('Bearer caller-token');
    expect(fwd.headers.get('cookie')).toBe('a=1');
  });

  it('forwards with redirect:manual', async () => {
    const { controller, egressFetch } = makeController();
    await controller.fetch(new Request('https://example.com/'));
    const fwd = egressFetch.mock.calls[0][0] as Request;
    expect(fwd.redirect).toBe('manual');
  });

  it('preserves set-cookie on the response and strips hop-by-hop headers', async () => {
    const { controller } = makeController();
    const res = await controller.fetch(new Request('https://example.com/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBe('sess=abc');
    expect(res.headers.get('connection')).toBeNull();
  });
});
