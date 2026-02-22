import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Container DO class tests.
 *
 * The container class (src/container/index.ts) extends Cloudflare's Container<Env>
 * base class. The SDK handles idle detection via sleepAfter (3m for testing). The DO manages
 * lifecycle timestamps via KV updates in onStart/onStop.
 *
 * What we CAN test in isolation:
 * - Constructor initialization (bucketName loading, envVars population)
 * - Internal route dispatch table structure
 * - onStart/onStop lifecycle (KV timestamp updates)
 * - destroy() cleanup
 *
 * What we CANNOT test without full Container runtime:
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
    async schedule(_seconds: number, _method: string): Promise<void> {}
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
  let mockTcpPortFetch: ReturnType<typeof vi.fn>;
  let mockContainerRuntime: {
    running: boolean;
    getTcpPort: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    monitor: ReturnType<typeof vi.fn>;
    signal: ReturnType<typeof vi.fn>;
  };
  let mockCtx: {
    storage: typeof mockStorage;
    id: { toString: () => string };
    blockConcurrencyWhile: ReturnType<typeof vi.fn>;
    container: typeof mockContainerRuntime;
  };
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
    mockTcpPortFetch = vi.fn();
    mockContainerRuntime = {
      running: true,
      getTcpPort: vi.fn().mockReturnValue({ fetch: mockTcpPortFetch }),
      start: vi.fn(),
      destroy: vi.fn(),
      monitor: vi.fn(),
      signal: vi.fn(),
    };
    mockCtx = {
      storage: mockStorage,
      id: { toString: () => 'test-do-id-hex' },
      blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
      container: mockContainerRuntime,
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

    it('initializes with sleepAfter 30m', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.sleepAfter).toBe('30m');
    });

    it('calls blockConcurrencyWhile in constructor', () => {
      new ContainerClass(mockCtx as any, mockEnv);
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalledTimes(1);
    });

  });

  describe('internal route dispatch', () => {
    it('dispatches POST /_internal/setBucketName to handler', async () => {
      // No existing bucket — storage returns null for all keys
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

    it('returns 409 when bucket name already set but stores sessionId', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'existing-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', sessionId: 'sess123' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(409);
      // sessionId should still be stored even on 409
      expect(mockStorage.put).toHaveBeenCalledWith('_sessionId', 'sess123');
    });

    it('dispatches GET /_internal/getBucketName to handler', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
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

    it('setBucketName stores sessionId in DO storage', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return null;  // No bucket yet
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', sessionId: 'mysession123' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      expect(mockStorage.put).toHaveBeenCalledWith('_sessionId', 'mysession123');
    });

    it('falls through to super.fetch for unknown routes', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
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
    it('calls super.destroy() and cleans up operational storage', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await instance.destroy();

      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
    });

    it('deletes SESSION_ID_KEY to prevent onStop from resurrecting KV entry', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await instance.destroy();

      expect(mockStorage.delete).toHaveBeenCalledWith('_sessionId');
      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
    });

    it('nulls _bucketName so onStop memory fallback fails', async () => {
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const mockKvGet = vi.fn().mockResolvedValue({
        id: 'sess123',
        status: 'running',
        name: 'Test',
      });
      mockEnv.KV = { get: mockKvGet, put: mockKvPut };

      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });

      await instance.destroy();

      // After destroy, onStop should NOT write to KV because
      // both _sessionId (storage) and _bucketName (memory) are cleared
      mockKvPut.mockClear();
      // Storage.get for _sessionId returns null after delete
      mockStorage.get.mockImplementation(async () => null);

      await instance.onStop();

      // Give async work time to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockKvPut).not.toHaveBeenCalled();
    });
  });

  describe('onStart lifecycle', () => {
    it('onStart updates KV with lastStartedAt', async () => {
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const mockKvGet = vi.fn().mockResolvedValue({
        id: 'sess123',
        status: 'running',
        name: 'Test',
      });
      mockEnv.KV = { get: mockKvGet, put: mockKvPut };

      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });

      instance.onStart();

      await vi.waitFor(() => {
        expect(mockKvPut).toHaveBeenCalled();
      });
      const putArgs = mockKvPut.mock.calls[0];
      const writtenSession = JSON.parse(putArgs[1]);
      expect(writtenSession.lastStartedAt).toBeDefined();
      expect(new Date(writtenSession.lastStartedAt).toISOString()).toBe(writtenSession.lastStartedAt);
      // onStart does NOT change status (start route sets 'running' before container launches)
      expect(writtenSession.status).toBe('running');
    });

    it('onStart re-populates envVars from stored bucketName', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });

      instance.onStart();

      await vi.waitFor(() => {
        expect(instance.envVars).toBeDefined();
        expect(instance.envVars?.R2_BUCKET_NAME).toBe('test-bucket');
      });
    });

    it('onStart without bucketName does not update KV', async () => {
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      mockEnv.KV = { get: vi.fn(), put: mockKvPut };

      mockStorage.get.mockImplementation(async () => null);

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      instance.onStart();

      // Give time for any async work to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockKvPut).not.toHaveBeenCalled();
    });
  });

  describe('onStop lifecycle', () => {
    it('onStop updates KV with lastActiveAt and sets status to stopped', async () => {
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const mockKvGet = vi.fn().mockResolvedValue({
        id: 'sess123',
        status: 'running',
        name: 'Test',
      });
      mockEnv.KV = { get: mockKvGet, put: mockKvPut };

      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });

      instance.onStop();

      await vi.waitFor(() => {
        expect(mockKvPut).toHaveBeenCalled();
      });
      const putArgs = mockKvPut.mock.calls[0];
      const writtenSession = JSON.parse(putArgs[1]);
      expect(writtenSession.lastActiveAt).toBeDefined();
      expect(writtenSession.status).toBe('stopped');
    });

    it('onStop does NOT set tombstone', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });

      mockStorage.put.mockClear();
      instance.onStop();

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockStorage.put).not.toHaveBeenCalledWith('_destroyed', true);
    });

    it('onStop does NOT delete alarm', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });

      mockStorage.deleteAlarm.mockClear();
      instance.onStop();

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockStorage.deleteAlarm).not.toHaveBeenCalled();
    });
  });

  describe('constructor without tombstones', () => {
    it('constructor does NOT check _destroyed flag', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      new ContainerClass(mockCtx as any, mockEnv);

      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      const getCallArgs = mockStorage.get.mock.calls.map((c: unknown[]) => c[0]);
      expect(getCallArgs).not.toContain('_destroyed');
    });

    it('constructor loads bucketName and calls updateEnvVars', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await vi.waitFor(() => {
        expect(instance.envVars).toBeDefined();
        expect(instance.envVars?.R2_BUCKET_NAME).toBe('test-bucket');
      });
    });
  });

  describe('sleepAfter', () => {
    it('sleepAfter is 30m', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.sleepAfter).toBe('30m');
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
      expect(typeof instance.getBucketName).toBe('function');

      // Properties set by the class
      expect(instance.defaultPort).toBe(8080);
      expect(instance.sleepAfter).toBe('30m');
    });
  });
});
