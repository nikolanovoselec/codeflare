import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleWebSocketUpgrade, validateWebSocketRoute } from '../../routes/terminal';
import type { Env, Session } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

// Mock dependencies
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

const mockAuthResult = vi.hoisted(() => ({
  result: null as { user: { email: string; authenticated: boolean }; bucketName: string } | null,
  error: null as Error | null,
}));

vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => {
    if (mockAuthResult.error) throw mockAuthResult.error;
    return mockAuthResult.result ?? { user: { email: 'test@example.com', authenticated: true }, bucketName: 'test-bucket' };
  }),
  resetAuthConfigCache: vi.fn(),
}));

vi.mock('../../lib/cors-cache', () => ({
  isAllowedOrigin: vi.fn().mockResolvedValue(true),
  resetCorsOriginsCache: vi.fn(),
}));

vi.mock('../../lib/circuit-breakers', () => ({
  getContainerSessionsCB: () => ({ execute: vi.fn((fn: () => Promise<any>) => fn()) }),
  getContainerHealthCB: () => ({ execute: vi.fn((fn: () => Promise<any>) => fn()) }),
}));

// Workers runtime doesn't allow constructing responses with status 101;
// use 200 as a stand-in for a successful container forward.
const mockContainerFetch = vi.fn().mockResolvedValue(new Response('ws upgrade', { status: 200 }));
// safeCheckContainerHealth() reads container.getState() before fetching /health
// to avoid auto-starting a hibernated container; mock it as "running" so the
// warming-up probe in handleWebSocketUpgrade reaches the fetch path.
const mockContainerGetState = vi.fn().mockResolvedValue({ status: 'running' });

vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({
    fetch: mockContainerFetch,
    getState: mockContainerGetState,
  })),
}));

describe('handleWebSocketUpgrade', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;
  let mockCtx: ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKV = createMockKV();
    mockAuthResult.result = { user: { email: 'test@example.com', authenticated: true }, bucketName: 'test-bucket' };
    mockAuthResult.error = null;

    mockEnv = {
      KV: mockKV as unknown as KVNamespace,
      CONTAINER: {} as DurableObjectNamespace,
    } as unknown as Env;

    mockCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    // Store a session in mock KV
    const session: Session = {
      id: 'testsession123',
      name: 'Test Session',
      userId: 'test-bucket',
      createdAt: '2024-01-15T10:00:00.000Z',
      lastAccessedAt: '2024-01-15T10:00:00.000Z',
    };
    mockKV._set('session:test-bucket:testsession123', session);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createRequest(headers: Record<string, string> = {}): Request {
    return new Request('https://example.com/api/terminal/testsession123-1/ws', {
      headers: new Headers({
        Upgrade: 'websocket',
        Origin: 'https://example.workers.dev',
        ...headers,
      }),
    });
  }

  it('returns 500 for invalid routing result (missing fields)', async () => {
    const request = createRequest();
    const routeResult = { isWebSocketRoute: true };

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.status).toBe(500);

    const body = await response.json() as { error: string; code: string };
    expect(body.error).toBe('Invalid routing result');
    expect(body.code).toBe('INVALID_ROUTING');
  });

  it('authenticates user and forwards to container on success', async () => {
    const request = createRequest();
    const routeResult = validateWebSocketRoute(request);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    // The mocked container returns 200 (101 can't be constructed in Workers runtime)
    expect(response.status).toBe(200);
  });

  it('returns 401 when authentication fails with AuthError', async () => {
    const { AuthError } = await import('../../lib/error-types');
    mockAuthResult.error = new AuthError('Unauthorized');

    const request = createRequest();
    const routeResult = validateWebSocketRoute(request);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.status).toBe(401);

    const body = await response.json() as { error: string; code: string };
    expect(body.error).toBe('Unauthorized');
    expect(body.code).toBe('AUTH_FAILED');
  });

  it('returns 403 when authentication fails with ForbiddenError', async () => {
    const { ForbiddenError } = await import('../../lib/error-types');
    mockAuthResult.error = new ForbiddenError('Forbidden');

    const request = createRequest();
    const routeResult = validateWebSocketRoute(request);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.status).toBe(403);
  });

  it('returns 404 when session does not exist in KV', async () => {
    mockKV._clear();

    const request = createRequest();
    const routeResult = validateWebSocketRoute(request);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.status).toBe(404);

    const body = await response.json() as { error: string; code: string };
    expect(body.error).toBe('Session not found');
    expect(body.code).toBe('SESSION_NOT_FOUND');
  });

  it('includes X-Request-ID header in responses', async () => {
    mockKV._clear();

    const request = createRequest();
    const routeResult = validateWebSocketRoute(request);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.headers.get('X-Request-ID')).toBeTruthy();
  });

  it('uses client-provided X-Request-ID when valid', async () => {
    mockKV._clear();

    const request = createRequest({ 'X-Request-ID': 'my-req-id' });
    const routeResult = validateWebSocketRoute(request);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.headers.get('X-Request-ID')).toBe('my-req-id');
  });

  it('returns 403 when Origin is not allowed', async () => {
    const { isAllowedOrigin } = await import('../../lib/cors-cache');
    vi.mocked(isAllowedOrigin).mockResolvedValueOnce(false);

    const request = createRequest({ Origin: 'https://evil.example.com' });
    const routeResult = validateWebSocketRoute(request);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.status).toBe(403);

    const body = await response.json() as { error: string; code: string };
    expect(body.error).toBe('Origin not allowed');
    expect(body.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('requires Origin for browser clients (Sec-WebSocket-Key + Sec-Fetch-Mode)', async () => {
    const request = new Request('https://example.com/api/terminal/testsession123-1/ws', {
      headers: new Headers({
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-Fetch-Mode': 'websocket',
        // Note: no Origin header
      }),
    });
    const routeResult = validateWebSocketRoute(request);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.status).toBe(403);
  });

  describe('SaaS mode access tier gating', () => {
    it('returns 403 with code PENDING when SAAS_MODE=active and subscriptionTier=pending', async () => {
      (mockEnv as any).SAAS_MODE = 'active';
      mockAuthResult.result = {
        user: { email: 'test@example.com', authenticated: true, accessTier: 'pending', subscriptionTier: 'pending' } as any,
        bucketName: 'test-bucket',
      };

      const request = createRequest();
      const routeResult = validateWebSocketRoute(request);

      const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
      expect(response.status).toBe(403);

      const body = await response.json() as { error: string; code: string };
      expect(body.error).toBe('Access denied');
      expect(body.code).toBe('PENDING');
    });

    it('returns 403 with code BLOCKED when SAAS_MODE=active and subscriptionTier=blocked', async () => {
      (mockEnv as any).SAAS_MODE = 'active';
      mockAuthResult.result = {
        user: { email: 'test@example.com', authenticated: true, accessTier: 'blocked', subscriptionTier: 'blocked' } as any,
        bucketName: 'test-bucket',
      };

      const request = createRequest();
      const routeResult = validateWebSocketRoute(request);

      const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
      expect(response.status).toBe(403);

      const body = await response.json() as { error: string; code: string };
      expect(body.error).toBe('Access denied');
      expect(body.code).toBe('BLOCKED');
    });

    it('proceeds when SAAS_MODE=active and subscriptionTier=standard', async () => {
      (mockEnv as any).SAAS_MODE = 'active';
      mockAuthResult.result = {
        user: { email: 'test@example.com', authenticated: true, accessTier: 'standard', subscriptionTier: 'standard' } as any,
        bucketName: 'test-bucket',
      };

      const request = createRequest();
      const routeResult = validateWebSocketRoute(request);

      const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
      // 200 = successful container forward (not 403)
      expect(response.status).toBe(200);
    });

    it('proceeds regardless of tier when SAAS_MODE is inactive', async () => {
      // SAAS_MODE not set (default in beforeEach)
      mockAuthResult.result = {
        user: { email: 'test@example.com', authenticated: true, accessTier: 'pending', subscriptionTier: 'pending' } as any,
        bucketName: 'test-bucket',
      };

      const request = createRequest();
      const routeResult = validateWebSocketRoute(request);

      const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
      // Should proceed to container forward, not be blocked
      expect(response.status).toBe(200);
    });
  });

  describe('stress test mode bypass', () => {
    it('WebSocket rate limit KV calls skipped when STRESS_TEST_MODE === "active"', async () => {
      (mockEnv as any).STRESS_TEST_MODE = 'active';

      const request = createRequest();
      const routeResult = validateWebSocketRoute(request);

      const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
      expect(response.status).toBe(200);

      // KV.get IS called for session lookup, but should NOT be called with 'ws-connect:' prefix
      const getCalls = mockKV.get.mock.calls;
      const wsConnectGetCalls = getCalls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      );
      expect(wsConnectGetCalls).toHaveLength(0);

      const putCalls = mockKV.put.mock.calls;
      const wsConnectPutCalls = putCalls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      );
      expect(wsConnectPutCalls).toHaveLength(0);
    });

    it('WebSocket rate limit enforced when STRESS_TEST_MODE is unset', async () => {
      // Do not set STRESS_TEST_MODE (it's not set by default in beforeEach)

      const request = createRequest();
      const routeResult = validateWebSocketRoute(request);

      const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
      expect(response.status).toBe(200);

      // KV.get should have been called with a key starting with 'ws-connect:'
      const getCalls = mockKV.get.mock.calls;
      const wsConnectGetCalls = getCalls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      );
      expect(wsConnectGetCalls.length).toBeGreaterThan(0);

      // KV.put should have been called with a key starting with 'ws-connect:'
      const putCalls = mockKV.put.mock.calls;
      const wsConnectPutCalls = putCalls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      );
      expect(wsConnectPutCalls.length).toBeGreaterThan(0);
    });
  });

  describe('CF-015: Stopped session returns 4503 close code', () => {
    it('returns WebSocket upgrade with 4503 close for stopped session', async () => {
      const sessionId = 'abcdef1234567890';
      mockKV._set(`session:test-bucket:${sessionId}`, {
        id: sessionId,
        name: 'Test',
        userId: 'test-bucket',
        createdAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: '2026-01-01T00:00:00Z',
        status: 'stopped',
      });

      const request = new Request(`http://localhost/api/terminal/${sessionId}-1/ws`, {
        headers: {
          'Upgrade': 'websocket',
          'Origin': 'http://localhost',
        },
      });

      const env = {
        KV: mockKV as unknown as KVNamespace,
        CONTAINER: {},
      } as unknown as Env;

      const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
      const routeResult = validateWebSocketRoute(request);
      expect(routeResult.isWebSocketRoute).toBe(true);
      const result = await handleWebSocketUpgrade(request, env, ctx, routeResult as any);

      // Should return 101 (WebSocket upgrade accepted then closed with 4503)
      expect(result.status).toBe(101);
    });

    it('does NOT burn WebSocket rate-limit budget when session is stopped (reconnect-storm protection)', async () => {
      // Reconnect storms during container outages were self-locking users for ~2min:
      // browser auto-reconnect would hit /api/terminal/:id/ws 30+ times in 60s while
      // the container was down, the rate-limit incremented on each, and even after
      // the container came back the user was throttled. Stopped-session rejection
      // must short-circuit before the rate-limit check.
      const sessionId = 'abcdef1234567890';
      mockKV._set(`session:test-bucket:${sessionId}`, {
        id: sessionId,
        name: 'Test',
        userId: 'test-bucket',
        createdAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: '2026-01-01T00:00:00Z',
        status: 'stopped',
      });

      const request = new Request(`http://localhost/api/terminal/${sessionId}-1/ws`, {
        headers: { 'Upgrade': 'websocket', 'Origin': 'http://localhost' },
      });
      const env = {
        KV: mockKV as unknown as KVNamespace,
        CONTAINER: {},
      } as unknown as Env;
      const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
      const routeResult = validateWebSocketRoute(request);

      const result = await handleWebSocketUpgrade(request, env, ctx, routeResult as any);

      expect(result.status).toBe(101); // 4503-close path still returns successful upgrade
      const wsConnectGetCalls = mockKV.get.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      );
      const wsConnectPutCalls = mockKV.put.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      );
      expect(wsConnectGetCalls).toHaveLength(0);
      expect(wsConnectPutCalls).toHaveLength(0);
    });
  });

  describe('container-warming-up gate (PR #365)', () => {
    it('returns 1013 close without burning rate-limit when /health reports terminalServiceReady=false', async () => {
      // PR #364 regression: port 8080 binds at ~1.5s but .bashrc autostart
      // isn't written until ~10s. Worker peeks /health and short-circuits
      // with 1013 so reconnect storms during warm-up don't burn budget.
      mockContainerFetch.mockImplementation(async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === '/health') {
          return new Response(JSON.stringify({ terminalServiceReady: false, prewarmReady: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('ws upgrade', { status: 200 });
      });

      const request = createRequest();
      const routeResult = validateWebSocketRoute(request);
      const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);

      expect(response.status).toBe(101); // 1013-close path returns successful upgrade
      const wsConnectGetCalls = mockKV.get.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      );
      const wsConnectPutCalls = mockKV.put.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      );
      expect(wsConnectGetCalls).toHaveLength(0);
      expect(wsConnectPutCalls).toHaveLength(0);
    });

    it('proceeds to rate-limit + forward when /health reports terminalServiceReady=true', async () => {
      mockContainerFetch.mockImplementation(async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === '/health') {
          return new Response(JSON.stringify({ terminalServiceReady: true, prewarmReady: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('ws upgrade', { status: 200 });
      });

      const request = createRequest();
      const routeResult = validateWebSocketRoute(request);
      const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);

      expect(response.status).toBe(200); // normal forward path
      const wsConnectPutCalls = mockKV.put.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      );
      // rate-limit IS incremented on the success path
      expect(wsConnectPutCalls.length).toBeGreaterThan(0);
    });

    it('falls through to normal flow when /health probe fails (fail-open) AND rate-limit IS burned', async () => {
      mockContainerFetch.mockImplementation(async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === '/health') {
          throw new Error('container unreachable');
        }
        return new Response('ws upgrade', { status: 200 });
      });

      const request = createRequest();
      const routeResult = validateWebSocketRoute(request);
      const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);

      // Fail-open: probe failure should not block the upgrade
      expect(response.status).toBe(200);
      // CRITICAL: rate-limit IS burned on fallthrough — otherwise a future
      // refactor could short-circuit before rate-limit on probe failure and
      // re-enable the self-lockout this PR was built to prevent.
      const wsConnectPutCalls = mockKV.put.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      );
      expect(wsConnectPutCalls.length).toBeGreaterThan(0);
    });
  });
});
