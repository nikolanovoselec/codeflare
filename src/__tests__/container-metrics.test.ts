import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV, MockKV } from './helpers/mock-kv';
import type { Session } from '../types';

// ---------------------------------------------------------------------------
// Shared mutable state - vi.hoisted ensures this runs before vi.mock factories
// ---------------------------------------------------------------------------
const testState = vi.hoisted(() => ({
  storedSessionId: 'testsession123456' as string | undefined,
  storedBucketName: 'test-bucket' as string | null,
  storedSleepAfter: undefined as string | undefined,
  storedUserEmail: undefined as string | undefined,
  containerRunning: true,
  activityResult: {
    hasActiveConnections: true,
    connectedClients: 1,
    lastInputAt: Date.now(),
  } as Record<string, unknown>,
  healthResult: {
    cpu: '45%',
    mem: '1024MB',
    hdd: '2.5GB',
    syncStatus: 'success',
  } as Record<string, string>,
  tcpFetchShouldFail: false,
  stopCalls: 0,
  scheduleCalls: [] as Array<[number, string]>,
  kvRef: null as MockKV | null,
}));

// ---------------------------------------------------------------------------
// Module-level mocks - must be before imports that depend on mocked modules
// ---------------------------------------------------------------------------
vi.mock('@cloudflare/containers', () => {
  class MockContainer {
    ctx: {
      container: { running: boolean; getTcpPort: (port: number) => { fetch: (url: string) => Promise<Response> } };
      storage: { get: <T>(key: string) => Promise<T | undefined>; put: (key: string, value: unknown) => Promise<void>; delete: (key: string) => Promise<void> };
      blockConcurrencyWhile: (fn: () => Promise<void>) => Promise<void>;
    };
    env: Record<string, unknown>;
    envVars: Record<string, string> | undefined;

    constructor() {
      this.ctx = {
        container: {
          get running() { return testState.containerRunning; },
          getTcpPort: () => ({
            fetch: async (url: string) => {
              if (testState.tcpFetchShouldFail) {
                throw new Error('Connection refused');
              }
              const body = url.includes('/activity')
                ? testState.activityResult
                : testState.healthResult;
              return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
            },
          }),
        },
        storage: {
          get: async <T>(key: string): Promise<T | undefined> => {
            if (key === '_sessionId') return testState.storedSessionId as T;
            if (key === 'bucketName') return testState.storedBucketName as T;
            if (key === 'sleepAfter') return testState.storedSleepAfter as T;
            if (key === 'userEmail') return testState.storedUserEmail as T;
            return undefined;
          },
          put: vi.fn(),
          delete: vi.fn(),
        },
        blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
      };
      this.env = {
        KV: null, // will be set per test
      };
    }

    // Mock schedule method
    async schedule(delaySec: number, method: string) {
      testState.scheduleCalls.push([delaySec, method]);
    }

    // Mock stop (called by collectMetrics on idle exceedance)
    async stop(_signal?: number | string) {
      testState.stopCalls += 1;
    }

    // Mock destroy
    async destroy() {}
  }
  return { Container: MockContainer };
});

vi.mock('../lib/r2-config', () => ({
  getR2Config: vi.fn(async () => ({ accountId: 'test-account', endpoint: 'https://test.r2.cloudflarestorage.com' })),
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import AFTER mocks are set up
import { container } from '../container/index';

describe('Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)', () => {
  let mockKV: MockKV;
  let containerInstance: InstanceType<typeof container>;

  beforeEach(async () => {
    mockKV = createMockKV();
    testState.containerRunning = true;
    testState.storedSessionId = 'testsession123456';
    testState.storedBucketName = 'test-bucket';
    testState.tcpFetchShouldFail = false;
    testState.activityResult = {
      hasActiveConnections: true,
      connectedClients: 1,
      lastInputAt: Date.now(),
      };
    testState.healthResult = {
      cpu: '45%',
      mem: '1024MB',
      hdd: '2.5GB',
      syncStatus: 'success',
    };
    testState.scheduleCalls = [];
    testState.stopCalls = 0;
    testState.storedSleepAfter = undefined;
    testState.storedUserEmail = undefined;
    testState.kvRef = mockKV;

    // Create a container instance with mock env
    containerInstance = new (container as unknown as new (ctx: unknown, env: unknown) => InstanceType<typeof container>)(
      {}, // DurableObjectState (mocked via vi.mock)
      { KV: mockKV, LOG_LEVEL: 'silent' },
    );

    // Set the KV reference on the env
    (containerInstance as unknown as { env: { KV: MockKV } }).env.KV = mockKV;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('onStart', () => {
    it('should call schedule(60, "collectMetrics") on start', async () => {
      await containerInstance.onStart();

      // Check that schedule was called with correct args
      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
    });
  });

  describe('collectMetrics', () => {
    it('should fetch health data from TCP port and write metrics to KV', async () => {
      // Seed a session in KV
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      await containerInstance.collectMetrics();

      // Verify metrics written to session key (with metadata for batch-status)
      expect(mockKV.put).toHaveBeenCalled();
      const putCall = mockKV.put.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('testsession123456')
      );
      expect(putCall).toBeDefined();
      const stored = JSON.parse(putCall![1] as string) as Session;
      expect(stored.metrics).toBeDefined();
      expect(stored.metrics!.cpu).toBe('45%');
      expect(stored.metrics!.mem).toBe('1024MB');
      expect(stored.metrics!.hdd).toBe('2.5GB');
      expect(stored.metrics!.syncStatus).toBe('success');
      expect(stored.metrics!.updatedAt).toBeDefined();
    });

    it('should re-arm schedule if container is still running', async () => {
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      testState.scheduleCalls = [];
      await containerInstance.collectMetrics();

      // Should re-arm with schedule(5, 'collectMetrics')
      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
    });

    it('should not re-arm schedule if container is not running', async () => {
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      // Container stops after initial check but before re-arm
      testState.containerRunning = true; // running for the initial guard
      await containerInstance.collectMetrics();

      // Reset and set not running
      testState.scheduleCalls = [];
      testState.containerRunning = false;
      await containerInstance.collectMetrics();

      // Should NOT re-arm when container is not running.
      // onStart() will restart the schedule loop on next container start.
      expect(testState.scheduleCalls).toHaveLength(0);
    });

    it('should handle fetch failure gracefully without crashing', async () => {
      testState.tcpFetchShouldFail = true;

      // Should not throw
      await expect(containerInstance.collectMetrics()).resolves.toBeUndefined();
    });

    // REQ-SUB-008 AC1+AC2+AC3: when Timekeeper /ping returns quotaExceeded=true,
    // collectMetrics must call stop('SIGTERM') (NOT SIGKILL) so the entrypoint
    // trap runs the final rclone bisync before the container exits. AC3 is the
    // shape of the ping response; AC1+AC2 are the DO-side consequence.
    it('REQ-SUB-008 AC1: calls stop("SIGTERM") when Timekeeper /ping returns quotaExceeded=true', async () => {
      // Build a fresh container with SAAS_MODE active + a TIMEKEEPER stub that
      // unconditionally returns quotaExceeded:true. Seed bucketName + userEmail
      // in storage so the Timekeeper-ping branch is reachable.
      // CRITICAL: Container constructor kicks off blockConcurrencyWhile that
      // re-reads _userEmail/_bucketName/_sessionId from storage AFTER the
      // constructor returns. Manual post-construction field overrides get
      // clobbered when the microtask queue drains during the next `await`.
      // Seed storage BEFORE construction so the constructor reads the right
      // values; do not rely on field-level overrides for fields the
      // constructor reads.
      testState.storedBucketName = 'test-bucket';
      testState.storedSessionId = 'testsession123456';
      testState.storedUserEmail = 'quota@example.com';

      const timekeeperStub = {
        fetch: vi.fn(async () =>
          new Response(JSON.stringify({ quotaExceeded: true, totalMonthlySeconds: 9999 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        ),
      };
      const TIMEKEEPER = {
        idFromName: vi.fn(() => ({ toString: () => 'tk-id' })),
        get: vi.fn(() => timekeeperStub),
      };

      const instance = new (container as unknown as new (ctx: unknown, env: unknown) => InstanceType<typeof container>)(
        {},
        { KV: mockKV, LOG_LEVEL: 'silent', SAAS_MODE: 'active', TIMEKEEPER },
      );
      // The MockContainer constructor in vi.mock('@cloudflare/containers')
      // resets this.env to { KV: null } and ignores the constructor env arg,
      // so SAAS_MODE and TIMEKEEPER must be assigned post-construction.
      const instanceEnv = (instance as unknown as { env: Record<string, unknown> }).env;
      instanceEnv.KV = mockKV;
      instanceEnv.SAAS_MODE = 'active';
      instanceEnv.TIMEKEEPER = TIMEKEEPER;

      const stopSpy = vi.spyOn(instance, 'stop');

      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      // Wait for the constructor's blockConcurrencyWhile to settle so the
      // storage-driven _userEmail/_bucketName/_sessionId are in place.
      await vi.waitFor(
        () => expect((instance as unknown as { _userEmail: string | null })._userEmail).toBe('quota@example.com'),
        { timeout: 1000 },
      );

      testState.scheduleCalls = [];
      await instance.collectMetrics();

      expect(timekeeperStub.fetch).toHaveBeenCalledTimes(1);
      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
      // Returns early after stop — must NOT re-arm the schedule.
      expect(testState.scheduleCalls).toEqual([]);
    });

    it('REQ-SUB-008 AC1: does NOT stop when Timekeeper /ping returns quotaExceeded=false', async () => {
      testState.storedBucketName = 'test-bucket';
      testState.storedSessionId = 'testsession123456';
      testState.storedUserEmail = 'under-quota@example.com';

      const timekeeperStub = {
        fetch: vi.fn(async () =>
          new Response(JSON.stringify({ quotaExceeded: false, totalMonthlySeconds: 100 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        ),
      };
      const TIMEKEEPER = {
        idFromName: vi.fn(() => ({ toString: () => 'tk-id' })),
        get: vi.fn(() => timekeeperStub),
      };

      const instance = new (container as unknown as new (ctx: unknown, env: unknown) => InstanceType<typeof container>)(
        {},
        { KV: mockKV, LOG_LEVEL: 'silent', SAAS_MODE: 'active', TIMEKEEPER },
      );
      const instanceEnv = (instance as unknown as { env: Record<string, unknown> }).env;
      instanceEnv.KV = mockKV;
      instanceEnv.SAAS_MODE = 'active';
      instanceEnv.TIMEKEEPER = TIMEKEEPER;

      const stopSpy = vi.spyOn(instance, 'stop');

      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      await vi.waitFor(
        () => expect((instance as unknown as { _userEmail: string | null })._userEmail).toBe('under-quota@example.com'),
        { timeout: 1000 },
      );

      await instance.collectMetrics();

      expect(timekeeperStub.fetch).toHaveBeenCalledTimes(1);
      expect(stopSpy).not.toHaveBeenCalled();
    });

    it('should not write to KV when session is not found', async () => {
      // No session seeded in KV
      await containerInstance.collectMetrics();

      // KV.put should not have been called for a session key
      const sessionPuts = mockKV.put.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).startsWith('session:')
      );
      expect(sessionPuts).toHaveLength(0);
    });

    it('should not write to KV when sessionId is not stored', async () => {
      testState.storedSessionId = undefined;
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      await containerInstance.collectMetrics();

      const sessionPuts = mockKV.put.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).startsWith('session:')
      );
      expect(sessionPuts).toHaveLength(0);
    });
  });

  describe('idle timeout resolution (REQ-OPS-006 AC8/AC9) / REQ-OPS-017 (sleepAfter fail-safe invariants)', () => {
    it('uses fail-safe 2h default when storage has no sleepAfter', async () => {
      // Storage returns undefined for 'sleepAfter'.
      // Class-field default is '2h' (max safe). Container has been idle for 1 hour.
      // 1h < 2h → container should NOT be stopped.
      testState.storedSleepAfter = undefined;
      testState.activityResult = {
        hasActiveConnections: true,
        connectedClients: 1,
        lastInputAt: Date.now() - (1 * 60 * 60 * 1000), // 1 hour ago
      };
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      await containerInstance.collectMetrics();

      expect(testState.stopCalls).toBe(0);
    });

    it('refreshes idleTimeoutPref from storage on every tick', async () => {
      // Initial: storage holds '15m'.
      // Container has been idle for 30 minutes.
      // 30m > 15m → container SHOULD be stopped.
      testState.storedSleepAfter = '15m';
      testState.activityResult = {
        hasActiveConnections: true,
        connectedClients: 1,
        lastInputAt: Date.now() - (30 * 60 * 1000), // 30 minutes ago
      };
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      await containerInstance.collectMetrics();

      expect(testState.stopCalls).toBe(1);
    });

    it('respects 2h pref - 90 minute idle does NOT trigger stop', async () => {
      // Storage holds '2h' (the user's configured max).
      // Container has been idle for 90 minutes.
      // 90m < 2h → container should NOT be stopped.
      testState.storedSleepAfter = '2h';
      testState.activityResult = {
        hasActiveConnections: true,
        connectedClients: 1,
        lastInputAt: Date.now() - (90 * 60 * 1000), // 90 minutes ago
      };
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      await containerInstance.collectMetrics();

      // The bug this guards against: pref '2h' silently dropping to a shorter
      // value would stop the container before 2h. With the new fail-safe
      // defaults, even if the pref weren't read at all, the class-field
      // fallback is '2h' so 90m stays alive.
      expect(testState.stopCalls).toBe(0);
    });

    it('respects 2h pref - 130 minute idle DOES trigger stop', async () => {
      testState.storedSleepAfter = '2h';
      testState.activityResult = {
        hasActiveConnections: true,
        connectedClients: 1,
        lastInputAt: Date.now() - (130 * 60 * 1000), // 130 minutes ago, > 2h
      };
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      await containerInstance.collectMetrics();

      expect(testState.stopCalls).toBe(1);
    });

    it('ignores invalid stored sleepAfter values and uses class-field fallback', async () => {
      // Someone wrote a malformed value into storage. The collectMetrics
      // refresh validates against the regex and ignores invalid values,
      // falling back to the class-field default ('2h').
      testState.storedSleepAfter = 'GARBAGE';
      testState.activityResult = {
        hasActiveConnections: true,
        connectedClients: 1,
        lastInputAt: Date.now() - (30 * 60 * 1000), // 30 minutes ago
      };
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      await containerInstance.collectMetrics();

      // 30m < 2h fallback → no stop
      expect(testState.stopCalls).toBe(0);
    });
  });

  describe('updateKvStatus clears metrics on stop', () => {
    it('should delete metrics when status is set to stopped via onStop', async () => {
      // Seed a session with metrics
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
        metrics: {
          cpu: '25%',
          mem: '512MB',
          hdd: '1GB',
          syncStatus: 'success',
          updatedAt: '2024-01-15T10:00:00.000Z',
        },
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      // onStop calls updateKvStatus('stopped', 'lastActiveAt')
      await containerInstance.onStop();

      // Verify metrics are preserved (last-known values kept for dashboard display)
      expect(mockKV.put).toHaveBeenCalled();
      const putCall = mockKV.put.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('testsession123456')
      );
      expect(putCall).toBeDefined();
      const stored = JSON.parse(putCall![1] as string) as Session;
      expect(stored.status).toBe('stopped');
      expect(stored.metrics).toBeDefined();
      expect(stored.metrics?.cpu).toBe('25%');
      expect(stored.lastActiveAt).toBeDefined();
    });
  });
});
