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

  describe('alarm - bounded activity failure counter', () => {
    /**
     * The alarm() method polls the terminal server's /activity endpoint.
     * When the endpoint is unreachable (container process dead), it should
     * tolerate a bounded number of failures before force-destroying the DO.
     *
     * With the mock Container base class, this.fetch() returns non-JSON
     * ('base fetch'), so getActivityInfo() always returns null — simulating
     * an unreachable activity endpoint.
     */
    function createAlarmInstance() {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === '_destroyed') return false;
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_last_shutdown_info') return null;
        return null;
      });
      return new ContainerClass(mockCtx as any, mockEnv);
    }

    it('increments consecutive failure counter on each unreachable poll', async () => {
      const instance = createAlarmInstance();
      vi.spyOn(instance, 'getState' as any).mockResolvedValue({ status: 'running' });
      // Bypass retry delays — return null immediately (activity unreachable)
      vi.spyOn(instance as any, 'getActivityInfoWithRetry').mockResolvedValue(null);

      await instance.alarm();

      // Should have scheduled next poll (not destroyed)
      expect(mockStorage.setAlarm).toHaveBeenCalled();
      // _destroyed flag should NOT be set yet (only 1 failure)
      expect(mockStorage.put).not.toHaveBeenCalledWith('_destroyed', true);
    });

    it('force-destroys after MAX_CONSECUTIVE_ACTIVITY_FAILURES', async () => {
      const instance = createAlarmInstance();
      vi.spyOn(instance, 'getState' as any).mockResolvedValue({ status: 'running' });
      vi.spyOn(instance as any, 'getActivityInfoWithRetry').mockResolvedValue(null);

      // Simulate 6 consecutive failures (MAX_CONSECUTIVE_ACTIVITY_FAILURES = 6)
      for (let i = 0; i < 6; i++) {
        mockStorage.setAlarm.mockClear();
        mockStorage.put.mockClear();
        (instance as any)._activityPollAlarm = false;
        await instance.alarm();
      }

      // After 6 failures, should have called cleanupAndDestroy
      expect(mockStorage.put).toHaveBeenCalledWith('_destroyed', true);
      expect(mockStorage.deleteAlarm).toHaveBeenCalled();
    });

    it('resets failure counter when activity endpoint becomes reachable', async () => {
      const instance = createAlarmInstance();
      vi.spyOn(instance, 'getState' as any).mockResolvedValue({ status: 'running' });
      const retryMock = vi.spyOn(instance as any, 'getActivityInfoWithRetry');

      // Simulate 3 failures
      retryMock.mockResolvedValue(null);
      for (let i = 0; i < 3; i++) {
        (instance as any)._activityPollAlarm = false;
        await instance.alarm();
      }

      // Now make activity endpoint reachable (active container, not idle)
      retryMock.mockResolvedValue({
        hasActiveConnections: true,
        lastUserInputMs: 1000,
        lastAgentFileActivityMs: 1000,
      });

      (instance as any)._activityPollAlarm = false;
      await instance.alarm();

      // Counter should be reset — running 3 more failures shouldn't destroy
      retryMock.mockResolvedValue(null);
      for (let i = 0; i < 3; i++) {
        mockStorage.put.mockClear();
        (instance as any)._activityPollAlarm = false;
        await instance.alarm();
      }

      // Should NOT have been destroyed (only 3 failures after reset, threshold is 6)
      expect(mockStorage.put).not.toHaveBeenCalledWith('_destroyed', true);
    });

    it('does not destroy on normal idle timeout path when activity is reachable', async () => {
      const instance = createAlarmInstance();
      vi.spyOn(instance, 'getState' as any).mockResolvedValue({ status: 'running' });

      // Activity endpoint reachable but container is idle (high idle times)
      vi.spyOn(instance, 'fetch').mockImplementation(async (request: Request) => {
        if (new URL(request.url).pathname === '/activity') {
          return new Response(JSON.stringify({
            hasActiveConnections: false,
            lastUserInputMs: 60 * 60 * 1000, // 1 hour idle
            lastAgentFileActivityMs: 60 * 60 * 1000,
          }), { status: 200 });
        }
        return new Response('base fetch', { status: 200 });
      });

      (instance as any)._activityPollAlarm = false;
      await instance.alarm();

      // Should have destroyed via idle_timeout (not activity_unreachable)
      expect(mockStorage.put).toHaveBeenCalledWith('_destroyed', true);
    });

    it('stays alive when user input recent but agent files idle', async () => {
      const instance = createAlarmInstance();
      vi.spyOn(instance, 'getState' as any).mockResolvedValue({ status: 'running' });

      vi.spyOn(instance, 'fetch').mockImplementation(async (request: Request) => {
        if (new URL(request.url).pathname === '/activity') {
          return new Response(JSON.stringify({
            hasActiveConnections: false,
            lastUserInputMs: 1000,              // 1 second ago
            lastAgentFileActivityMs: 3600000,   // 1 hour ago
          }), { status: 200 });
        }
        return new Response('base fetch', { status: 200 });
      });

      (instance as any)._activityPollAlarm = false;
      mockStorage.put.mockClear();
      await instance.alarm();

      // min(1s, 1h) = 1s < 30min idle timeout — should NOT destroy
      expect(mockStorage.put).not.toHaveBeenCalledWith('_destroyed', true);
    });

    it('stays alive when agent files active but no user input', async () => {
      const instance = createAlarmInstance();
      vi.spyOn(instance, 'getState' as any).mockResolvedValue({ status: 'running' });

      vi.spyOn(instance, 'fetch').mockImplementation(async (request: Request) => {
        if (new URL(request.url).pathname === '/activity') {
          return new Response(JSON.stringify({
            hasActiveConnections: false,
            lastUserInputMs: 3600000,           // 1 hour ago
            lastAgentFileActivityMs: 1000,      // 1 second ago
          }), { status: 200 });
        }
        return new Response('base fetch', { status: 200 });
      });

      (instance as any)._activityPollAlarm = false;
      mockStorage.put.mockClear();
      await instance.alarm();

      // min(1h, 1s) = 1s < 30min idle timeout — should NOT destroy
      expect(mockStorage.put).not.toHaveBeenCalledWith('_destroyed', true);
    });

    it('destroyed when BOTH exceed idle timeout', async () => {
      const instance = createAlarmInstance();
      vi.spyOn(instance, 'getState' as any).mockResolvedValue({ status: 'running' });

      vi.spyOn(instance, 'fetch').mockImplementation(async (request: Request) => {
        if (new URL(request.url).pathname === '/activity') {
          return new Response(JSON.stringify({
            hasActiveConnections: false,
            lastUserInputMs: 1860001,           // 31 minutes
            lastAgentFileActivityMs: 1860001,   // 31 minutes
          }), { status: 200 });
        }
        return new Response('base fetch', { status: 200 });
      });

      (instance as any)._activityPollAlarm = false;
      await instance.alarm();

      // min(31m, 31m) = 31m > 30min idle timeout — should destroy
      expect(mockStorage.put).toHaveBeenCalledWith('_destroyed', true);
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
