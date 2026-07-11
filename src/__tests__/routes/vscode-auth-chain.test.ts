import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleVscodeRequest, validateVscodeRoute } from '../../routes/vscode';
import type { Env, Session } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

/**
 * Integration coverage for the browser-IDE auth chain + path forwarding.
 *
 * handleVscodeRequest threads requests through the same session-safe guards
 * the vault reuses (authenticate -> origin -> tier -> session ownership ->
 * container health -> WS rate limit -> container.fetch), then forwards the
 * path UNCHANGED to the base-path-native OpenVSCode server. This suite drives
 * the full chain so a regression in the guard ORDER, the branch outcomes, or
 * the forward-unchanged contract cannot ship green.
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

describe('handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let mockEnv: Env;
  let mockCtx: ExecutionContext;

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
    mockContainerFetch.mockResolvedValue(new Response('ide', { status: 200 }));

    mockEnv = {
      KV: mockKV as unknown as KVNamespace,
      CONTAINER: {} as DurableObjectNamespace,
    } as unknown as Env;

    mockCtx = {
      waitUntil: vi.fn(),
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

  it('REQ-IDE-001: forwards to the container with the path UNCHANGED when the auth chain passes', async () => {
    const request = vscodeRequest();
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(200);
    expect(mockContainerFetch).toHaveBeenCalledTimes(1);
    // base-path-native: the forwarded request keeps the full /api/vscode/<sid>/...
    // path (NOT rewritten to /vscode/... the way the vault rewrites to /vault).
    const forwarded = mockContainerFetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).pathname).toBe(`/api/vscode/${SID}/stable/out/main.js`);
  });

  it('REQ-IDE-001: returns 401 AUTH_FAILED when authenticateRequest throws AuthError', async () => {
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

  it('REQ-IDE-001: returns 404 SESSION_NOT_FOUND when the user does not own the session', async () => {
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

  it('REQ-IDE-001: returns 503 CONTAINER_NOT_READY when the health probe is unhealthy', async () => {
    mockHealth.healthy = false;
    const request = vscodeRequest();
    const response = await handleVscodeRequest(request, mockEnv, mockCtx, route(request));
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
});
