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

vi.mock('../../lib/r2-seed', () => ({
  seedGettingStartedDocs: mockSeedGettingStartedDocs,
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
  containerInternalCB: {
    execute: vi.fn((fn: () => Promise<any>) => fn()),
  },
  getStoredBucketName: mockGetStoredBucketName,
}));

vi.mock('../../lib/circuit-breakers', () => ({
  r2AdminCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
  containerHealthCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
  containerInternalCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
  containerSessionsCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
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
          logger: mockLogger as any,
        })
      ).rejects.toThrow();
    });

    it('seeds docs when bucket is newly created', async () => {
      mockCreateBucketIfNotExists.mockResolvedValue({ success: true, created: true });

      await ensureBucketAndSeed({
        env: { KV: mockKV as unknown as KVNamespace, CLOUDFLARE_API_TOKEN: 'tok' } as Env,
        bucketName: 'test-bucket',
        logger: mockLogger as any,
      });

      expect(mockSeedGettingStartedDocs).toHaveBeenCalled();
    });

    it('does not seed docs when bucket already existed', async () => {
      mockCreateBucketIfNotExists.mockResolvedValue({ success: true, created: false });

      await ensureBucketAndSeed({
        env: { KV: mockKV as unknown as KVNamespace, CLOUDFLARE_API_TOKEN: 'tok' } as Env,
        bucketName: 'test-bucket',
        logger: mockLogger as any,
      });

      expect(mockSeedGettingStartedDocs).not.toHaveBeenCalled();
    });
  });
});
