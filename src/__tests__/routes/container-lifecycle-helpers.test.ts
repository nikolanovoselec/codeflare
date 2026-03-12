import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env, Session } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockCreateBucketIfNotExists = vi.hoisted(() => vi.fn());
const mockGetOrCreateScopedR2Token = vi.hoisted(() => vi.fn());
const mockSeedGettingStartedDocs = vi.hoisted(() => vi.fn());
const mockGetR2Config = vi.hoisted(() => vi.fn());
const mockGetContainer = vi.hoisted(() => vi.fn());
const mockGetStoredBucketName = vi.hoisted(() => vi.fn());

vi.mock('@cloudflare/containers', () => ({
  getContainer: mockGetContainer,
}));

vi.mock('../../lib/r2-admin', () => ({
  createBucketIfNotExists: mockCreateBucketIfNotExists,
  getOrCreateScopedR2Token: mockGetOrCreateScopedR2Token,
}));

const mockReconcileAgentConfigs = vi.hoisted(() => vi.fn());
vi.mock('../../lib/r2-seed', () => ({
  seedGettingStartedDocs: mockSeedGettingStartedDocs,
  reconcileAgentConfigs: mockReconcileAgentConfigs,
}));

vi.mock('../../lib/r2-config', () => ({
  getR2Config: mockGetR2Config,
}));

vi.mock('../../routes/container/shared', () => ({
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

const passThroughCB = { execute: vi.fn((fn: () => Promise<any>) => fn()) };
vi.mock('../../lib/circuit-breakers', () => ({
  r2AdminCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
  getContainerHealthCB: () => passThroughCB,
  getContainerInternalCB: () => passThroughCB,
  getContainerSessionsCB: () => passThroughCB,
}));

vi.mock('../../lib/logger', () => ({
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

vi.mock('../../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../lib/agent-config', () => ({
  getDefaultTabConfig: vi.fn(() => [{ command: 'claude-code', label: 'Claude' }]),
}));

const mockListAllKvKeys = vi.hoisted(() => vi.fn());
vi.mock('../../lib/kv-keys', () => ({
  getSessionKey: vi.fn((bucket: string, sessionId: string) => `session:${bucket}:${sessionId}`),
  getPreferencesKey: vi.fn((bucket: string) => `preferences:${bucket}`),
  listAllKvKeys: mockListAllKvKeys,
  getSessionPrefix: vi.fn((bucket: string) => `session:${bucket}:`),
}));

vi.mock('../../lib/container-helpers', () => ({
  getContainerContext: vi.fn(),
  getSessionIdFromQuery: vi.fn((c: any) => c.req.query('sessionId')),
  getContainerId: vi.fn((bucket: string, sessionId: string) => `${bucket}-${sessionId}`),
}));

import {
  validateSessionAndCheckLimits,
  ensureBucketAndSeed,
  configureContainerDO,
  startOrRestartContainer,
} from '../../routes/container/lifecycle';

describe('Container lifecycle extracted helpers', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockKV = createMockKV();
    mockListAllKvKeys.mockResolvedValue([]);
    mockGetR2Config.mockResolvedValue({
      accountId: 'test-account-id',
      endpoint: 'https://test.r2.cloudflarestorage.com',
    });
    mockCreateBucketIfNotExists.mockResolvedValue({ success: true, created: false });
    mockSeedGettingStartedDocs.mockResolvedValue({ written: [], skipped: [] });
    mockReconcileAgentConfigs.mockResolvedValue({ written: [], skipped: [], deleted: [], warnings: [] });
    mockGetOrCreateScopedR2Token.mockResolvedValue({
      accessKeyId: 'scoped-ak',
      secretAccessKey: 'scoped-sk',
      tokenId: 'scoped-tok',
    });
  });

  describe('validateSessionAndCheckLimits', () => {
    it('returns session data when session exists and under limit', async () => {
      mockKV._set('session:bucket:session1', {
        id: 'session1',
        name: 'Test',
        status: 'stopped',
        createdAt: '2024-01-01T00:00:00Z',
      } satisfies Partial<Session>);

      const result = await validateSessionAndCheckLimits({
        env: { KV: mockKV as unknown as KVNamespace } as Env,
        bucketName: 'bucket',
        sessionId: 'session1',
        maxSessions: 3,
      });

      expect(result.id).toBe('session1');
    });

    it('throws NotFoundError when session does not exist', async () => {
      await expect(
        validateSessionAndCheckLimits({
          env: { KV: mockKV as unknown as KVNamespace } as Env,
          bucketName: 'bucket',
          sessionId: 'nonexistent',
          maxSessions: 3,
        })
      ).rejects.toThrow('Session');
    });

    it('throws RateLimitError when at max sessions', async () => {
      // Seed 3 running sessions
      const sessionKeys = [];
      for (let i = 1; i <= 3; i++) {
        const id = `running${String(i).padStart(10, '0')}`;
        const key = `session:bucket:${id}`;
        mockKV._set(key, {
          id,
          name: `R${i}`,
          status: 'running',
          createdAt: '2024-01-01T00:00:00Z',
        });
        sessionKeys.push({ name: key });
      }
      // The session being started
      const newKey = 'session:bucket:newsession1234';
      mockKV._set(newKey, {
        id: 'newsession1234',
        name: 'New',
        status: 'stopped',
        createdAt: '2024-01-01T00:00:00Z',
      });
      sessionKeys.push({ name: newKey });

      // Mock listAllKvKeys to return all session keys
      mockListAllKvKeys.mockResolvedValue(sessionKeys);

      await expect(
        validateSessionAndCheckLimits({
          env: { KV: mockKV as unknown as KVNamespace } as Env,
          bucketName: 'bucket',
          sessionId: 'newsession1234',
          maxSessions: 3,
        })
      ).rejects.toThrow('Session limit reached');
    });
  });

  describe('ensureBucketAndSeed', () => {
    it('creates bucket and returns r2Config', async () => {
      const result = await ensureBucketAndSeed({
        env: { KV: mockKV as unknown as KVNamespace, CLOUDFLARE_API_TOKEN: 'tok' } as Env,
        bucketName: 'test-bucket',
        sessionMode: 'default',
        logger: mockLogger as any,
      });

      expect(result.r2Config.accountId).toBe('test-account-id');
      expect(mockCreateBucketIfNotExists).toHaveBeenCalledWith(
        'test-account-id', 'tok', 'test-bucket'
      );
    });

    it('throws ContainerError when bucket creation fails', async () => {
      mockCreateBucketIfNotExists.mockResolvedValue({ success: false, error: 'Access denied' });

      await expect(
        ensureBucketAndSeed({
          env: { KV: mockKV as unknown as KVNamespace, CLOUDFLARE_API_TOKEN: 'tok' } as Env,
          bucketName: 'test-bucket',
          sessionMode: 'default',
          logger: mockLogger as any,
        })
      ).rejects.toThrow();
    });

    it('seeds docs when bucket is newly created', async () => {
      mockCreateBucketIfNotExists.mockResolvedValue({ success: true, created: true });

      await ensureBucketAndSeed({
        env: { KV: mockKV as unknown as KVNamespace, CLOUDFLARE_API_TOKEN: 'tok' } as Env,
        bucketName: 'test-bucket',
        sessionMode: 'default',
        logger: mockLogger as any,
      });

      expect(mockSeedGettingStartedDocs).toHaveBeenCalled();
    });

    it('does not seed docs when bucket already existed', async () => {
      mockCreateBucketIfNotExists.mockResolvedValue({ success: true, created: false });

      await ensureBucketAndSeed({
        env: { KV: mockKV as unknown as KVNamespace, CLOUDFLARE_API_TOKEN: 'tok' } as Env,
        bucketName: 'test-bucket',
        sessionMode: 'default',
        logger: mockLogger as any,
      });

      expect(mockSeedGettingStartedDocs).not.toHaveBeenCalled();
    });
  });

  describe('configureContainerDO', () => {
    const mockContainer = {
      fetch: vi.fn(),
    };
    const baseParams = {
      container: mockContainer,
      bucketName: 'test-bucket',
      sessionId: 'session1234',
      containerId: 'test-bucket-session1234',
      scopedCreds: { accessKeyId: 'ak', secretAccessKey: 'sk' },
      r2Config: { accountId: 'acct', endpoint: 'https://r2.example.com' },
      tabConfig: [{ id: '1', command: 'claude-code', label: 'Claude' }],
      workspaceSyncEnabled: true,
      fastStartEnabled: false,
      sessionMode: 'default',
      logger: mockLogger as any,
    };

    beforeEach(() => {
      mockContainer.fetch.mockResolvedValue(new Response('ok', { status: 200 }));
    });

    it('calls setBucketName on container and returns needsBucketUpdate=true when bucket differs', async () => {
      mockGetStoredBucketName.mockResolvedValue('old-bucket');

      const result = await configureContainerDO(baseParams);

      expect(result.needsBucketUpdate).toBe(true);
      expect(mockContainer.fetch).toHaveBeenCalledTimes(1);
      const fetchCall = mockContainer.fetch.mock.calls[0][0] as Request;
      expect(fetchCall.url).toContain('setBucketName');
    });

    it('returns needsBucketUpdate=false when stored bucket matches', async () => {
      mockGetStoredBucketName.mockResolvedValue('test-bucket');

      const result = await configureContainerDO(baseParams);

      expect(result.needsBucketUpdate).toBe(false);
    });

    it('throws ContainerError when setBucketName fails and bucket update needed', async () => {
      mockGetStoredBucketName.mockResolvedValue('old-bucket');
      mockContainer.fetch.mockRejectedValue(new Error('network error'));

      await expect(configureContainerDO(baseParams)).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('warns but does not throw when setBucketName fails and bucket already correct', async () => {
      mockGetStoredBucketName.mockResolvedValue('test-bucket');
      mockContainer.fetch.mockRejectedValue(new Error('network error'));

      const result = await configureContainerDO(baseParams);

      expect(result.needsBucketUpdate).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('includes LLM keys in setBucketName body when provided', async () => {
      mockGetStoredBucketName.mockResolvedValue('old-bucket');

      const paramsWithLlm = {
        ...baseParams,
        openaiApiKey: 'sk-test123',
        geminiApiKey: 'AIzaSy-test456',
      };

      await configureContainerDO(paramsWithLlm);

      const fetchCall = mockContainer.fetch.mock.calls[0][0] as Request;
      const body = await fetchCall.json() as Record<string, unknown>;
      expect(body.openaiApiKey).toBe('sk-test123');
      expect(body.geminiApiKey).toBe('AIzaSy-test456');
    });

    it('omits LLM keys from body when not provided', async () => {
      mockGetStoredBucketName.mockResolvedValue('old-bucket');

      await configureContainerDO(baseParams);

      const fetchCall = mockContainer.fetch.mock.calls[0][0] as Request;
      const body = await fetchCall.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('openaiApiKey');
      expect(body).not.toHaveProperty('geminiApiKey');
    });

    it('includes sessionMode in setBucketName body', async () => {
      mockGetStoredBucketName.mockResolvedValue('old-bucket');

      const paramsWithAdvanced = {
        ...baseParams,
        sessionMode: 'advanced',
      };

      await configureContainerDO(paramsWithAdvanced);

      const fetchCall = mockContainer.fetch.mock.calls[0][0] as Request;
      const body = await fetchCall.json() as Record<string, unknown>;
      expect(body.sessionMode).toBe('advanced');
    });
  });

  describe('startOrRestartContainer', () => {
    const createMockContainer = (state = 'stopped') => ({
      fetch: vi.fn().mockResolvedValue(new Response('ok')),
      destroy: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockResolvedValue({ status: state }),
      startAndWaitForPorts: vi.fn().mockResolvedValue(undefined),
    });

    const baseParams = (container: ReturnType<typeof createMockContainer>, overrides = {}) => ({
      container,
      needsBucketUpdate: false,
      setBucketBody: '{}',
      containerId: 'bucket-session1234',
      sessionData: { id: 'session1234', name: 'Test', status: 'stopped', createdAt: '2024-01-01T00:00:00Z' } as Session,
      sessionKey: 'session:bucket:session1234',
      env: { KV: mockKV as unknown as KVNamespace } as Env,
      shortContainerId: 'bucket-ses',
      logger: mockLogger as any,
      waitUntil: vi.fn((p: Promise<void>) => { p.catch(() => {}); }),
      ...overrides,
    });

    it('returns already_running when container is running and no bucket update needed', async () => {
      const container = createMockContainer('running');
      const result = await startOrRestartContainer(baseParams(container));

      expect(result.status).toBe('already_running');
      expect(container.destroy).not.toHaveBeenCalled();
      expect(container.startAndWaitForPorts).not.toHaveBeenCalled();
    });

    it('destroys and restarts when running but bucket name changed', async () => {
      const container = createMockContainer('running');
      const params = baseParams(container, { needsBucketUpdate: true });

      const result = await startOrRestartContainer(params);

      expect(container.destroy).toHaveBeenCalled();
      expect(result.status).toBe('starting');
    });

    it('kicks off background start when container is stopped', async () => {
      const container = createMockContainer('stopped');
      const params = baseParams(container);

      const result = await startOrRestartContainer(params);

      expect(result.status).toBe('starting');
      expect(params.waitUntil).toHaveBeenCalled();
    });

    it('marks session as running in KV', async () => {
      const container = createMockContainer('stopped');
      const params = baseParams(container);

      await startOrRestartContainer(params);

      const stored = await mockKV.get('session:bucket:session1234', 'json') as any;
      expect(stored.status).toBe('running');
    });

    it('handles getState failure gracefully and starts container', async () => {
      const container = createMockContainer('stopped');
      container.getState.mockRejectedValue(new Error('state unavailable'));
      const params = baseParams(container);

      const result = await startOrRestartContainer(params);

      expect(result.status).toBe('starting');
    });

    // CF-022: KV rollback on container start failure
    it('rolls back KV session status to stopped when startAndWaitForPorts throws', async () => {
      const container = createMockContainer('stopped');
      container.startAndWaitForPorts.mockRejectedValue(new Error('Container crashed'));

      // Seed the session in KV so the rollback can read it
      mockKV._set('session:bucket:session1234', {
        id: 'session1234',
        name: 'Test',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
      });

      const params = baseParams(container);
      // Use a waitUntil that awaits the promise so we can verify the rollback
      const capturedPromises: Promise<void>[] = [];
      params.waitUntil = vi.fn((p: Promise<void>) => {
        capturedPromises.push(p);
      });

      await startOrRestartContainer(params);

      // Wait for the background promise (waitUntil callback) to settle
      expect(capturedPromises.length).toBe(1);
      await capturedPromises[0];

      // After start failure, KV should be rolled back to 'stopped'
      const stored = await mockKV.get('session:bucket:session1234', 'json') as any;
      expect(stored.status).toBe('stopped');
    });

    it('handles KV rollback failure gracefully (does not throw)', async () => {
      const container = createMockContainer('stopped');
      container.startAndWaitForPorts.mockRejectedValue(new Error('Container crashed'));

      // Seed the session in KV
      mockKV._set('session:bucket:session1234', {
        id: 'session1234',
        name: 'Test',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
      });

      const params = baseParams(container);

      // Make KV.put fail during rollback (after the initial read succeeds)
      const originalPut = mockKV.put;
      let putCallCount = 0;
      mockKV.put = vi.fn(async (key: string, value: string, opts?: any) => {
        putCallCount++;
        // First put is the session status change to 'running', let it through
        // Second put would be the rollback to 'stopped', make it fail
        if (putCallCount > 1) {
          throw new Error('KV write failed');
        }
        return originalPut(key, value, opts);
      });

      const capturedPromises: Promise<void>[] = [];
      params.waitUntil = vi.fn((p: Promise<void>) => {
        capturedPromises.push(p);
      });

      await startOrRestartContainer(params);

      // The background promise should resolve without throwing,
      // even though KV rollback failed
      await expect(capturedPromises[0]).resolves.toBeUndefined();
    });
  });
});
