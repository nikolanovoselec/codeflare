import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleWebSocketUpgrade, validateWebSocketRoute } from '../../routes/terminal';
import { CONTAINER_WS_FORWARD_TIMEOUT_MS } from '../../lib/constants';
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
const defaultContainerFetch = async (request: Request): Promise<Response> => {
  if (new URL(request.url).pathname === '/health') {
    return new Response(JSON.stringify({ terminalServiceReady: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('ws upgrade', { status: 200 });
};
const mockContainerFetch = vi.fn(defaultContainerFetch);
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

// REQ-SESSION-012: Wake-loop prevention
// REQ-SESSION-015: Container Port-Readiness Gating with Pre-Warm Pre-Condition

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
    // clearAllMocks resets call history but NOT implementations, and no config
    // sets mockReset/restoreMocks. Several cases here install a per-URL fetch —
    // one of them throwing — so without this a later test silently inherits the
    // previous one's behaviour and fails by declaration order.
    mockContainerFetch.mockReset().mockImplementation(defaultContainerFetch);
    mockContainerGetState.mockReset().mockResolvedValue({ status: 'running' });
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

  // REQ-SEC-019 AC1: WebSocket connections are rate-limited (30 per 60s per user); enforced unless STRESS_TEST_MODE bypasses it.
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

  describe('REQ-TERM-022: a rejected container forward closes retryably instead of throwing', () => {
    // A destroyed container REJECTS the forward ('Network connection lost.'); the
    // forward race only ever covered the HANG. An unhandled reject fell through to
    // the route's generic 500 handler, and a handshake answered by anything other
    // than a 101 reaches the browser as an abnormal closure (1006) - in the
    // client's retryable set, but no socket ever opened, so its backoff stayed
    // pinned at the 500ms base. Observed in prod 2026-07-27: ~1 upgrade/second for
    // 20+ minutes against a dead session. Resolving with a retryable close is what
    // lets the client's existing backoff actually run.
    it('resolves with a WebSocket close instead of propagating the container reject', async () => {
      const sessionId = 'abcdef1234567890';
      mockKV._set(`session:test-bucket:${sessionId}`, {
        id: sessionId,
        name: 'Test',
        userId: 'test-bucket',
        createdAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: '2026-01-01T00:00:00Z',
        // 'running' on purpose: this is exactly the state a destroyed session is
        // left in when onStop cannot write KV, which is what bypasses the 4503
        // gate and drops the request onto the forward path.
        status: 'running',
      });
      // Reject the FORWARD specifically. A one-shot rejection is consumed by the
      // warming-up /health probe that runs first, which fails open — so the
      // forward would then get the default 200 and the case would prove nothing.
      mockContainerFetch.mockImplementation(async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === '/health') {
          return new Response(JSON.stringify({ terminalServiceReady: true, prewarmReady: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error('Network connection lost.');
      });

      const request = new Request(`http://localhost/api/terminal/${sessionId}-1/ws`, {
        headers: { 'Upgrade': 'websocket', 'Origin': 'http://localhost' },
      });
      const env = { KV: mockKV as unknown as KVNamespace, CONTAINER: {} } as unknown as Env;
      const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
      const routeResult = validateWebSocketRoute(request);

      const result = await handleWebSocketUpgrade(request, env, ctx, routeResult as any);

      // Reaching the forward at all is half the contract - a 4503 short-circuit
      // would also return 101 and would pass a status-only assertion.
      expect(mockContainerFetch).toHaveBeenCalled();
      expect(result.status).toBe(101);
      expect(result.webSocket).toBeDefined();

      // The close CODE is the contract, not merely that a socket came back: 1013
      // is in the client's retryable set and drives its backoff, while 4503 would
      // strand a user whose container is only transiently unreachable and 1000
      // would end the session silently. Asserting only 101 cannot tell those apart.
      const ws = result.webSocket!;
      const closeCode = new Promise<number>((resolve) => {
        ws.addEventListener('close', (event) => resolve((event as unknown as { code: number }).code));
      });
      ws.accept();
      expect(await closeCode).toBe(1013);
    });
  });

  describe('CF-015 / REQ-SESSION-018 AC7: Container state owns terminal admission', () => {
    const requestFor = (sessionId: string) => new Request(`http://localhost/api/terminal/${sessionId}-1/ws`, {
      headers: { 'Upgrade': 'websocket', 'Origin': 'http://localhost' },
    });

    const readCloseCode = async (response: Response): Promise<number> => {
      const ws = response.webSocket!;
      const closeCode = new Promise<number>((resolve) => {
        ws.addEventListener('close', (event) => resolve((event as unknown as { code: number }).code));
      });
      ws.accept();
      return closeCode;
    };

    const expectNoRateLimitWrite = () => {
      expect(mockKV.put.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      )).toHaveLength(0);
    };

    it('forwards stale-KV stopped when persisted Container state is healthy', async () => {
      const sessionId = 'abcdef1234567890';
      mockKV._set(`session:test-bucket:${sessionId}`, {
        id: sessionId,
        name: 'Test',
        userId: 'test-bucket',
        createdAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: '2026-01-01T00:00:00Z',
        status: 'stopped',
      });
      mockContainerGetState.mockResolvedValue({ status: 'healthy', lastChange: Date.now() });
      mockContainerFetch.mockImplementation(async (req: Request) => {
        if (new URL(req.url).pathname === '/health') {
          return new Response(JSON.stringify({ terminalServiceReady: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('ws upgrade', { status: 200 });
      });
      const request = requestFor(sessionId);
      const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

      const result = await handleWebSocketUpgrade(
        request,
        { KV: mockKV as unknown as KVNamespace, CONTAINER: {} } as unknown as Env,
        ctx,
        validateWebSocketRoute(request) as any,
      );

      expect(result.status).toBe(200);
      expect(mockContainerFetch).toHaveBeenCalledTimes(2);
    });

    it.each(['stopped', 'stopped_with_code', 'stopping'])('returns 4503 without rate-limit use for Container state %s', async (status) => {
      const sessionId = 'abcdef1234567890';
      mockKV._set(`session:test-bucket:${sessionId}`, {
        id: sessionId,
        name: 'Test',
        userId: 'test-bucket',
        createdAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: '2026-01-01T00:00:00Z',
        status: 'running',
      });
      mockContainerGetState.mockResolvedValue({ status, lastChange: Date.now() });
      const request = requestFor(sessionId);

      const result = await handleWebSocketUpgrade(
        request,
        { KV: mockKV as unknown as KVNamespace, CONTAINER: {} } as unknown as Env,
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
        validateWebSocketRoute(request) as any,
      );

      expect(await readCloseCode(result)).toBe(4503);
      expect(mockContainerFetch).not.toHaveBeenCalled();
      expectNoRateLimitWrite();
    });

    it.each(['running', 'healthy'])('returns retryable 1013 without rate-limit use when %s state fails health', async (status) => {
      const sessionId = 'abcdef1234567890';
      mockKV._set(`session:test-bucket:${sessionId}`, {
        id: sessionId,
        name: 'Test',
        userId: 'test-bucket',
        createdAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: '2026-01-01T00:00:00Z',
        status: 'running',
      });
      mockContainerGetState.mockResolvedValue({ status, lastChange: Date.now() });
      mockContainerFetch.mockRejectedValue(new Error('Network connection lost.'));
      const request = requestFor(sessionId);

      const result = await handleWebSocketUpgrade(
        request,
        { KV: mockKV as unknown as KVNamespace, CONTAINER: {} } as unknown as Env,
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
        validateWebSocketRoute(request) as any,
      );

      expect(await readCloseCode(result)).toBe(1013);
      expectNoRateLimitWrite();
    });

    it('returns retryable 1013 without rate-limit use when Container state is unavailable', async () => {
      const sessionId = 'abcdef1234567890';
      mockKV._set(`session:test-bucket:${sessionId}`, {
        id: sessionId,
        name: 'Test',
        userId: 'test-bucket',
        createdAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: '2026-01-01T00:00:00Z',
        status: 'running',
      });
      mockContainerGetState.mockRejectedValue(new Error('state unavailable'));
      const request = requestFor(sessionId);

      const result = await handleWebSocketUpgrade(
        request,
        { KV: mockKV as unknown as KVNamespace, CONTAINER: {} } as unknown as Env,
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
        validateWebSocketRoute(request) as any,
      );

      expect(await readCloseCode(result)).toBe(1013);
      expect(mockContainerFetch).not.toHaveBeenCalled();
      expectNoRateLimitWrite();
    });
  });

  describe('container-warming-up gate (PR #365) / REQ-SEC-020 AC2 (1013 close BEFORE WS rate-limit while readiness is unverified)', () => {
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

    it('fast-fails with a 101 close (not an indefinite hang) when the container WS forward never answers', async () => {
      // A dead/unreachable container passes the /health gate (or fails it open) but
      // then never answers the actual WS upgrade. Without the forward timeout the
      // worker awaited container.fetch for ~34s in prod and the browser dropped the
      // socket ("closed before the connection is established"). The forward must now
      // race CONTAINER_WS_FORWARD_TIMEOUT_MS and return a retryable close.
      // Oracle: gut the timeout and this test hangs forever on the never-resolving
      // forward instead of resolving to the 101 close.
      vi.useFakeTimers();
      try {
        mockContainerFetch.mockImplementation(async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === '/health') {
            return new Response(JSON.stringify({ terminalServiceReady: true, prewarmReady: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          // /terminal WS forward hangs (container is up per CF but unreachable).
          return new Promise<Response>(() => {});
        });

        const request = createRequest();
        const routeResult = validateWebSocketRoute(request);
        const pending = handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);

        await vi.advanceTimersByTimeAsync(CONTAINER_WS_FORWARD_TIMEOUT_MS + 50);
        const response = await pending;

        // The synthetic fast-fail close is a 101 upgrade, distinct from the mock's
        // normal 200 forward — i.e. the timeout path produced the response.
        expect(response.status).toBe(101);
        // The forward was actually attempted against the container's /terminal path.
        const forwardedTerminal = mockContainerFetch.mock.calls.some(
          (call) => new URL((call[0] as Request).url).pathname === '/terminal'
        );
        expect(forwardedTerminal).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns retryable 1013 without forwarding or rate-limit use when /health fails', async () => {
      mockContainerFetch.mockImplementation(async (req: Request) => {
        if (new URL(req.url).pathname === '/health') throw new Error('container unreachable');
        return new Response('ws upgrade', { status: 200 });
      });

      const request = createRequest();
      const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, validateWebSocketRoute(request));
      const ws = response.webSocket!;
      const closeCode = new Promise<number>((resolve) => {
        ws.addEventListener('close', (event) => resolve((event as unknown as { code: number }).code));
      });
      ws.accept();

      expect(await closeCode).toBe(1013);
      expect(mockContainerFetch.mock.calls.some(
        (call) => new URL((call[0] as Request).url).pathname === '/terminal'
      )).toBe(false);
      expect(mockKV.put.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].startsWith('ws-connect:')
      )).toHaveLength(0);
    });
  });
});
