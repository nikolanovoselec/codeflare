import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, Session } from '../../../types';
import type { AuthVariables } from '../../../middleware/auth';
import { createMockKV } from '../../helpers/mock-kv';

// ---- Hoisted mocks ----

const mockGetOrCreateScopedR2Token = vi.hoisted(() => vi.fn());
const mockCreateBucketIfNotExists = vi.hoisted(() => vi.fn());
const mockSeedGettingStartedDocs = vi.hoisted(() => vi.fn());
const mockGetR2Config = vi.hoisted(() => vi.fn());
const mockGetContainer = vi.hoisted(() => vi.fn());
const mockGetStoredBucketName = vi.hoisted(() => vi.fn());

// Mock auth middleware
vi.mock('../../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { email: 'test@example.com', authenticated: true, role: 'admin' });
    c.set('bucketName', 'codeflare-test-example-com');
    return next();
  }),
}));

// Mock r2-admin
vi.mock('../../../lib/r2-admin', () => ({
  createBucketIfNotExists: mockCreateBucketIfNotExists,
  getOrCreateScopedR2Token: mockGetOrCreateScopedR2Token,
}));

// Mock r2-seed
vi.mock('../../../lib/r2-seed', () => ({
  seedGettingStartedDocs: mockSeedGettingStartedDocs,
}));

// Mock r2-config
vi.mock('../../../lib/r2-config', () => ({
  getR2Config: mockGetR2Config,
}));

// Mock @cloudflare/containers
vi.mock('@cloudflare/containers', () => ({
  getContainer: mockGetContainer,
}));

// Mock container/shared
vi.mock('../../../routes/container/shared', () => ({
  containerLogger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
  getStoredBucketName: mockGetStoredBucketName,
}));

// Mock circuit breakers
const passThroughCB = { execute: vi.fn((fn: () => Promise<any>) => fn()) };
vi.mock('../../../lib/circuit-breakers', () => ({
  r2AdminCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
  getContainerHealthCB: () => passThroughCB,
  getContainerInternalCB: () => passThroughCB,
  getContainerSessionsCB: () => passThroughCB,
}));

// Mock logger
vi.mock('../../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  })),
}));

// Mock rate limiter to pass through
vi.mock('../../../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: any, next: any) => next()),
}));

// Mock agent-config
vi.mock('../../../lib/agent-config', () => ({
  getDefaultTabConfig: vi.fn(() => [{ command: 'claude-code', label: 'Claude' }]),
}));

// Mock kv-keys
vi.mock('../../../lib/kv-keys', () => ({
  getSessionKey: vi.fn((bucket: string, sessionId: string) => `session:${bucket}:${sessionId}`),
  getPreferencesKey: vi.fn((bucket: string) => `preferences:${bucket}`),
  getLlmKeysKey: vi.fn((bucket: string) => `llm-keys:${bucket}`),
  getDeployKeysKey: vi.fn((bucket: string) => `deploy-keys:${bucket}`),
  listAllKvKeys: vi.fn(async () => []),
  getSessionPrefix: vi.fn((bucket: string) => `session:${bucket}:`),
}));

// Mock container-helpers
vi.mock('../../../lib/container-helpers', () => ({
  getContainerContext: vi.fn(),
  getSessionIdFromQuery: vi.fn((c: any) => c.req.query('sessionId')),
  getContainerId: vi.fn((bucket: string, sessionId: string) => `${bucket}-${sessionId}`),
}));

import lifecycleRoutes from '../../../routes/container/lifecycle';
import { AppError } from '../../../lib/error-types';

describe('Container Lifecycle - Scoped R2 Tokens', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  const mockContainerStub = {
    fetch: vi.fn(),
    getState: vi.fn(),
    startAndWaitForPorts: vi.fn(),
    destroy: vi.fn(),
  };

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();

    // Default happy path mocks
    mockGetR2Config.mockResolvedValue({
      accountId: 'test-account-id',
      endpoint: 'https://test.r2.cloudflarestorage.com',
    });
    mockCreateBucketIfNotExists.mockResolvedValue({ success: true, created: false });
    mockSeedGettingStartedDocs.mockResolvedValue({ written: [], skipped: [] });
    mockGetContainer.mockReturnValue(mockContainerStub);
    mockGetStoredBucketName.mockResolvedValue(null);
    mockContainerStub.fetch.mockResolvedValue(new Response('{}', { status: 200 }));
    mockContainerStub.getState.mockResolvedValue({ status: 'stopped' });
    mockContainerStub.startAndWaitForPorts.mockResolvedValue(undefined);
  });

  const mockExecutionCtx = {
    waitUntil: vi.fn((p: Promise<any>) => p.catch(() => {})),
    passThroughOnException: vi.fn(),
  };

  function createTestApp() {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        CLOUDFLARE_API_TOKEN: 'test-api-token',
        R2_ACCESS_KEY_ID: 'account-level-ak',
        R2_SECRET_ACCESS_KEY: 'account-level-sk',
        CONTAINER: {} as any,
      } as unknown as Env;
      c.set('user' as any, { email: 'test@example.com', authenticated: true, role: 'admin' });
      c.set('bucketName' as any, 'codeflare-test-example-com');
      c.set('requestId' as any, 'test-req-id');
      return next();
    });

    app.route('/container', lifecycleRoutes);

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as any);
      }
      return c.json({ error: err.message }, 500);
    });

    // Return a fetch helper that passes ExecutionContext (required for waitUntil)
    return {
      request: (path: string, init?: RequestInit) => {
        const req = new Request(`http://localhost${path}`, init);
        return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
      },
    };
  }

  it('setupR2Credentials returns scoped credentials for bucket (L15)', async () => {
    const app = createTestApp();

    const sessionKey = 'session:codeflare-test-example-com:test-session';
    mockKV._set(sessionKey, {
      id: 'test-session',
      name: 'Test',
      status: 'stopped',
      createdAt: '2024-01-01T00:00:00Z',
    } satisfies Partial<Session>);

    mockGetOrCreateScopedR2Token.mockResolvedValue({
      accessKeyId: 'scoped-ak-123',
      secretAccessKey: 'scoped-sk-456',
      tokenId: 'scoped-tok-789',
    });

    const res = await app.request('/container/start?sessionId=test-session', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    // Verify the scoped creds flow through to the setBucketName call
    const fetchCalls = mockContainerStub.fetch.mock.calls;
    const setBucketNameCall = fetchCalls.find((call: any[]) => {
      const req = call[0] as Request;
      return req.url.includes('setBucketName');
    });
    expect(setBucketNameCall).toBeDefined();
    const reqBody = await new Request(setBucketNameCall![0]).clone().json() as Record<string, unknown>;
    expect(reqBody.r2AccessKeyId).toBe('scoped-ak-123');
    expect(reqBody.r2SecretAccessKey).toBe('scoped-sk-456');
  });

  it('should call getOrCreateScopedR2Token to get scoped creds during container start', async () => {
    const app = createTestApp();

    // Pre-populate session in KV
    const sessionKey = 'session:codeflare-test-example-com:test-session';
    mockKV._set(sessionKey, {
      id: 'test-session',
      name: 'Test',
      status: 'stopped',
      createdAt: '2024-01-01T00:00:00Z',
    } satisfies Partial<Session>);

    mockGetOrCreateScopedR2Token.mockResolvedValue({
      accessKeyId: 'scoped-ak',
      secretAccessKey: 'scoped-sk',
      tokenId: 'scoped-tok',
    });

    const res = await app.request('/container/start?sessionId=test-session', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(mockGetOrCreateScopedR2Token).toHaveBeenCalledWith(
      'test@example.com',
      'test-account-id',
      'test-api-token',
      'codeflare-test-example-com',
      expect.anything(), // KV namespace
      null, // cryptoKey (no ENCRYPTION_KEY set)
    );
  });

  it('should pass scoped creds (not account-level creds) to setBucketName', async () => {
    const app = createTestApp();

    const sessionKey = 'session:codeflare-test-example-com:test-session';
    mockKV._set(sessionKey, {
      id: 'test-session',
      name: 'Test',
      status: 'stopped',
      createdAt: '2024-01-01T00:00:00Z',
    } satisfies Partial<Session>);

    mockGetOrCreateScopedR2Token.mockResolvedValue({
      accessKeyId: 'scoped-ak',
      secretAccessKey: 'scoped-sk',
      tokenId: 'scoped-tok',
    });

    await app.request('/container/start?sessionId=test-session', {
      method: 'POST',
    });

    // Verify the setBucketName fetch was called with scoped creds, NOT account-level
    const fetchCalls = mockContainerStub.fetch.mock.calls;
    const setBucketNameCall = fetchCalls.find((call: any[]) => {
      const req = call[0] as Request;
      return req.url.includes('setBucketName');
    });

    expect(setBucketNameCall).toBeDefined();
    const reqBody = await new Request(setBucketNameCall![0]).clone().json() as Record<string, unknown>;
    expect(reqBody.r2AccessKeyId).toBe('scoped-ak');
    expect(reqBody.r2SecretAccessKey).toBe('scoped-sk');
    // Should NOT be account-level creds
    expect(reqBody.r2AccessKeyId).not.toBe('account-level-ak');
    expect(reqBody.r2SecretAccessKey).not.toBe('account-level-sk');
  });

  it('should throw ContainerError("r2_credentials") if scoped token creation fails', async () => {
    const app = createTestApp();

    const sessionKey = 'session:codeflare-test-example-com:test-session';
    mockKV._set(sessionKey, {
      id: 'test-session',
      name: 'Test',
      status: 'stopped',
      createdAt: '2024-01-01T00:00:00Z',
    } satisfies Partial<Session>);

    mockGetOrCreateScopedR2Token.mockRejectedValue(
      new Error('Failed to create scoped R2 token for bucket codeflare-test-example-com')
    );

    const res = await app.request('/container/start?sessionId=test-session', {
      method: 'POST',
    });

    expect(res.status).toBe(500);
    const body = await res.json() as { code: string; error: string };
    expect(body.code).toBe('CONTAINER_ERROR');
    expect(body.error).toMatch(/Container operation failed/);
  });

  it('should NOT fall back to account-level creds on scoped token failure', async () => {
    const app = createTestApp();

    const sessionKey = 'session:codeflare-test-example-com:test-session';
    mockKV._set(sessionKey, {
      id: 'test-session',
      name: 'Test',
      status: 'stopped',
      createdAt: '2024-01-01T00:00:00Z',
    } satisfies Partial<Session>);

    mockGetOrCreateScopedR2Token.mockRejectedValue(
      new Error('Token creation failed')
    );

    const res = await app.request('/container/start?sessionId=test-session', {
      method: 'POST',
    });

    // Request should have failed - no container.fetch with account-level creds
    expect(res.status).toBe(500);

    // Verify setBucketName was NOT called (no fallback)
    const setBucketNameCalls = mockContainerStub.fetch.mock.calls.filter((call: any[]) => {
      const req = call[0] as Request;
      return req.url.includes('setBucketName');
    });
    expect(setBucketNameCalls).toHaveLength(0);
  });

  // --- KV encryption pipeline tests ---

  /** Helper: start a session and return the setBucketName body */
  async function startSessionAndGetBody(
    envOverrides?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const sessionKey = 'session:codeflare-test-example-com:test-session';
    mockKV._set(sessionKey, {
      id: 'test-session',
      name: 'Test',
      status: 'stopped',
      createdAt: '2024-01-01T00:00:00Z',
    } satisfies Partial<Session>);

    mockGetOrCreateScopedR2Token.mockResolvedValue({
      accessKeyId: 'scoped-ak',
      secretAccessKey: 'scoped-sk',
      tokenId: 'scoped-tok',
    });

    // Build test app with optional env overrides
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        CLOUDFLARE_API_TOKEN: 'test-api-token',
        R2_ACCESS_KEY_ID: 'account-level-ak',
        R2_SECRET_ACCESS_KEY: 'account-level-sk',
        CONTAINER: {} as any,
        ...envOverrides,
      } as unknown as Env;
      c.set('user' as any, { email: 'test@example.com', authenticated: true, role: 'admin' });
      c.set('bucketName' as any, 'codeflare-test-example-com');
      c.set('requestId' as any, 'test-req-id');
      return next();
    });
    app.route('/container', lifecycleRoutes);
    app.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as any);
      return c.json({ error: err.message }, 500);
    });

    const res = await app.fetch(
      new Request('http://localhost/container/start?sessionId=test-session', { method: 'POST' }),
      {} as Env,
      mockExecutionCtx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);

    const fetchCalls = mockContainerStub.fetch.mock.calls;
    const call = fetchCalls.find((c: any[]) => (c[0] as Request).url.includes('setBucketName'));
    expect(call).toBeDefined();
    return new Request(call![0]).clone().json() as Promise<Record<string, unknown>>;
  }

  it('ENCRYPTION_KEY flows through as encryptionKey', async () => {
    // Must be exactly 32 bytes base64-encoded (AES-256 requirement)
    const testKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(0x42)));
    const body = await startSessionAndGetBody({ ENCRYPTION_KEY: testKey });
    expect(body.encryptionKey).toBe(testKey);
  });

  it('encryptionKey absent when ENCRYPTION_KEY not set', async () => {
    const body = await startSessionAndGetBody();
    expect(body.encryptionKey).toBeUndefined();
  });
});
