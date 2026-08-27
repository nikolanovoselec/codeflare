/**
 * REQ-ENTERPRISE-016 / REQ-ENTERPRISE-023 / REQ-ENTERPRISE-026: EgressController — strict Gateway egress proxy.
 *
 * A WorkerEntrypoint the container DO wires as a catch-all when the strict-egress toggle is
 * ON (the DO passes account, bucket, scoped R2 credentials, and strict state via ctx.props,
 * resolved once at wiring). For most hosts it is a transparent proxy (no credential added,
 * caller authorization/cookie/set-cookie preserved) forcing traffic through env.EGRESS. This
 * user's own R2 bucket is the exception: its placeholder Authorization is stripped and the
 * request is RE-SIGNED with that user's bucket-scoped key.
 * WebSocket upgrades are BRIDGED (a fresh WebSocketPair accepted on both ends), not returned
 * as-is. `strict` comes from props (no per-request KV read).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../types';
import { EgressController } from '../egress-controller';

const STRICT_KEY = 'setup:strict_egress';

function makeController(
  envOverrides: Partial<Env> & { __kv?: Record<string, string> } = {},
  props: {
    accountId?: string;
    bucket?: string;
    r2AccessKeyId?: string;
    r2SecretAccessKey?: string;
    resourcePolicy?: 'mutable' | 'immutable' | 'exclusive';
    releaseDigest?: string;
    pathsDigest?: string;
    r2SseDisabled?: boolean;
    strict?: boolean;
  } = { accountId: 'acc' },
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
    // Deployment-wide credentials must never sign intercepted per-user R2 traffic.
    R2_ACCESS_KEY_ID: 'admin-r2-key',
    R2_SECRET_ACCESS_KEY: 'admin-r2-secret',
    KV: { get: async (k: string) => kvStore[k] ?? null },
    EGRESS: { fetch: egressFetch },
    ...envOverrides,
  } as unknown as Env;
  // Strict and scoped user-bucket values default here unless a test overrides them.
  const ctx = {
    props: {
      strict: true,
      bucket: 'bucket',
      r2AccessKeyId: 'user-r2-key',
      r2SecretAccessKey: 'user-r2-secret',
      ...props,
    },
  } as unknown as ExecutionContext;
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

describe('REQ-ENTERPRISE-029: protected own-R2 enforcement', () => {
  async function protectedFixture(digestCharacter = 'd') {
    const releaseDigest = digestCharacter.repeat(64);
    const value = {
      schemaVersion: 1,
      releaseDigest,
      resourcePolicy: 'immutable',
      paths: ['.codeflare/managed-extensions.json', '.codeflare/managed-paths.json'],
      resourceRoots: [],
    } as const;
    const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const pathsDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { releaseDigest, pathsDigest, bytes };
  }

  it('loads policy with scoped credentials and denies protected mutation before user forwarding', async () => {
    const fixture = await protectedFixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = input as Request;
      if (request.url.endsWith('/bucket/.codeflare/managed-paths.json')) return new Response(fixture.bytes, { status: 200 });
      return new Response('unexpected user forward', { status: 200 });
    });
    const { controller, egressFetch } = makeController({ R2_ACCOUNT_ID: 'acc' }, {
      accountId: 'acc', bucket: 'bucket', resourcePolicy: 'immutable',
      releaseDigest: fixture.releaseDigest, pathsDigest: fixture.pathsDigest,
    });

    const response = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/.codeflare/managed-paths.json', { method: 'DELETE' }));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('<Code>AccessDenied</Code>');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const policyRequest = fetchSpy.mock.calls[0][0] as Request;
    expect(policyRequest.headers.get('authorization')).toContain('Credential=user-r2-key/');
    expect(policyRequest.headers.get('authorization')).not.toContain('admin-r2-key');
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('signs approved adjacent mutation only with the scoped user key', async () => {
    const fixture = await protectedFixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = input as Request;
      if (request.url.endsWith('/bucket/.codeflare/managed-paths.json')) return new Response(fixture.bytes, { status: 200 });
      return new Response('stored', { status: 200 });
    });
    const { controller } = makeController({ R2_ACCOUNT_ID: 'acc' }, {
      accountId: 'acc', bucket: 'bucket', resourcePolicy: 'immutable',
      releaseDigest: fixture.releaseDigest, pathsDigest: fixture.pathsDigest,
    });

    const response = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/Vault/personal.md', { method: 'PUT', body: 'ok' }));

    expect(response.status).toBe(200);
    const userRequest = fetchSpy.mock.calls.map(call => call[0] as Request).find(request => request.url.endsWith('/Vault/personal.md'))!;
    expect(userRequest.headers.get('authorization')).toContain('Credential=user-r2-key/');
    expect(userRequest.headers.get('authorization')).not.toContain('admin-r2-key');
    fetchSpy.mockRestore();
  });

  it('returns S3 503 and never forwards mutation when policy loading fails', async () => {
    const fixture = await protectedFixture('c');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('missing', { status: 404 }));
    const { controller } = makeController({ R2_ACCOUNT_ID: 'acc' }, {
      accountId: 'acc', bucket: 'bucket', resourcePolicy: 'immutable',
      releaseDigest: fixture.releaseDigest, pathsDigest: fixture.pathsDigest,
    });

    const response = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/Vault/personal.md', { method: 'PUT', body: 'ok' }));

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('<Code>ServiceUnavailable</Code>');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});

describe('REQ-ENTERPRISE-016 / AD86: EgressController account-scoped exemption (own account direct, all else Gateway) / REQ-ENTERPRISE-026', () => {
  it('forwards THIS account R2 DIRECT via global fetch — never env.EGRESS', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('r2', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc' });
    const res = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/key'));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('re-signs the bound bucket with its user-scoped key, never the deployment-wide key, while preserving streaming and SSE-C', async () => {
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
    expect(auth).toContain('Credential=user-r2-key/');
    expect(auth).not.toContain('admin-r2-key');
    // rclone's precomputed payload hash is REUSED (not recomputed / UNSIGNED) — body streams unbuffered.
    expect(signed.headers.get('x-amz-content-sha256')).toBe('fixedhash123');
    // SSE-C header preserved AND covered by the new signature (present in SignedHeaders).
    expect(signed.headers.get('x-amz-server-side-encryption-customer-algorithm')).toBe('AES256');
    expect(auth).toContain('x-amz-server-side-encryption-customer-algorithm');
    fetchSpy.mockRestore();
  });

  it('accepts the bound bucket in virtual-hosted R2 form and signs with its scoped key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('r2', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc', bucket: 'bound-bucket' });
    const res = await controller.fetch(new Request('https://bound-bucket.acc.r2.cloudflarestorage.com/key'));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    const signed = fetchSpy.mock.calls[0][0] as Request;
    expect(signed.headers.get('authorization')).toContain('Credential=user-r2-key/');
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects another virtual-hosted bucket in the same account before signing or forwarding', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc', bucket: 'bound-bucket' });
    const res = await controller.fetch(new Request('https://other-bucket.acc.r2.cloudflarestorage.com/key'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_R2_BUCKET_FORBIDDEN');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects another path-style bucket in the same account before signing or forwarding', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, { accountId: 'acc', bucket: 'bound-bucket' });
    const res = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/other-bucket/key'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_R2_BUCKET_FORBIDDEN');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('fails closed when scoped credentials are missing instead of falling back to deployment credentials', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 200 }));
    const { controller, egressFetch } = makeController({}, {
      accountId: 'acc',
      bucket: 'bucket',
      r2AccessKeyId: undefined,
      r2SecretAccessKey: undefined,
    });
    const res = await controller.fetch(new Request('https://acc.r2.cloudflarestorage.com/bucket/key'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe('EGRESS_R2_NOT_CONFIGURED');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
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

describe('REQ-ENTERPRISE-016: EgressController bridges WebSocket upgrades (catch-all fallback)', () => {
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
  const RealWebSocketPair = WebSocketPair;
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
