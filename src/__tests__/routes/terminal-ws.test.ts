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
  containerSessionsCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
}));

// Workers runtime doesn't allow constructing responses with status 101;
// use 200 as a stand-in for a successful container forward.
const mockContainerFetch = vi.fn().mockResolvedValue(new Response('ws upgrade', { status: 200 }));

vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({
    fetch: mockContainerFetch,
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
      DEV_MODE: 'false',
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
    const routeResult = validateWebSocketRoute(request, mockEnv);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    // The mocked container returns 200 (101 can't be constructed in Workers runtime)
    expect(response.status).toBe(200);
  });

  it('returns 401 when authentication fails with AuthError', async () => {
    const { AuthError } = await import('../../lib/error-types');
    mockAuthResult.error = new AuthError('Unauthorized');

    const request = createRequest();
    const routeResult = validateWebSocketRoute(request, mockEnv);

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
    const routeResult = validateWebSocketRoute(request, mockEnv);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.status).toBe(403);
  });

  it('returns 404 when session does not exist in KV', async () => {
    mockKV._clear();

    const request = createRequest();
    const routeResult = validateWebSocketRoute(request, mockEnv);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.status).toBe(404);

    const body = await response.json() as { error: string; code: string };
    expect(body.error).toBe('Session not found');
    expect(body.code).toBe('SESSION_NOT_FOUND');
  });

  it('includes X-Request-ID header in responses', async () => {
    mockKV._clear();

    const request = createRequest();
    const routeResult = validateWebSocketRoute(request, mockEnv);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.headers.get('X-Request-ID')).toBeTruthy();
  });

  it('uses client-provided X-Request-ID when valid', async () => {
    mockKV._clear();

    const request = createRequest({ 'X-Request-ID': 'my-req-id' });
    const routeResult = validateWebSocketRoute(request, mockEnv);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.headers.get('X-Request-ID')).toBe('my-req-id');
  });

  it('returns 403 when Origin is not allowed', async () => {
    const { isAllowedOrigin } = await import('../../lib/cors-cache');
    vi.mocked(isAllowedOrigin).mockResolvedValueOnce(false);

    const request = createRequest({ Origin: 'https://evil.example.com' });
    const routeResult = validateWebSocketRoute(request, mockEnv);

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
    const routeResult = validateWebSocketRoute(request, mockEnv);

    const response = await handleWebSocketUpgrade(request, mockEnv, mockCtx, routeResult);
    expect(response.status).toBe(403);
  });
});
