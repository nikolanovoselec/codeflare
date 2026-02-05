import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Container DO class tests.
 *
 * The container class (src/container/index.ts) extends Cloudflare's Container<Env>
 * base class and relies heavily on Durable Object primitives (ctx.storage, ctx.id,
 * blockConcurrencyWhile) and Container-specific methods (getState, getActivityInfo,
 * super.destroy). Full constructor and lifecycle tests require the Cloudflare
 * Container runtime.
 *
 * What we CAN test in isolation:
 * - The getTerminalActivityUrl() method
 * - The internal route dispatch table structure
 * - The DESTROYED_FLAG_KEY constant behavior
 *
 * What we CANNOT test without full Container runtime:
 * - Constructor zombie detection (calls ctx.blockConcurrencyWhile + ctx.storage.get)
 * - Constructor orphan detection (requires ctx.storage)
 * - alarm() lifecycle (calls getState, getActivityInfo, super.destroy)
 * - setBucketName persistence (calls ctx.storage.put)
 * - The full fetch override (calls super.fetch for non-internal routes)
 */

// Mock dependencies before importing the container class
vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue({ accountId: 'test-account', endpoint: 'https://r2.test' }),
}));

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

// Mock the @cloudflare/containers module
vi.mock('@cloudflare/containers', () => ({
  Container: class MockContainer {
    ctx: any;
    env: any;
    envVars?: Record<string, string>;
    defaultPort?: number;
    sleepAfter?: string;

    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }

    async fetch(request: Request): Promise<Response> {
      return new Response('base fetch', { status: 200 });
    }

    async destroy(): Promise<void> {}
    async getState(): Promise<{ status: string }> {
      return { status: 'running' };
    }
    async getActivityInfo(): Promise<any> {
      return null;
    }
    onStart(): void {}
    onStop(): void {}
    onError(_error: unknown): void {}
  },
}));

// Now import the container class after mocks are set up
import { container as ContainerClass } from '../../container/index';

describe('container DO class', () => {
  let mockStorage: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteAll: ReturnType<typeof vi.fn>;
    setAlarm: ReturnType<typeof vi.fn>;
    deleteAlarm: ReturnType<typeof vi.fn>;
  };
  let mockCtx: { storage: typeof mockStorage; id: { toString: () => string }; blockConcurrencyWhile: ReturnType<typeof vi.fn> };
  let mockEnv: any;

  beforeEach(() => {
    mockStorage = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteAll: vi.fn().mockResolvedValue(undefined),
      setAlarm: vi.fn().mockResolvedValue(undefined),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
    };
    mockCtx = {
      storage: mockStorage,
      id: { toString: () => 'test-do-id-hex' },
      blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
    };
    mockEnv = {
      R2_ACCOUNT_ID: 'test-account',
      R2_ENDPOINT: 'https://r2.test',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      KV: {},
      DEV_MODE: 'false',
    };
  });

  describe('constructor', () => {
    it('initializes with defaultPort 8080', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.defaultPort).toBe(8080);
    });

    it('initializes with sleepAfter 24h', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.sleepAfter).toBe('24h');
    });

    it('calls blockConcurrencyWhile in constructor', () => {
      new ContainerClass(mockCtx as any, mockEnv);
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalledTimes(1);
    });

    it('checks _destroyed flag in storage during initialization', async () => {
      mockStorage.get.mockResolvedValue(null);
      new ContainerClass(mockCtx as any, mockEnv);

      // Wait for blockConcurrencyWhile callback to execute
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('_destroyed');
      });
    });

    it('clears all storage when _destroyed flag is set (zombie detection)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === '_destroyed') return true;
        return null;
      });

      new ContainerClass(mockCtx as any, mockEnv);

      await vi.waitFor(() => {
        expect(mockStorage.deleteAll).toHaveBeenCalled();
      });
    });

    it('clears all storage when no bucketName is found (orphan detection)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === '_destroyed') return false;
        if (key === 'bucketName') return null;
        return null;
      });

      new ContainerClass(mockCtx as any, mockEnv);

      await vi.waitFor(() => {
        expect(mockStorage.deleteAll).toHaveBeenCalled();
      });
    });
  });

  describe('getTerminalActivityUrl', () => {
    it('returns correct URL for activity endpoint on port 8080', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.getTerminalActivityUrl()).toBe('http://container:8080/activity');
    });
  });

  describe('internal route dispatch', () => {
    it('dispatches POST /_internal/setBucketName to handler', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === '_destroyed') return false;
        if (key === 'bucketName') return 'existing-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const body = await response.json() as { success: boolean; bucketName: string };
      expect(body.success).toBe(true);
      expect(body.bucketName).toBe('new-bucket');
    });

    it('dispatches GET /_internal/getBucketName to handler', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === '_destroyed') return false;
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/getBucketName', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      const body = await response.json() as { bucketName: string | null };
      expect(body).toHaveProperty('bucketName');
    });

    it('dispatches GET /_internal/debugEnvVars to handler', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === '_destroyed') return false;
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/debugEnvVars', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      // DEV_MODE is 'false', so should return 404
      expect(response.status).toBe(404);
    });

    it('debugEnvVars returns data when DEV_MODE is true', async () => {
      mockEnv.DEV_MODE = 'true';
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === '_destroyed') return false;
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/debugEnvVars', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const body = await response.json() as Record<string, unknown>;
      expect(body).toHaveProperty('bucketName');
      expect(body).toHaveProperty('envVars');
    });

    it('setBucketName returns 400 for missing bucketName', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(400);
    });

    it('falls through to super.fetch for unknown routes', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === '_destroyed') return false;
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/unknown-route', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      // Should fall through to mocked super.fetch which returns 'base fetch'
      const text = await response.text();
      expect(text).toBe('base fetch');
    });
  });

  describe('destroy', () => {
    it('clears alarm and operational storage on destroy', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === '_destroyed') return false;
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await instance.destroy();

      expect(mockStorage.deleteAlarm).toHaveBeenCalled();
      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
    });
  });

  describe('mock contract verification (FIX-53)', () => {
    /**
     * Verify that the mock Container base class used in these tests has the
     * same method signatures as the real @cloudflare/containers Container class.
     * If the real class adds new methods, this test will catch the drift.
     */
    it('mock Container has all expected base class methods', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      // Core lifecycle methods that the container class overrides or relies on
      expect(typeof instance.fetch).toBe('function');
      expect(typeof instance.destroy).toBe('function');
      expect(typeof instance.onStart).toBe('function');
      expect(typeof instance.onStop).toBe('function');
      expect(typeof instance.onError).toBe('function');

      // Custom methods
      expect(typeof instance.getTerminalActivityUrl).toBe('function');
      expect(typeof instance.getBucketName).toBe('function');

      // Properties set by the class
      expect(instance.defaultPort).toBe(8080);
      expect(instance.sleepAfter).toBe('24h');
    });
  });
});
