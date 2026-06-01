import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleVaultRequest, validateVaultRoute, VAULT_NATIVE_SERVICE_WORKER_JS } from '../../routes/vault';
import type { Env, Session } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

/**
 * Integration coverage for the vault auth chain (CF-002).
 *
 * handleVaultRequest threads requests through:
 *   authenticateRequest -> origin allowlist -> tier check -> session
 *   ownership -> container health -> rate limit -> container.fetch.
 *
 * The unit suite in vault.test.ts pins each pure helper; this suite
 * drives the full chain so a regression in the ORDER or the branch
 * outcomes of those guards (especially the session-ownership KV-miss
 * branch) cannot ship green. The session-ownership test is the binding
 * anchor: a KV miss under the authenticated bucket MUST return 404, and
 * an inactive tier MUST return 403 BEFORE the session is even looked up.
 *
 * Mock strategy mirrors terminal-ws.test.ts: stub the I/O boundaries
 * (authenticateRequest, isAllowedOrigin, getContainer, container health)
 * but run the real guard ordering inside handleVaultRequest.
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

const mockEnsureVaultKey = vi.fn().mockResolvedValue('AAAA-base64-key-AAAA');
const mockContainerFetch = vi.fn().mockResolvedValue(
  new Response('proxied', { status: 200, headers: { 'content-type': 'text/markdown' } }),
);

vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({
    fetch: mockContainerFetch,
    ensureVaultKey: mockEnsureVaultKey,
  })),
}));

// safeCheckContainerHealth gates the proxy on a "running + reachable"
// container. Default it to healthy so the auth-chain branches under test
// are reached; individual tests flip it for the container-not-ready case.
const mockHealth = vi.hoisted(() => ({ healthy: true }));
vi.mock('../../lib/container-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/container-helpers')>();
  return {
    ...actual,
    safeCheckContainerHealth: vi.fn(async () => mockHealth),
  };
});

describe('handleVaultRequest auth chain (CF-002)', () => {
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
    mockEnsureVaultKey.mockResolvedValue('AAAA-base64-key-AAAA');
    mockContainerFetch.mockResolvedValue(
      new Response('proxied', { status: 200, headers: { 'content-type': 'text/markdown' } }),
    );

    mockEnv = {
      KV: mockKV as unknown as KVNamespace,
      CONTAINER: {} as DurableObjectNamespace,
    } as unknown as Env;

    mockCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const session: Session = {
      id: SID,
      name: 'Test Session',
      userId: 'test-bucket',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastAccessedAt: '2026-01-01T00:00:00.000Z',
    };
    mockKV._set(SESSION_KEY, session);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function vaultRequest(path = `/api/vault/${SID}/notes/foo.md`, headers: Record<string, string> = {}): Request {
    return new Request(`https://codeflare.ch${path}`, {
      headers: new Headers({ Origin: 'https://codeflare.ch', ...headers }),
    });
  }

  function route(request: Request) {
    return validateVaultRoute(request);
  }

  it('forwards to the container when the full auth chain passes', async () => {
    const request = vaultRequest();
    const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(200);
    expect(mockContainerFetch).toHaveBeenCalledTimes(1);
  });

  it('returns 401 when authenticateRequest throws AuthError', async () => {
    const { AuthError } = await import('../../lib/error-types');
    mockAuthResult.error = new AuthError('Unauthorized');

    const request = vaultRequest();
    const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(401);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('AUTH_FAILED');
    expect(mockContainerFetch).not.toHaveBeenCalled();
  });

  it('returns 403 when authenticateRequest throws ForbiddenError', async () => {
    const { ForbiddenError } = await import('../../lib/error-types');
    mockAuthResult.error = new ForbiddenError('Forbidden');

    const request = vaultRequest();
    const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(403);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('returns 403 ORIGIN_NOT_ALLOWED when the origin allowlist rejects', async () => {
    const { isAllowedOrigin } = await import('../../lib/cors-cache');
    vi.mocked(isAllowedOrigin).mockResolvedValueOnce(false);

    const request = vaultRequest(`/api/vault/${SID}/notes/foo.md`, { Origin: 'https://evil.example.com' });
    const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(403);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('ORIGIN_NOT_ALLOWED');
    // Origin rejection short-circuits before authentication.
    const { authenticateRequest } = await import('../../lib/access');
    expect(authenticateRequest).not.toHaveBeenCalled();
  });

  describe('SaaS tier gating (runs BEFORE session ownership)', () => {
    it('returns 403 PENDING when SAAS_MODE=active and tier is pending', async () => {
      (mockEnv as unknown as { SAAS_MODE: string }).SAAS_MODE = 'active';
      mockAuthResult.result = {
        user: { email: 'test@example.com', authenticated: true, accessTier: 'pending', subscriptionTier: 'pending' },
        bucketName: 'test-bucket',
      };

      const request = vaultRequest();
      const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
      expect(response.status).toBe(403);
      const body = await response.json() as { code: string };
      expect(body.code).toBe('PENDING');
      // Tier rejection must precede the session-ownership KV read.
      expect(mockKV.get).not.toHaveBeenCalledWith(SESSION_KEY, 'json');
    });

    it('returns 403 BLOCKED when SAAS_MODE=active and tier is blocked', async () => {
      (mockEnv as unknown as { SAAS_MODE: string }).SAAS_MODE = 'active';
      mockAuthResult.result = {
        user: { email: 'test@example.com', authenticated: true, accessTier: 'blocked', subscriptionTier: 'blocked' },
        bucketName: 'test-bucket',
      };

      const request = vaultRequest();
      const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
      expect(response.status).toBe(403);
      const body = await response.json() as { code: string };
      expect(body.code).toBe('BLOCKED');
    });

    it('proceeds when SAAS_MODE=active and tier is active', async () => {
      (mockEnv as unknown as { SAAS_MODE: string }).SAAS_MODE = 'active';
      mockAuthResult.result = {
        user: { email: 'test@example.com', authenticated: true, accessTier: 'standard', subscriptionTier: 'standard' },
        bucketName: 'test-bucket',
      };

      const request = vaultRequest();
      const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
      expect(response.status).toBe(200);
    });
  });

  describe('session ownership (binding anchor)', () => {
    it('returns 404 SESSION_NOT_FOUND when getSessionKey misses for the authenticated bucket', async () => {
      mockKV._clear();

      const request = vaultRequest();
      const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
      expect(response.status).toBe(404);
      const body = await response.json() as { code: string };
      expect(body.code).toBe('SESSION_NOT_FOUND');
      // Ownership failure short-circuits before any container fetch.
      expect(mockContainerFetch).not.toHaveBeenCalled();
    });

    it('returns 404 when the session exists only under a DIFFERENT bucket (cross-tenant isolation)', async () => {
      // Session is owned by another bucket; the authenticated user
      // (bucket test-bucket) must not reach it.
      mockKV._clear();
      mockKV._set(`session:other-bucket:${SID}`, {
        id: SID, name: 'Other', userId: 'other-bucket',
        createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z',
      });

      const request = vaultRequest();
      const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
      expect(response.status).toBe(404);
      const body = await response.json() as { code: string };
      expect(body.code).toBe('SESSION_NOT_FOUND');
      expect(mockContainerFetch).not.toHaveBeenCalled();
    });

    it('returns 503 CONTAINER_STOPPED when the owned session is stopped', async () => {
      mockKV._set(SESSION_KEY, {
        id: SID, name: 'Test', userId: 'test-bucket',
        createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z',
        status: 'stopped',
      });

      const request = vaultRequest();
      const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
      expect(response.status).toBe(503);
      const body = await response.json() as { code: string };
      expect(body.code).toBe('CONTAINER_STOPPED');
      expect(mockContainerFetch).not.toHaveBeenCalled();
    });
  });

  it('returns 503 CONTAINER_NOT_READY when the health probe is unhealthy', async () => {
    mockHealth.healthy = false;

    const request = vaultRequest();
    const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
    expect(response.status).toBe(503);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('CONTAINER_NOT_READY');
  });

  describe('native SW + shell-302 suppression (REQ-VAULT-013 AC5/AC8, AD69)', () => {
    it('T4: serves the native SW pre-auth for the registration fetch, container untouched', async () => {
      // service_worker.js + `service-worker: script` short-circuits BEFORE the
      // auth chain (the browser strips cookies on SW registration fetches), so
      // it must never reach the container - and the body is the native worker.
      const request = vaultRequest(`/api/vault/${SID}/service_worker.js`, { 'service-worker': 'script' });
      const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(VAULT_NATIVE_SERVICE_WORKER_JS);
      expect(mockContainerFetch).not.toHaveBeenCalled();
    });

    it('T5: shell `/` navigation redirects to the hop, but the SW precache fetch passes through', async () => {
      // A top-level navigation with no bootstrap cookie must 302 to the hop so
      // the encryption key is wired before SB boots; the container is untouched.
      const nav = vaultRequest(`/api/vault/${SID}/`, { 'Sec-Fetch-Mode': 'navigate' });
      const navRes = await handleVaultRequest(nav, mockEnv, mockCtx, route(nav));
      expect(navRes.status).toBe(302);
      expect(navRes.headers.get('Location')).toBe(`/api/vault/${SID}/.codeflare-bootstrap`);
      expect(mockContainerFetch).not.toHaveBeenCalled();

      // The native SW's cache.addAll precache of `/` is SW-context
      // (Sec-Fetch-Mode != navigate). It must NOT 302 - otherwise the SW
      // install rejects atomically and hangs - so it reaches the container.
      const precache = vaultRequest(`/api/vault/${SID}/`, { 'Sec-Fetch-Mode': 'no-cors' });
      const preRes = await handleVaultRequest(precache, mockEnv, mockCtx, route(precache));
      expect(preRes.status).toBe(200);
      expect(mockContainerFetch).toHaveBeenCalledTimes(1);

      // No Sec-Fetch-Mode at all => fail-safe back to the 302 (a navigation we
      // cannot positively identify must still get the hop, never the raw shell).
      const headerless = vaultRequest(`/api/vault/${SID}/`);
      const hlRes = await handleVaultRequest(headerless, mockEnv, mockCtx, route(headerless));
      expect(hlRes.status).toBe(302);
    });

    it('T8: /.config injection still wires client encryption (regression)', async () => {
      // Swapping the served worker must not disturb the BootConfig key
      // injection - SB reads vaultEncryptionKey + enableClientEncryption from
      // here to wrap the IDB. The hop cookie lets the request reach the proxy.
      mockContainerFetch.mockResolvedValueOnce(
        new Response('{"spaceFolderPath":"/"}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      const request = vaultRequest(`/api/vault/${SID}/.config`, { Cookie: 'codeflare_vault_bootstrap=1' });
      const response = await handleVaultRequest(request, mockEnv, mockCtx, route(request));
      expect(response.status).toBe(200);
      const body = await response.json() as { vaultEncryptionKey?: string; enableClientEncryption?: boolean };
      expect(body.enableClientEncryption).toBe(true);
      expect(body.vaultEncryptionKey).toBe('AAAA-base64-key-AAAA');
    });
  });
});
