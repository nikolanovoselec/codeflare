/**
 * REQ-ENTERPRISE-016: EgressController — strict Gateway egress proxy.
 *
 * A WorkerEntrypoint the container DO wires as a catch-all when the strict-egress toggle is
 * ON (the DO passes `{ accountId, strict }` via ctx.props, resolved once at wiring). For most
 * hosts it is a transparent proxy (no credential added, caller authorization/cookie/set-cookie
 * preserved) forcing traffic through env.EGRESS. This account's own R2 is the exception: its
 * placeholder Authorization is stripped and the request is RE-SIGNED with the worker-held key.
 * WebSocket upgrades are BRIDGED (a fresh WebSocketPair accepted on both ends), not returned
 * as-is. `strict` comes from props (no per-request KV read).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../types';
import { EgressController } from '../egress-controller';

const STRICT_KEY = 'setup:strict_egress';

function makeController(
  envOverrides: Partial<Env> & { __kv?: Record<string, string> } = {},
  props: { accountId?: string; strict?: boolean } = { accountId: 'acc' },
) {
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
    // Worker-held R2 key the EgressController re-signs own-account R2 with (REQ-ENTERPRISE-016).
    R2_ACCESS_KEY_ID: 'test-r2-key',
    R2_SECRET_ACCESS_KEY: 'test-r2-secret',
    KV: { get: async (k: string) => kvStore[k] ?? null },
    EGRESS: { fetch: egressFetch },
    ...envOverrides,
  } as unknown as Env;
  // The DO instantiates this via ctx.exports.EgressController({ props: { accountId, strict } }).
  // strict defaults ON here (the catch-all is only wired when strict) unless a test overrides it.
  const ctx = { props: { strict: true, ...props } } as unknown as ExecutionContext;
  return { controller: new EgressController(ctx, env), egressFetch };
}

describe('REQ-ENTERPRISE-016: EgressController fail-closed guards', () => {
  it('returns 403 EGRESS_TARGET_BLOCKED for an SSRF target and never forwards', async () => {
    const { controller, egressFetch } = makeController();
    const res = await controller.fetch(new Request('https://169.254.169.254/latest/meta-data'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_TARGET_BLOCKED');
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('returns 503 EGRESS_UNAVAILABLE when strict is ON but EGRESS is unbound', async () => {
    const { controller } = makeController({ EGRESS: undefined } as Partial<Env>);
    const res = await controller.fetch(new Request('https://example.com/'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_UNAVAILABLE');
  });

  it('reads strict from props (not KV): 503 EGRESS_NOT_CONFIGURED when props.strict is false, and never reads KV', async () => {
    const kvGet = vi.fn(async () => 'active'); // KV would say active — the controller must ignore it
    const env = { ENTERPRISE_MODE: 'active', KV: { get: kvGet }, EGRESS: { fetch: vi.fn() } } as unknown as Env;
    const controller = new EgressController(
      { props: { accountId: 'acc', strict: false } } as unknown as ExecutionContext,
      env,
    );
    const res = await controller.fetch(new Request('https://example.com/'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_NOT_CONFIGURED');
    expect(kvGet).not.toHaveBeenCalled();
  });
});

describe('REQ-ENTERPRISE-016 / AD86: EgressController account-scoped exemption (own account direct, all else Gateway)', () => {
  it('forwards THIS account R2 DIRECT via global fetch — never env.EGRESS', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('r2', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    const res = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/key'));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('re-signs own-account R2 with the worker key: strips the placeholder Authorization, preserves x-amz-content-sha256 + SSE-C, never env.EGRESS', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('r2', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    await controller.fetch(
      new Request('https://acc.r2.cloudflarestorage.com/bucket/key', {
        method: 'PUT',
        headers: {
          authorization: 'AWS4-HMAC-SHA256 Credential=PLACEHOLDER-KEY/20260101/auto/s3/aws4_request, Signature=deadbeef',
          'x-amz-content-sha256': 'fixedhash123',
          'x-amz-server-side-encryption-customer-algorithm': 'AES256',
          'content-type': 'application/octet-stream',
        },
        body: 'payload-bytes',
      }),
    );
    expect(fetchSpy).toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    const signed = fetchSpy.mock.calls[0][0] as Request;
    const auth = signed.headers.get('authorization') ?? '';
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(auth).not.toContain('PLACEHOLDER-KEY'); // container placeholder stripped
    expect(auth).toContain('Credential=test-r2-key/'); // re-signed with the worker-held key
    // rclone's precomputed payload hash is REUSED (not recomputed / UNSIGNED) — body streams unbuffered.
    expect(signed.headers.get('x-amz-content-sha256')).toBe('fixedhash123');
    // SSE-C header preserved AND covered by the new signature (present in SignedHeaders).
    expect(signed.headers.get('x-amz-server-side-encryption-customer-algorithm')).toBe('AES256');
    expect(auth).toContain('x-amz-server-side-encryption-customer-algorithm');
    fetchSpy.mockRestore();
  });

  it('forwards THIS account CF API (browser-rendering path) DIRECT and transparent — never env.EGRESS, no re-sign', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('cf', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    await controller.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/snapshot', {
        headers: { authorization: 'Bearer caller-cf-token' },
      }),
    );
    expect(fetchSpy).toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    // CF API is a transparent passthrough (REQ-BROWSER-007): caller token preserved, not re-signed.
    const fwd = fetchSpy.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).toBe('Bearer caller-cf-token');
    fetchSpy.mockRestore();
  });

  it('routes ANOTHER account R2 through env.EGRESS (Gateway) — NOT direct (closes cross-account exfil)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    await controller.fetch(new Request('https://other.r2.cloudflarestorage.com/bucket/key'));
    expect(egressFetch).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('routes ANOTHER account CF API path through env.EGRESS — NOT direct', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    await controller.fetch(new Request('https://api.cloudflare.com/client/v4/accounts/other/browser-rendering/snapshot'));
    expect(egressFetch).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('fail-secure: with NO accountId prop, even an own-looking R2 host rides env.EGRESS (nothing exempt, not re-signed)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { strict: true });
    await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/key'));
    expect(egressFetch).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('REQ-ENTERPRISE-016: EgressController bridges WebSocket upgrades (browser-run CDP)', () => {
  // The upstream socket is mocked (accept/addEventListener) so the bridge can accept it and
  // wire forwarding; the controller returns a FRESH WebSocketPair client end (not the upstream
  // as-is). Returning the upstream as-is would fail these assertions.
  const makeUpstreamWs = () => ({
    accept: vi.fn(),
    addEventListener: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  });

  // The controller bridges by creating a REAL WebSocketPair and accept()ing its server end.
  // Capture every pair it creates and close both ends after each test so the
  // vitest-pool-workers isolate tears down cleanly — a live accepted WebSocket otherwise
  // crashes the pool worker ("Worker exited unexpectedly").
  const createdPairs: Array<Record<string, WebSocket>> = [];
  const RealWebSocketPair = globalThis.WebSocketPair;
  beforeEach(() => {
    createdPairs.length = 0;
    vi.stubGlobal('WebSocketPair', function WebSocketPairCapture() {
      const pair = new RealWebSocketPair();
      createdPairs.push(pair as unknown as Record<string, WebSocket>);
      return pair;
    });
  });
  afterEach(() => {
    for (const pair of createdPairs) {
      for (const end of Object.values(pair)) {
        try { end.close(); } catch { /* already closed / handed to the Response */ }
      }
    }
    vi.unstubAllGlobals();
  });

  it('bridges a THIS-account CDP upgrade: accepts the upstream, returns a 101 with a FRESH client webSocket (not as-is), direct not env.EGRESS', async () => {
    const upstreamWs = makeUpstreamWs();
    const ws101 = { status: 101, webSocket: upstreamWs, headers: new Headers() } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ws101);
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    const res = await controller.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/devtools/browser', {
        headers: { Upgrade: 'websocket' },
      }),
    );
    expect(res.status).toBe(101);
    const clientWs = (res as unknown as { webSocket?: unknown }).webSocket;
    expect(clientWs).toBeTruthy();
    expect(clientWs).not.toBe(upstreamWs); // bridged, NOT returned as-is
    expect(upstreamWs.accept).toHaveBeenCalled(); // upstream socket taken up
    // upstream→client frame + close forwarding is wired (fails if the bridge reverts to return-as-is)
    expect(upstreamWs.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(upstreamWs.addEventListener).toHaveBeenCalledWith('close', expect.any(Function));
    expect(fetchSpy).toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('surfaces a non-101 upstream (e.g. an error response) unchanged', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status: 403 }));
    const { controller } = makeController({}, { accountId: 'acc' });
    const res = await controller.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/devtools/browser', {
        headers: { Upgrade: 'websocket' },
      }),
    );
    expect(res.status).toBe(403);
    fetchSpy.mockRestore();
  });

  it('bridges a non-account-scoped WS upgrade through env.EGRESS with the Upgrade header preserved (not stripped)', async () => {
    const upstreamWs = makeUpstreamWs();
    const ws101 = { status: 101, webSocket: upstreamWs, headers: new Headers() } as unknown as Response;
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    egressFetch.mockResolvedValueOnce(ws101);
    const res = await controller.fetch(
      new Request('https://example.com/socket', { headers: { Upgrade: 'websocket' } }),
    );
    expect(res.status).toBe(101);
    expect(egressFetch).toHaveBeenCalled();
    const fwd = egressFetch.mock.calls[0][0] as Request;
    expect(fwd.headers.get('upgrade')?.toLowerCase()).toBe('websocket');
    expect(upstreamWs.accept).toHaveBeenCalled();
  });
});

describe('REQ-ENTERPRISE-016: EgressController transparent proxy', () => {
  it('never adds an Authorization or identity header (non-R2 host)', async () => {
    const { controller, egressFetch } = makeController();
    await controller.fetch(new Request('https://example.com/', { method: 'GET' }));
    const fwd = egressFetch.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).toBeNull();
    expect(fwd.headers.get('cf-aig-authorization')).toBeNull();
    expect(fwd.headers.get('cf-aig-metadata')).toBeNull();
    expect(fwd.headers.get('cf-aig-gateway-id')).toBeNull();
    expect(fwd.headers.get('x-access-token')).toBeNull();
  });

  it('forwards a caller-supplied authorization and cookie verbatim (non-R2 host)', async () => {
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
