import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleVscodeRequest, validateVscodeRoute } from '../../routes/vscode';
import type { Env, Session } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

/**
 * Integration coverage for the browser-IDE auth chain + path forwarding.
 *
 * handleVscodeRequest threads requests through the same session-safe guards
 * the vault reuses (origin -> authenticate -> tier -> session ownership ->
 * container health -> WS rate limit -> container.fetch), then forwards the
 * external session URL unchanged to the authenticated container host. The host
 * owns the exact session-prefix strip before code-server. This suite drives the
 * full chain so guard ordering, query bytes, or canonical proxy identity cannot
 * regress silently.
 *
 * Mock strategy mirrors vault-auth-chain.test.ts: stub the I/O boundaries
 * (authenticateRequest, isAllowedOrigin, getContainer, container health) but
 * run the real ordering inside handleVscodeRequest.
 */

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

const mockAuthResult = vi.hoisted(() => ({
  result: null as { user: Record<string, unknown>; bucketName: string } | null,
  error: null as Error | null,
}));

vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => {
    if (mockAuthResult.error) throw mockAuthResult.error;
    return mockAuthResult.result ?? {
      user: { email: 'test@example.com', authenticated: true },
      bucketName: 'test-bucket',
    };
  }),
  resetAuthConfigCache: vi.fn(),
}));

vi.mock('../../lib/cors-cache', () => ({
  isAllowedOrigin: vi.fn().mockResolvedValue(true),
  resetCorsOriginsCache: vi.fn(),
}));

const mockContainerFetch = vi.fn().mockResolvedValue(new Response('ide', { status: 200 }));
vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({ fetch: mockContainerFetch })),
}));

const mockHealth = vi.hoisted(() => ({ healthy: true }));
vi.mock('../../lib/container-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/container-helpers')>();
  return {
    ...actual,
    safeCheckContainerHealth: vi.fn(async () => mockHealth),
  };
});

// Controllable WS rate-limit outcome (default: allowed). Only the WebSocket
// path reads it, so the non-WS tests are unaffected.
const mockRateLimit = vi.hoisted(() => ({
  value: { allowed: true, count: 0, retryAfterSec: 0 } as { allowed: boolean; count: number; retryAfterSec: number },
}));
vi.mock('../../lib/rate-limit-core', () => ({
  checkRateLimit: vi.fn(async () => mockRateLimit.value),
}));

describe('handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;
  let mockCtx: ExecutionContext;
  let waitUntilPromises: Promise<unknown>[];

  const SID = 'abcdef1234567890';
  const SESSION_KEY = `session:test-bucket:${SID}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKV = createMockKV();
    mockAuthResult.result = {
      user: { email: 'test@example.com', authenticated: true },
      bucketName: 'test-bucket',
    };
    mockAuthResult.error = null;
    mockHealth.healthy = true;
    mockRateLimit.value = { allowed: true, count: 0, retryAfterSec: 0 };
    mockContainerFetch.mockResolvedValue(new Response('ide', { status: 200 }));

    mockEnv = {
      KV: mockKV as unknown as KVNamespace,
      CONTAINER: {} as DurableObjectNamespace,
    } as unknown as Env;

    waitUntilPromises = [];
    mockCtx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => { waitUntilPromises.push(promise); }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    mockKV._set(SESSION_KEY, {
      id: SID,
      name: 'Test Session',
      userId: 'test-bucket',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: '2026-01-01T00:00:00.000Z',
    } as Session);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function vscodeRequest(path = `/api/vscode/${SID}/stable/out/main.js`, headers: Record<string, string> = {}): Request {
    return new Request(`https://codeflare.ch${path}`, {
      headers: new Headers({ Origin: 'https://codeflare.ch', ...headers }),
    });
  }
  function route(request: Request) {
    return validateVscodeRoute(request);
  }

  it('REQ-IDE-001 AC3: forwards the external path and exact query with canonical host identity', async () => {
    const query = '?resource=a%2Fb&resource=two+words&empty=&bare';
    const request = vscodeRequest(`/api/vscode/${SID}/stable/out/main.js${query}`, {
      Forwarded: 'for=203.0.113.9;host=evil.example;proto=http',
      'X-Forwarded-Host': 'evil.example',
      'X-Forwarded-Proto': 'http',
    });
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(200);
    expect(mockContainerFetch).toHaveBeenCalledTimes(1);

    const forwarded = mockContainerFetch.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwarded.url);
    expect(forwardedUrl.pathname).toBe(`/api/vscode/${SID}/stable/out/main.js`);
    expect(forwardedUrl.search).toBe(query);
    expect(forwarded.headers.get('Origin')).toBe('https://codeflare.ch');
    expect(forwarded.headers.get('Forwarded')).toBeNull();
    expect(forwarded.headers.get('X-Forwarded-Host')).toBe('codeflare.ch');
    expect(forwarded.headers.get('X-Forwarded-Proto')).toBe('https');
  });

  it('REQ-IDE-012: rejects public workspace selectors before the container boundary', async () => {
    for (const query of [
      '?folder=/etc',
      '?workspace=/tmp/escape.code-workspace',
      '?ew=true',
      '?%66older=/etc',
      '?safe=1&folder=/etc&folder=/home/user/workspace',
    ]) {
      mockContainerFetch.mockClear();
      const request = vscodeRequest(`/api/vscode/${SID}/${query}`);
      const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
      expect(response.status).toBe(400);
      expect((await response.json() as { code: string }).code).toBe('VSCODE_WORKSPACE_SELECTOR_FORBIDDEN');
      expect(mockContainerFetch).not.toHaveBeenCalled();
    }
  });

  it('REQ-IDE-012: rejects a WebSocket workspace selector before the container boundary', async () => {
    const request = vscodeRequest(`/api/vscode/${SID}/ws?folder=/etc`, {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGVzdC13ZWJzb2NrZXQta2V5',
      'Sec-WebSocket-Version': '13',
      'Sec-Fetch-Mode': 'websocket',
    });
    expect(route(request).isWebSocket).toBe(true);

    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));

    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe('VSCODE_WORKSPACE_SELECTOR_FORBIDDEN');
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  it('REQ-IDE-049 AC5: successful editor traffic repairs readiness on fresh primary session state', async () => {
    mockKV._set(SESSION_KEY, {
      id: SID,
      name: 'Updated concurrently',
      userId: 'test-bucket',
      workspace: 'vscode',
      status: 'running',
      editorReady: false,
      editorReadyError: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: '2026-01-01T00:00:00.000Z',
      metrics: { cpu: '42%' },
    } as Session);

    const request = vscodeRequest();
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(200);
    await Promise.all(waitUntilPromises);

    const stored = await mockKV.get(SESSION_KEY, 'json') as Session;
    expect(stored).toMatchObject({
      name: 'Updated concurrently',
      workspace: 'vscode',
      status: 'running',
      editorReady: true,
      metrics: { cpu: '42%' },
    });
    expect(stored.editorReadyError).toBeUndefined();
    expect(stored.lastAccessedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(mockKV.put.mock.calls.some(
      ([writtenKey]) => /^(session-editor|session-metrics|session-status-correction):/.test(String(writtenKey)),
    )).toBe(false);
  });

  it('REQ-IDE-049 AC5: does not recreate a session deleted while editor activity resolves', async () => {
    mockKV._set(SESSION_KEY, {
      id: SID,
      name: 'Deleting',
      userId: 'test-bucket',
      workspace: 'vscode',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: '2026-01-01T00:00:00.000Z',
    } as Session);
    mockContainerFetch.mockImplementationOnce(async () => {
      await mockKV.delete(SESSION_KEY);
      return new Response('ok');
    });

    const request = vscodeRequest();
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(200);
    await Promise.all(waitUntilPromises);

    expect(await mockKV.get(SESSION_KEY, 'json')).toBeNull();
    expect(mockKV.put.mock.calls.some(([writtenKey]) => writtenKey === SESSION_KEY)).toBe(false);
  });

  it('REQ-IDE-001 AC3: preserves an allowlisted caller Origin for code-server to compare independently', async () => {
    const request = vscodeRequest(undefined, { Origin: 'https://allowed-alias.example' });

    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));

    expect(response.status).toBe(200);
    const forwarded = mockContainerFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get('Origin')).toBe('https://allowed-alias.example');
    expect(forwarded.headers.get('X-Forwarded-Host')).toBe('codeflare.ch');
  });

  it('REQ-IDE-050 AC7 / REQ-IDE-001: rejects an unauthenticated Browser IDE request', async () => {
    const { AuthError } = await import('../../lib/error-types');
    mockAuthResult.error = new AuthError('Unauthorized');
    const request = vscodeRequest();
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(401);
    expect((await response.json() as { code: string }).code).toBe('AUTH_FAILED');
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  it('REQ-IDE-001: returns 403 ORIGIN_NOT_ALLOWED when the origin allowlist rejects', async () => {
    const { isAllowedOrigin } = await import('../../lib/cors-cache');
    vi.mocked(isAllowedOrigin).mockResolvedValueOnce(false);
    const request = vscodeRequest(`/api/vscode/${SID}/x`, { Origin: 'https://evil.example.com' });
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe('ORIGIN_NOT_ALLOWED');
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  it('REQ-IDE-050 AC7: rejects a Browser IDE request from an inactive SaaS tier', async () => {
    (mockEnv as unknown as { SAAS_MODE: string }).SAAS_MODE = 'active';
    mockAuthResult.result = {
      user: {
        email: 'test@example.com', authenticated: true,
        accessTier: 'pending', subscriptionTier: 'pending',
      },
      bucketName: 'test-bucket',
    };

    const request = vscodeRequest();
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));

    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe('PENDING');
    expect(mockKV.get).not.toHaveBeenCalledWith(SESSION_KEY, 'json');
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  it('REQ-IDE-050 AC7: rejects a Browser IDE request for a session the user does not own', async () => {
    mockKV._clear();
    const request = vscodeRequest();
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(404);
    expect((await response.json() as { code: string }).code).toBe('SESSION_NOT_FOUND');
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  it('REQ-IDE-001: returns 503 CONTAINER_STOPPED when the owned session is stopped', async () => {
    mockKV._set(SESSION_KEY, {
      id: SID, name: 'Test', userId: 'test-bucket',
      createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z',
      status: 'stopped',
    } as Session);
    const request = vscodeRequest();
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(503);
    expect((await response.json() as { code: string }).code).toBe('CONTAINER_STOPPED');
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  // REQ-IDE-003 AC3: the IDE opens in a bare `_blank` tab, so an unhealthy
  // container must answer a navigable request with a page, not a JSON body the
  // browser renders as raw machine text.
  it('REQ-IDE-003 AC3: an unhealthy container answers a navigable request with a refreshing HTML page', async () => {
    mockHealth.healthy = false;
    const request = vscodeRequest();
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toMatch(/text\/html/);
    const body = await response.text();
    expect(body).toMatch(/<meta[^>]*http-equiv="refresh"/i);
    expect(body).not.toMatch(/CONTAINER_NOT_READY/);
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  it('REQ-IDE-003 AC3: the warming page gives up instead of refreshing forever', async () => {
    mockHealth.healthy = false;
    // An episode that started longer ago than the bound allows.
    const request = vscodeRequest(`/api/vscode/${SID}/?cf_since=${Date.now() - 121_000}`);
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    // The load-bearing half: no meta refresh, so the tab stops reloading against
    // a container that is never going to become healthy.
    const body = await response.text();
    expect(body).not.toMatch(/http-equiv="refresh"/i);
    expect(response.status).toBe(504);
  });

  it('REQ-IDE-003 AC3: the warming page reports the real wait and carries the same start forward', async () => {
    // The wait must be measured, not inferred from a refresh interval: every
    // reload also pays a container health probe of unpredictable duration.
    mockHealth.healthy = false;
    const request = vscodeRequest(`/api/vscode/${SID}/?cf_since=${Date.now() - 30_000}`);
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(Number(/(\d+)s<\/p>/.exec(body)?.[1])).toBeGreaterThanOrEqual(30);
    // The refresh target keeps the ORIGINAL start, so the clock accumulates
    // across reloads instead of restarting on each fresh document.
    const target = /url=([^"]+)"/.exec(body)?.[1] ?? '';
    const carried = Number(new URL(target, 'https://codeflare.ch').searchParams.get('cf_since'));
    expect(Date.now() - carried).toBeGreaterThanOrEqual(30_000);
  });

  it('REQ-IDE-003 AC3: a future start is rejected instead of pinning the tab on the warming page', async () => {
    // The one forged value that is not merely self-harming: it would hold the
    // tab below the bound forever. Everything else only shortens its own retry.
    mockHealth.healthy = false;
    const request = vscodeRequest(`/api/vscode/${SID}/?cf_since=${Date.now() + 600_000}`);
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(Number(/(\d+)s<\/p>/.exec(body)?.[1])).toBe(0);
    const target = /url=([^"]+)"/.exec(body)?.[1] ?? '';
    const carried = Number(new URL(target, 'https://codeflare.ch').searchParams.get('cf_since'));
    expect(carried).toBeLessThanOrEqual(Date.now());
  });

  it('REQ-IDE-003 AC3: a healthy container takes the episode start back out of the tab URL', async () => {
    // The start rides in the query string because the Worker holds no
    // per-session state -- which also puts it in the tab's address bar. Left
    // there, a tab that once reached the bound would serve the give-up page
    // instantly on every later reload, so the success path redirects it away.
    const request = vscodeRequest(`/api/vscode/${SID}/?cf_since=${Date.now() - 5_000}`);
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location') ?? '');
    expect(location.searchParams.has('cf_since')).toBe(false);
    expect(location.pathname).toBe(`/api/vscode/${SID}/`);
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  it('REQ-IDE-001: the warming parameter never reaches the container host', async () => {
    // The parameter belongs to the Worker warming page, so on any request the
    // redirect above does not cover it is still stripped before forwarding.
    const request = new Request(`https://codeflare.ch/api/vscode/${SID}/x?cf_since=${Date.now()}`, {
      method: 'POST',
      headers: new Headers({ Origin: 'https://codeflare.ch' }),
    });
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(200);
    const forwarded = mockContainerFetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).searchParams.has('cf_since')).toBe(false);
  });

  it('REQ-IDE-001 AC3: a WebSocket caller preserves the external path and exact query for the host strip', async () => {
    const query = '?reconnect=a%2Fb&reconnect=two+words&empty=&bare';
    const request = new Request(`https://codeflare.ch/api/vscode/${SID}/ws${query}`, {
      headers: new Headers({
        Origin: 'https://codeflare.ch',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-Fetch-Mode': 'websocket',
      }),
    });
    const rr = route(request);
    expect(rr.isWebSocket).toBe(true);

    const response = await handleVscodeRequest(request, mockEnv, mockCtx, rr);

    expect(response.status).toBe(200);
    const forwarded = mockContainerFetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).pathname).toBe(`/api/vscode/${SID}/ws`);
    expect(new URL(forwarded.url).search).toBe(query);
    expect(forwarded.headers.get('X-Forwarded-Host')).toBe('codeflare.ch');
    expect(forwarded.headers.get('X-Forwarded-Proto')).toBe('https');
  });

  it('REQ-IDE-001: an unhealthy container still answers a WebSocket upgrade with 503 CONTAINER_NOT_READY', async () => {
    // A WS client cannot render a page, so it keeps the machine-readable body.
    mockHealth.healthy = false;
    const request = new Request(`https://codeflare.ch/api/vscode/${SID}/ws`, {
      headers: new Headers({
        Origin: 'https://codeflare.ch',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-Fetch-Mode': 'websocket',
      }),
    });
    const rr = route(request);
    expect(rr.isWebSocket).toBe(true);
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, rr);
    expect(response.status).toBe(503);
    expect((await response.json() as { code: string }).code).toBe('CONTAINER_NOT_READY');
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  // REQ-IDE-002: the sessionId is the sole container selector, so a session
  // owned by a DIFFERENT bucket is unreachable -- cross-session/tenant isolation.
  it('REQ-IDE-002: a session existing only under a different bucket is not reachable (404)', async () => {
    mockKV._clear();
    mockKV._set(`session:other-bucket:${SID}`, {
      id: SID, name: 'Other', userId: 'other-bucket',
      createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z',
    } as Session);
    const request = vscodeRequest();
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(404);
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  // REQ-IDE-001: the browser-WS Origin guard runs BEFORE the auth chain -- a real
  // browser WebSocket always sends Origin, so its absence on a browser client is
  // rejected 403. Deleting the guard lets the request fall through to a 200.
  it('REQ-IDE-001: a browser WebSocket upgrade without an Origin header is rejected 403', async () => {
    const request = new Request(`https://codeflare.ch/api/vscode/${SID}/ws`, {
      headers: new Headers({
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-Fetch-Mode': 'websocket',
        // deliberately NO Origin
      }),
    });
    const rr = route(request);
    expect(rr.isWebSocket).toBe(true);
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, rr);
    expect(response.status).toBe(403);
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  // REQ-IDE-001: the IDE WS shares the ws-connect:<email> bucket with terminal +
  // vault; over the limit it MUST 429 with Retry-After. This is a real DoS
  // control -- deleting the rate-limit block would leave the suite green without
  // this case (the coverage gap the code review flagged).
  it('REQ-IDE-001: a WebSocket upgrade over the shared per-user connection limit is rejected 429 with Retry-After', async () => {
    mockRateLimit.value = { allowed: false, count: 31, retryAfterSec: 42 };
    const request = new Request(`https://codeflare.ch/api/vscode/${SID}/ws`, {
      headers: new Headers({
        Origin: 'https://codeflare.ch',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-Fetch-Mode': 'websocket',
      }),
    });
    const rr = route(request);
    expect(rr.isWebSocket).toBe(true);
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, rr);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });
});
