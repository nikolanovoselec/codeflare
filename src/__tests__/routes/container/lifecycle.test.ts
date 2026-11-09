import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, Session } from '../../../types';
import type { AuthVariables } from '../../../middleware/auth';
import { createMockKV } from '../../helpers/mock-kv';
import { createMockSessionD1 } from '../../helpers/mock-session-d1';

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
vi.mock('../../../lib/kv-keys', async () => ({
  // Spread the real module so non-overridden exports (notably SETUP_KEYS, which
  // r2-migration reads via the /start ensureBucketAndSeed path) resolve — mirrors
  // the container-lifecycle-helpers test. Only KV-interaction helpers are overridden.
  ...(await vi.importActual<typeof import('../../../lib/kv-keys')>('../../../lib/kv-keys')),
  getPreferencesKey: vi.fn((bucket: string) => `user-prefs:${bucket}`),
  getLlmKeysKey: vi.fn((bucket: string) => `llm-keys:${bucket}`),
  getDeployKeysKey: vi.fn((bucket: string) => `deploy-keys:${bucket}`),
  listAllKvKeys: vi.fn(async () => []),
}));

// Mock container-helpers
vi.mock('../../../lib/container-helpers', () => ({
  getContainerContext: vi.fn(),
  getSessionIdFromQuery: vi.fn((c: any) => c.req.query('sessionId')),
  getContainerId: vi.fn((bucket: string, sessionId: string) => `${bucket}-${sessionId}`),
}));

import lifecycleRoutes, { startOrRestartContainer } from '../../../routes/container/lifecycle';
import { AppError } from '../../../lib/error-types';
import { containerLogger } from '../../../routes/container/shared';

// Use the production serializer: JSON.stringify(Error) would hide message/stack leaks.
async function withLifecycleLogs(work: (
  logger: import('../../../lib/logger').Logger,
  entries: Array<{ message: string; data?: Record<string, unknown> }>,
) => Promise<void>) {
  const actual = await vi.importActual<typeof import('../../../lib/logger')>('../../../lib/logger');
  const entries: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const capture = (line: unknown) => { entries.push(JSON.parse(String(line))); };
  const spies = [vi.spyOn(console, 'log').mockImplementation(capture),
    vi.spyOn(console, 'warn').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture)];
  actual.setLogLevel('info');
  try { await work(actual.createLogger('lifecycle-contract'), entries); }
  finally { actual.setLogLevel('silent'); for (const spy of spies) spy.mockRestore(); }
}

const privateLifecyclePayload = 'Bearer PRIVATE_ROUTE_CANARY /private/route-path transcript:PRIVATE_ROUTE_TEXT';
function expectLifecyclePrivacy(entries: unknown[]) {
  for (const value of ['PRIVATE_ROUTE_CANARY', '/private/route-path', 'PRIVATE_ROUTE_TEXT']) {
    expect(JSON.stringify(entries)).not.toContain(value);
  }
}

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

  function createTestApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
      USAGE_DB: createMockSessionD1(mockKV),
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

  it('REQ-SESSION-025 AC4: Start stage and outer catch preserve failure response without private logs', async () => {
    const failure = new Error(privateLifecyclePayload);
    const get = vi.spyOn(mockKV, 'get').mockRejectedValueOnce(failure);
    await withLifecycleLogs(async (logger, entries) => {
      const child = vi.spyOn(containerLogger, 'child').mockReturnValue(logger);
      try {
        const response = await createTestApp().request('/container/start?sessionId=test-session', { method: 'POST' });
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ code: 'CONTAINER_ERROR' });
        for (const message of ['Container start stage failed', 'Container start error']) {
          expect(entries).toContainEqual(expect.objectContaining({ message, data: expect.objectContaining({
            errorClass: 'start_failed',
          }) }));
        }
        expectLifecyclePrivacy(entries);
      } finally { child.mockRestore(); }
    });
    get.mockRestore();
  });

  it('REQ-AGENT-123 AC5: rejects starting a persisted session whose CLI is omitted from the image', async () => {
    const app = createTestApp({ CODING_AGENTS: 'claude-code,codex,pi' });
    mockKV._set('session:codeflare-test-example-com:test-session', {
      id: 'test-session',
      name: 'Old Copilot session',
      status: 'stopped',
      agentType: 'copilot',
      createdAt: '2024-01-01T00:00:00Z',
    } satisfies Partial<Session>);

    const res = await app.request('/container/start?sessionId=test-session', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mockGetOrCreateScopedR2Token).not.toHaveBeenCalled();
    expect(mockContainerStub.startAndWaitForPorts).not.toHaveBeenCalled();
  });

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
      USAGE_DB: createMockSessionD1(mockKV),
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

  it('REQ-GITHUB-015: sends an authoritative empty clone inventory', async () => {
    const body = await startSessionAndGetBody();
    expect(body.gitCloneTargets).toBe('');
  });
});

// REQ-SESSION-020 AC3: destroy() records the session stopped and persists the
// deliberate-stop marker. A restart path that destroys the container must
// therefore always go on to start it -- reporting already_running instead would
// leave nothing to clear the marker or restore 'running', so self-heal declines
// by design and the authoritative 4503 gate refuses every terminal upgrade.
describe('Container Lifecycle - restart after a bucket change', () => {
  it('REQ-SESSION-018 AC7: stale SDK stopped cannot advance an owning D1 execution to a replacement generation', async () => {
    const kv = createMockKV();
    kv._set('session:codeflare-test-example-com:sess123', {
      id: 'sess123', userId: 'codeflare-test-example-com', status: 'running', lifecycleGeneration: 2,
      createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
    });
    const container = {
      fetch: vi.fn(), destroy: vi.fn(), getState: vi.fn().mockResolvedValue({ status: 'stopped' }),
      startAndWaitForPorts: vi.fn(),
    };
    await expect(startOrRestartContainer({
      container, needsBucketUpdate: false, setBucketBody: '{}', containerId: 'container-abc',
      sessionData: { id: 'sess123', userId: 'codeflare-test-example-com', status: 'running' } as Session,
      env: { KV: kv, USAGE_DB: createMockSessionD1(kv) } as unknown as Env,
      shortContainerId: 'cont-abc',
      logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any,
      waitUntil: vi.fn(),
    })).rejects.toThrow();
    const stored = await kv.get('session:codeflare-test-example-com:sess123', 'json') as Session & { lifecycleGeneration: number };
    expect(stored.status).toBe('running');
    expect(stored.lifecycleGeneration).toBe(2);
  });

  it.each(['start', 'replacement-destroy', 'replacement-bucket'] as const)(
    'REQ-SESSION-025 AC4: %s logs no private failure and preserves lifecycle effects', async phase => {
      const kv = createMockKV();
      const key = 'session:codeflare-test-example-com:sess123';
      kv._set(key, { id: 'sess123', userId: 'codeflare-test-example-com',
        status: phase === 'start' ? 'stopped' : 'running', lifecycleGeneration: 2 });
      const failure = new Error(privateLifecyclePayload);
      const effects: string[] = [];
      const container = {
        getState: vi.fn(async () => ({ status: phase === 'start' ? 'stopped' : 'running' })),
        destroy: vi.fn(async () => { effects.push('destroy'); if (phase === 'replacement-destroy') throw failure; }),
        fetch: vi.fn(async () => { effects.push('bucket'); if (phase === 'replacement-bucket') throw failure; return new Response('{}'); }),
        startAndWaitForPorts: vi.fn(async () => { effects.push('start'); if (phase === 'start') throw failure; }),
      };
      await withLifecycleLogs(async (logger, entries) => {
        const background: Promise<void>[] = [];
        const operation = startOrRestartContainer({ container, needsBucketUpdate: phase !== 'start',
          setBucketBody: '{}', containerId: 'container-abc', shortContainerId: 'cont-abc',
          sessionData: { id: 'sess123', userId: 'codeflare-test-example-com' } as Session,
          env: { KV: kv, USAGE_DB: createMockSessionD1(kv) } as unknown as Env,
          logger, waitUntil: task => { background.push(task); },
        });
        if (phase === 'replacement-destroy') await expect(operation).rejects.toBe(failure);
        else {
          await expect(operation).resolves.toEqual({ status: 'starting' });
          await expect(Promise.all(background)).resolves.toEqual([undefined]);
        }
        const message = phase === 'start' ? 'Failed to start container'
          : phase === 'replacement-destroy' ? 'Failed to destroy container' : 'Failed to set replacement bucket';
        expect(entries).toContainEqual(expect.objectContaining({ message, data: expect.objectContaining({
          errorClass: phase === 'start' ? 'start_failed'
            : phase === 'replacement-destroy' ? 'native_destroy_failed' : 'configuration_failed',
          containerId: 'cont-abc',
        }) }));
        expectLifecyclePrivacy(entries);
        expect(await kv.get(key, 'json')).toMatchObject(phase === 'replacement-destroy'
          ? { status: 'stopping', lifecycleGeneration: 2, terminationGeneration: 2, terminationIntentId: expect.any(String) }
          : { status: 'starting', lifecycleGeneration: 3 });
        expect(effects).toEqual(phase === 'start' ? ['start']
          : phase === 'replacement-destroy' ? ['destroy'] : ['destroy', 'bucket', 'start']);
      });
    },
  );

  it('REQ-SESSION-020 AC5-AC6: starts the container and re-asserts running when the bucket forward fails after destroy', async () => {
    const waitUntil = vi.fn();
    const kv = createMockKV();
    // The running D1 generation is terminated and confirmed before replacement.
    kv._set('session:codeflare-test-example-com:sess123', {
      id: 'sess123', userId: 'codeflare-test-example-com', status: 'running', lastActiveAt: 'REFRESHED-BY-DESTROY',
    });
    const container = {
      fetch: vi.fn().mockRejectedValue(new Error('Network connection lost.')),
      destroy: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockResolvedValue({ status: 'running' }),
      startAndWaitForPorts: vi.fn().mockResolvedValue(undefined),
    };

    const result = await startOrRestartContainer({
      container,
      needsBucketUpdate: true,
      setBucketBody: JSON.stringify({ bucketName: 'codeflare-test-example-com' }),
      containerId: 'container-abc',
      sessionData: { id: 'sess123', userId: 'codeflare-test-example-com', status: 'running', lastActiveAt: 'STALE' } as unknown as Session,
      env: { KV: kv, USAGE_DB: createMockSessionD1(kv) } as unknown as Env,
      shortContainerId: 'cont-abc',
      logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any,
      waitUntil,
    });

    expect(container.destroy).toHaveBeenCalled();
    expect(result.status).toBe('starting');
    expect(waitUntil).toHaveBeenCalled();

    // The D1 claim advances the replacement lifecycle to starting without
    // reverting fields refreshed by the preceding destroy.
    const written = JSON.parse(kv.put.mock.calls.at(-1)?.[1] as string);
    expect(written.status).toBe('starting');
    // Confirmed replacement exit refreshes activity rather than spreading the
    // stale caller snapshot back over authoritative D1 state.
    expect(written.lastActiveAt).not.toBe('STALE');
    expect(Date.parse(written.lastActiveAt)).not.toBeNaN();
  });
});
