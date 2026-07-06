/**
 * REQ-BROWSER-008: CloudflareBrowserInterceptor — enterprise Browser Rendering token injection.
 *
 * The container holds only the non-secret CLOUDFLARE_API_TOKEN placeholder. This interceptor,
 * wired for api.cloudflare.com, strips the placeholder and injects the real admin Browser
 * Rendering token — but ONLY for the wizard-configured browser account's /browser-rendering/*
 * path (REST + CDP WebSocket). Everything else on api.cloudflare.com goes to the Gateway
 * (env.EGRESS) when strict, else 403. The real token never enters the container.
 *
 * Construction mirrors the DO: new CloudflareBrowserInterceptor(ctx, env) with the per-session
 * props on ctx (browserAccountId, browserToken, strict).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../types';
import {
  CloudflareBrowserInterceptor,
  isBrowserRenderingPath,
  INTERCEPTED_CF_BROWSER_HOSTS,
  INTERCEPTED_CF_OAUTH_HOSTS,
} from '../cloudflare-browser-interceptor';
import { getValidCloudflareToken } from '../lib/cloudflare-token';

vi.mock('../lib/cloudflare-token', () => ({ getValidCloudflareToken: vi.fn() }));
const mockGetValidToken = vi.mocked(getValidCloudflareToken);

const PLACEHOLDER = 'codeflare-enterprise';
const REAL_TOKEN = 'real-browser-rendering-token';
const OAUTH_PLACEHOLDER = 'codeflare-oauth';
const FRESH_TOKEN = 'cf_refreshed_oauth_token';

/** OAuth-mode construction: only the bound bucket in props (no enterprise browser token/account). */
function makeOAuthInterceptor(bucket = 'session-bucket') {
  const env = { ENTERPRISE_MODE: undefined } as unknown as Env;
  const ctx = { props: { bucket } } as unknown as ExecutionContext;
  return new CloudflareBrowserInterceptor(ctx, env);
}

function makeInterceptor(
  props: { browserAccountId?: string; browserToken?: string; strict?: boolean } = {},
  envOverrides: Partial<Env> = {},
) {
  const egressFetch = vi.fn(async (_req: Request) => new Response('gateway', { status: 200 }));
  const env = {
    ENTERPRISE_MODE: 'active',
    EGRESS: { fetch: egressFetch },
    ...envOverrides,
  } as unknown as Env;
  const ctx = {
    props: { browserAccountId: 'acc', browserToken: REAL_TOKEN, strict: true, ...props },
  } as unknown as ExecutionContext;
  return { interceptor: new CloudflareBrowserInterceptor(ctx, env), egressFetch };
}

describe('REQ-BROWSER-008: isBrowserRenderingPath (account-scoped trust)', () => {
  it('matches ONLY the configured account browser-rendering path; fail-secure otherwise', () => {
    const trusted = new URL('https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/snapshot');
    expect(isBrowserRenderingPath(trusted, 'acc')).toBe(true);
    // Different account → not trusted (closes cross-account use of the injected token).
    expect(isBrowserRenderingPath(new URL('https://api.cloudflare.com/client/v4/accounts/other/browser-rendering/snapshot'), 'acc')).toBe(false);
    // Non-browser-rendering path on the same account → not trusted.
    expect(isBrowserRenderingPath(new URL('https://api.cloudflare.com/client/v4/accounts/acc/tokens/verify'), 'acc')).toBe(false);
    // Empty/absent configured account → nothing trusted (fail-secure).
    expect(isBrowserRenderingPath(trusted, '')).toBe(false);
    expect(isBrowserRenderingPath(trusted, undefined)).toBe(false);
    // Wrong host that merely contains the path → not trusted.
    expect(isBrowserRenderingPath(new URL('https://evil.example.com/client/v4/accounts/acc/browser-rendering/x'), 'acc')).toBe(false);
  });
});

describe('REQ-BROWSER-008: CloudflareBrowserInterceptor REST path', () => {
  it('strips the placeholder + injects the real token on the configured account path, egress DIRECT (not Gateway)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const { interceptor, egressFetch } = makeInterceptor({ browserAccountId: 'acc', browserToken: REAL_TOKEN });
    await interceptor.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/snapshot', {
        method: 'POST',
        headers: { authorization: `Bearer ${PLACEHOLDER}`, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(fetchSpy).toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    const fwd = fetchSpy.mock.calls[0][0] as Request;
    // The placeholder is gone; the real token is stamped — fails if the inject is removed.
    expect(fwd.headers.get('authorization')).toBe(`Bearer ${REAL_TOKEN}`);
    fetchSpy.mockRestore();
  });

  it('fails closed 401 on the trusted path when NO admin token is configured (no upstream call)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { interceptor, egressFetch } = makeInterceptor({ browserAccountId: 'acc', browserToken: undefined });
    const res = await interceptor.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/snapshot'),
    );
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('routes a DIFFERENT account browser-rendering path to the Gateway, never injecting the real token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'));
    const { interceptor, egressFetch } = makeInterceptor({ browserAccountId: 'acc', browserToken: REAL_TOKEN, strict: true });
    await interceptor.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/other/browser-rendering/snapshot', {
        headers: { authorization: `Bearer ${PLACEHOLDER}` },
      }),
    );
    expect(egressFetch).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const fwd = egressFetch.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).not.toBe(`Bearer ${REAL_TOKEN}`);
    fetchSpy.mockRestore();
  });

  it('routes a non-browser-rendering api.cloudflare.com path (own account) to the Gateway — not trusted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'));
    const { interceptor, egressFetch } = makeInterceptor({ browserAccountId: 'acc', browserToken: REAL_TOKEN, strict: true });
    await interceptor.fetch(new Request('https://api.cloudflare.com/client/v4/accounts/acc/tokens/verify'));
    expect(egressFetch).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('fails closed 403 for an untrusted path when strict egress is OFF (no Gateway to inspect through)', async () => {
    const { interceptor, egressFetch } = makeInterceptor({ browserAccountId: 'acc', browserToken: REAL_TOKEN, strict: false });
    const res = await interceptor.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/other/browser-rendering/snapshot'),
    );
    expect(res.status).toBe(403);
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('returns 503 for an untrusted path when strict is ON but EGRESS is unbound (fail closed)', async () => {
    const { interceptor } = makeInterceptor(
      { browserAccountId: 'acc', browserToken: REAL_TOKEN, strict: true },
      { EGRESS: undefined } as Partial<Env>,
    );
    const res = await interceptor.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/other/browser-rendering/snapshot'),
    );
    expect(res.status).toBe(503);
  });
});

describe('REQ-BROWSER-008: CloudflareBrowserInterceptor CDP WebSocket', () => {
  const makeUpstreamWs = () => ({
    accept: vi.fn(),
    addEventListener: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  });

  // Capture every WebSocketPair the interceptor creates and close both ends after each test so
  // the vitest-pool-workers isolate tears down cleanly (a live accepted socket crashes the pool).
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

  it('bridges the CDP upgrade on the trusted path, injecting the token, returning a FRESH client socket, direct not Gateway', async () => {
    const upstreamWs = makeUpstreamWs();
    const ws101 = { status: 101, webSocket: upstreamWs, headers: new Headers() } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ws101);
    const { interceptor, egressFetch } = makeInterceptor({ browserAccountId: 'acc', browserToken: REAL_TOKEN });
    const res = await interceptor.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/devtools/browser', {
        headers: { Upgrade: 'websocket', authorization: `Bearer ${PLACEHOLDER}` },
      }),
    );
    expect(res.status).toBe(101);
    const clientWs = (res as unknown as { webSocket?: unknown }).webSocket;
    expect(clientWs).toBeTruthy();
    expect(clientWs).not.toBe(upstreamWs); // bridged, not returned as-is
    expect(upstreamWs.accept).toHaveBeenCalled();
    expect(upstreamWs.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(fetchSpy).toHaveBeenCalled();
    expect(egressFetch).not.toHaveBeenCalled();
    const fwd = fetchSpy.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).toBe(`Bearer ${REAL_TOKEN}`);
    fetchSpy.mockRestore();
  });

  it('fails closed 401 on a trusted CDP upgrade with no token configured (no upstream)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { interceptor } = makeInterceptor({ browserAccountId: 'acc', browserToken: undefined });
    const res = await interceptor.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/devtools/browser', {
        headers: { Upgrade: 'websocket' },
      }),
    );
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('REQ-AGENT-078: CloudflareBrowserInterceptor OAuth mode (non-enterprise) — REST', () => {
  beforeEach(() => { mockGetValidToken.mockReset(); });

  it('stamps a FRESH refreshed token on ANY api.cloudflare.com path (e.g. wrangler), egress DIRECT', async () => {
    mockGetValidToken.mockResolvedValue(FRESH_TOKEN);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const interceptor = makeOAuthInterceptor('session-bucket');
    // A NON-browser-rendering path — OAuth mode trusts ALL paths (the OAuth token is a full API token).
    await interceptor.fetch(new Request('https://api.cloudflare.com/client/v4/accounts/x/workers/scripts', {
      method: 'GET', headers: { authorization: `Bearer ${OAUTH_PLACEHOLDER}` },
    }));
    expect(mockGetValidToken).toHaveBeenCalledWith(expect.anything(), 'session-bucket');
    const fwd = fetchSpy.mock.calls[0][0] as Request;
    // The forwarded credential is the REFRESHED token, not the placeholder — fails if a static
    // baked token were used instead of getValidCloudflareToken (the whole point of the fix).
    expect(fwd.headers.get('authorization')).toBe(`Bearer ${FRESH_TOKEN}`);
    fetchSpy.mockRestore();
  });

  it('strips the container placeholder — never forwards it upstream', async () => {
    mockGetValidToken.mockResolvedValue(FRESH_TOKEN);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const interceptor = makeOAuthInterceptor();
    await interceptor.fetch(new Request('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { authorization: `Bearer ${OAUTH_PLACEHOLDER}` },
    }));
    const fwd = fetchSpy.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).not.toContain(OAUTH_PLACEHOLDER);
    fetchSpy.mockRestore();
  });

  it('fails closed 401 with NO upstream when no valid token can be minted', async () => {
    mockGetValidToken.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const interceptor = makeOAuthInterceptor();
    const res = await interceptor.fetch(new Request('https://api.cloudflare.com/client/v4/user/tokens/verify'));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('resolves the token from the BOUND bucket only, never from the request (no cross-user spoof)', async () => {
    mockGetValidToken.mockResolvedValue(FRESH_TOKEN);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const interceptor = makeOAuthInterceptor('the-session-bucket');
    await interceptor.fetch(new Request('https://api.cloudflare.com/client/v4/user', {
      headers: { 'x-bucket': 'attacker-bucket', authorization: `Bearer ${OAUTH_PLACEHOLDER}` },
    }));
    expect(mockGetValidToken).toHaveBeenCalledWith(expect.anything(), 'the-session-bucket');
    expect(mockGetValidToken).not.toHaveBeenCalledWith(expect.anything(), 'attacker-bucket');
    fetchSpy.mockRestore();
  });

  it('fails closed 502 with NO upstream when the token lookup THROWS (not just null)', async () => {
    mockGetValidToken.mockRejectedValue(new Error('kv decrypt boom'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const interceptor = makeOAuthInterceptor();
    const res = await interceptor.fetch(new Request('https://api.cloudflare.com/client/v4/user'));
    expect(res.status).toBe(502);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns 502 when the upstream fetch throws after a token is minted', async () => {
    mockGetValidToken.mockResolvedValue(FRESH_TOKEN);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const interceptor = makeOAuthInterceptor();
    const res = await interceptor.fetch(new Request('https://api.cloudflare.com/client/v4/user', {
      headers: { authorization: `Bearer ${OAUTH_PLACEHOLDER}` },
    }));
    expect(res.status).toBe(502);
    fetchSpy.mockRestore();
  });
});

describe('REQ-AGENT-078: OAuth mode — AI Gateway data-plane (gateway.ai.cloudflare.com)', () => {
  beforeEach(() => { mockGetValidToken.mockReset(); });

  it('stamps the FRESH token as cf-aig-authorization (gateway auth), NOT as Authorization', async () => {
    mockGetValidToken.mockResolvedValue(FRESH_TOKEN);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const interceptor = makeOAuthInterceptor('session-bucket');
    await interceptor.fetch(new Request(
      'https://gateway.ai.cloudflare.com/v1/acct/codeflare-enterprise/compat/chat/completions',
      { method: 'POST', headers: { authorization: 'Bearer provider-key' }, body: '{}' },
    ));
    expect(mockGetValidToken).toHaveBeenCalledWith(expect.anything(), 'session-bucket');
    const fwd = fetchSpy.mock.calls[0][0] as Request;
    // Gateway auth rides cf-aig-authorization with the refreshed token (the aig.run scope) — fails if
    // a static/placeholder token were used, or if it were stamped on Authorization instead.
    expect(fwd.headers.get('cf-aig-authorization')).toBe(`Bearer ${FRESH_TOKEN}`);
    fetchSpy.mockRestore();
  });

  it('leaves the caller Authorization (upstream provider / BYOK key) untouched on the gateway host', async () => {
    mockGetValidToken.mockResolvedValue(FRESH_TOKEN);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const interceptor = makeOAuthInterceptor();
    await interceptor.fetch(new Request(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions',
      { method: 'POST', headers: { authorization: 'Bearer provider-key' }, body: '{}' },
    ));
    const fwd = fetchSpy.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).toBe('Bearer provider-key');
    fetchSpy.mockRestore();
  });

  it('strips a container-supplied cf-aig-authorization placeholder before stamping the fresh token', async () => {
    mockGetValidToken.mockResolvedValue(FRESH_TOKEN);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const interceptor = makeOAuthInterceptor();
    await interceptor.fetch(new Request(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions',
      { method: 'POST', headers: { 'cf-aig-authorization': `Bearer ${OAUTH_PLACEHOLDER}` }, body: '{}' },
    ));
    const fwd = fetchSpy.mock.calls[0][0] as Request;
    expect(fwd.headers.get('cf-aig-authorization')).toBe(`Bearer ${FRESH_TOKEN}`);
    expect(fwd.headers.get('cf-aig-authorization')).not.toContain(OAUTH_PLACEHOLDER);
    fetchSpy.mockRestore();
  });

  it('fails closed 401 with NO upstream on the gateway host when no valid token can be minted', async () => {
    mockGetValidToken.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const interceptor = makeOAuthInterceptor();
    const res = await interceptor.fetch(new Request(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions', { method: 'POST', body: '{}' },
    ));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('REQ-AGENT-078: enterprise isolation — the AI Gateway host is OAuth-mode only', () => {
  it('has gateway.ai.cloudflare.com in the OAuth host list but NEVER in the enterprise browser host list', () => {
    // Enterprise wiring (wireCloudflareBrowserInterception) iterates INTERCEPTED_CF_BROWSER_HOSTS;
    // OAuth wiring (wireCloudflareApiInterception) iterates INTERCEPTED_CF_OAUTH_HOSTS. If the gateway
    // host ever leaked into the enterprise list, enterprise would intercept its own LlmInterceptor
    // gateway rewrites and break LLM routing — this pins the separation.
    expect(INTERCEPTED_CF_BROWSER_HOSTS).not.toContain('gateway.ai.cloudflare.com');
    expect(INTERCEPTED_CF_OAUTH_HOSTS).toContain('gateway.ai.cloudflare.com');
    expect(INTERCEPTED_CF_OAUTH_HOSTS).toContain('api.cloudflare.com');
  });
});

describe('REQ-AGENT-078: CloudflareBrowserInterceptor OAuth mode — CDP WebSocket', () => {
  const createdPairs: Array<Record<string, WebSocket>> = [];
  const RealWebSocketPair = WebSocketPair;
  beforeEach(() => {
    mockGetValidToken.mockReset();
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

  it('bridges the CDP upgrade with the fresh token, returning a FRESH client socket, direct not Gateway', async () => {
    mockGetValidToken.mockResolvedValue(FRESH_TOKEN);
    const upstreamWs = { accept: vi.fn(), addEventListener: vi.fn(), send: vi.fn(), close: vi.fn() };
    const ws101 = { status: 101, webSocket: upstreamWs, headers: new Headers() } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ws101);
    const interceptor = makeOAuthInterceptor();
    const res = await interceptor.fetch(
      new Request('https://api.cloudflare.com/client/v4/accounts/x/browser-rendering/devtools/browser', {
        headers: { Upgrade: 'websocket', authorization: `Bearer ${OAUTH_PLACEHOLDER}` },
      }),
    );
    expect(res.status).toBe(101);
    const clientWs = (res as unknown as { webSocket?: unknown }).webSocket;
    expect(clientWs).toBeTruthy();
    expect(clientWs).not.toBe(upstreamWs); // bridged, not returned as-is
    expect(upstreamWs.accept).toHaveBeenCalled();
    const fwd = fetchSpy.mock.calls[0][0] as Request;
    expect(fwd.headers.get('authorization')).toBe(`Bearer ${FRESH_TOKEN}`);
    fetchSpy.mockRestore();
  });
});
