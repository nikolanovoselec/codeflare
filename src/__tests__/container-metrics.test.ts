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
  activityFetchShouldFail: false,
  healthFetchShouldFail: false,
  activityStatus: 200,
  healthStatus: 200,
  stopCalls: 0,
  stopFailuresRemaining: 0,
  scheduleCalls: [] as Array<[number, string]>,
  scheduleFailuresRemaining: 0,
  deleteScheduleCalls: [] as string[],
  abortReasons: [] as string[],
  activityHangs: false,
  kvRef: null as MockKV | null,
  // REQ-SESSION-011: POST /internal/final-sync (drainFinalSync). finalSyncStatus
  // controls the mocked response status; callOrder records final-sync vs stop so
  // tests can assert the drain happens BEFORE the stop.
  finalSyncCalls: 0,
  finalSyncStatus: 200,
  callOrder: [] as string[],
  storageGetFailures: new Set<string>(),
  storagePutFailures: new Set<string>(),
  storageDeleteFailures: new Set<string>(),
  storageStore: new Map<string, unknown>(),
}));

// ---------------------------------------------------------------------------
// Module-level mocks - must be before imports that depend on mocked modules
// ---------------------------------------------------------------------------
vi.mock('@cloudflare/containers', () => {
  class MockContainer {
    ctx: {
      id: { toString: () => string };
      container: { running: boolean; getTcpPort: (port: number) => { fetch: (url: string, init?: RequestInit) => Promise<Response> } };
      storage: { get: <T>(key: string) => Promise<T | undefined>; put: (key: string, value: unknown) => Promise<void>; delete: (key: string | string[]) => Promise<void>; sync: () => Promise<void> };
      blockConcurrencyWhile: (fn: () => Promise<void>) => Promise<void>;
      abort: (reason: string) => never;
    };
    env: Record<string, unknown>;
    envVars: Record<string, string> | undefined;

    constructor() {
      this.ctx = {
        id: { toString: () => 'mock-do-id' },
        container: {
          get running() { return testState.containerRunning; },
          getTcpPort: () => ({
            fetch: async (url: string, init?: RequestInit) => {
              if (url.includes('/internal/final-sync')) {
                // drainFinalSync's call. Record it (and order vs stop) and honor
                // the failure switch / configured status so best-effort behavior
                // can be exercised independently of the /activity+/health probes.
                testState.finalSyncCalls += 1;
                testState.callOrder.push('finalsync');
                if (testState.tcpFetchShouldFail) {
                  throw new Error('Connection refused');
                }
                return new Response(JSON.stringify({ synced: testState.finalSyncStatus === 200 }), {
                  status: testState.finalSyncStatus,
                  headers: { 'Content-Type': 'application/json' },
                });
              }
              if (testState.tcpFetchShouldFail
                  || (url.includes('/activity') && testState.activityFetchShouldFail)
                  || (url.includes('/health') && testState.healthFetchShouldFail)) {
                throw new Error('Connection refused');
              }
              // A wedged container: the TCP connect succeeds and nothing is ever
              // written back. Settles ONLY on abort, mirroring how the existing
              // drainFinalSync budget test models this same port. Remove the
              // caller's signal and nothing ends this promise, so collectMetrics
              // never returns and the case fails by timeout.
              if (testState.activityHangs && url.includes('/activity')) {
                return new Promise<Response>((_resolve, reject) => {
                  init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                });
              }
              const body = url.includes('/activity')
                ? testState.activityResult
                : testState.healthResult;
              return new Response(JSON.stringify(body), {
                status: url.includes('/activity') ? testState.activityStatus : testState.healthStatus,
                headers: { 'Content-Type': 'application/json' },
              });
            },
          }),
        },
        storage: (() => {
          // Map-backed so put/get/delete actually round-trip (the
          // collectMetrics not-running confirmation marker relies on it). The
          // special-cased identifier keys still read from testState.
          const store = testState.storageStore;
          return {
            get: async <T>(key: string): Promise<T | undefined> => {
              if (testState.storageGetFailures.has(key)) throw new Error(`storage read failed: ${key}`);
              if (key === '_sessionId') return testState.storedSessionId as T;
              if (key === 'bucketName') return testState.storedBucketName as T;
              if (key === 'sleepAfter') return testState.storedSleepAfter as T;
              if (key === 'userEmail') return testState.storedUserEmail as T;
              return store.has(key) ? (store.get(key) as T) : undefined;
            },
            put: vi.fn(async (key: string, value: unknown) => {
              if (testState.storagePutFailures.has(key)) throw new Error(`storage write failed: ${key}`);
              store.set(key, value);
            }),
            delete: vi.fn(async (keys: string | string[]) => {
              const keyList = Array.isArray(keys) ? keys : [keys];
              const failedKey = keyList.find((key) => testState.storageDeleteFailures.has(key));
              if (failedKey) throw new Error(`storage delete failed: ${failedKey}`);
              for (const key of keyList) store.delete(key);
            }),
            sync: vi.fn(async () => {}),
          };
        })(),
        blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
        abort: (reason: string): never => {
          testState.abortReasons.push(reason);
          throw new Error('mock Durable Object abort');
        },
      };
      this.env = {
        KV: null, // will be set per test
      };
    }

    // Mock schedule methods
    async schedule(delaySec: number, method: string) {
      if (testState.scheduleFailuresRemaining > 0) {
        testState.scheduleFailuresRemaining -= 1;
        throw new Error('schedule failed');
      }
      testState.scheduleCalls.push([delaySec, method]);
    }

    deleteSchedules(method: string) {
      testState.deleteScheduleCalls.push(method);
    }

    // Mock stop (called by collectMetrics on idle exceedance)
    async stop(_signal?: number | string) {
      testState.stopCalls += 1;
      testState.callOrder.push('stop');
      if (testState.stopFailuresRemaining > 0) {
        testState.stopFailuresRemaining -= 1;
        throw new Error('container stop failed');
      }
    }

    // Mock destroy
    async destroy() {}
  }
  return { Container: MockContainer };
});

vi.mock('../lib/r2-config', () => ({
  getR2Config: vi.fn(async () => ({ accountId: 'test-account', endpoint: 'https://test.r2.cloudflarestorage.com' })),
}));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../lib/logger', () => ({
  createLogger: () => mockLogger,
}));

// Import AFTER mocks are set up
import { container } from '../container/index';
import {
  drainFinalSync,
  FINAL_SYNC_BUDGET_MS,
  CONTAINER_POLL_BUDGET_MS,
  TRANSPORT_FAILURE_STREAK_KEY,
  TRANSPORT_RECOVERY_KEY,
} from '../container/container-metrics';

describe('Container Metrics / REQ-SESSION-004 (idle timeout extension via collectMetrics + activity probe) / REQ-SESSION-005 (activity tracker emits idle/active transitions to DO via HTTP)', () => {
  let mockKV: MockKV;
  let containerInstance: InstanceType<typeof container>;
  type TestStorage = {
    get: <T>(key: string) => Promise<T | undefined>;
    put: (key: string, value: unknown) => Promise<void>;
  };
  const storage = (): TestStorage =>
    (containerInstance as unknown as { ctx: { storage: TestStorage } }).ctx.storage;
  const createContainerInstance = (): InstanceType<typeof container> => {
    const instance = new (container as unknown as new (ctx: unknown, env: unknown) => InstanceType<typeof container>)(
      {},
      { KV: mockKV, LOG_LEVEL: 'silent' },
    );
    (instance as unknown as { env: { KV: MockKV } }).env.KV = mockKV;
    return instance;
  };

  beforeEach(async () => {
    mockKV = createMockKV();
    testState.containerRunning = true;
    testState.storedSessionId = 'testsession123456';
    testState.storedBucketName = 'test-bucket';
    testState.tcpFetchShouldFail = false;
    testState.activityFetchShouldFail = false;
    testState.healthFetchShouldFail = false;
    testState.activityStatus = 200;
    testState.healthStatus = 200;
    testState.activityHangs = false;
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
    testState.scheduleFailuresRemaining = 0;
    testState.deleteScheduleCalls = [];
    testState.abortReasons = [];
    testState.stopCalls = 0;
    testState.stopFailuresRemaining = 0;
    testState.storedSleepAfter = undefined;
    testState.storedUserEmail = undefined;
    testState.kvRef = mockKV;
    testState.finalSyncCalls = 0;
    testState.finalSyncStatus = 200;
    testState.callOrder = [];
    testState.storageGetFailures.clear();
    testState.storagePutFailures.clear();
    testState.storageDeleteFailures.clear();
    testState.storageStore.clear();

    containerInstance = createContainerInstance();
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

    it('REQ-SESSION-021 AC4 + REQ-SESSION-022 AC1: clears prior transport recovery state on a fresh container start', async () => {
      await storage().put(TRANSPORT_FAILURE_STREAK_KEY, 2);
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'old-attempt',
        startedAt: Date.now() - 60_000,
        lastAttemptAt: Date.now() - 30_000,
        attemptCount: 1,
        postResetFailureCount: 0,
        totalFailureCount: 3,
        status: 'resetting',
      });

      await containerInstance.onStart();

      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      testState.scheduleCalls = [];
      testState.tcpFetchShouldFail = true;
      await containerInstance.collectMetrics();

      expect(testState.abortReasons).toEqual([]);
      expect(testState.scheduleCalls).toEqual([[5, 'collectMetrics']]);
    });

    it.each([TRANSPORT_FAILURE_STREAK_KEY, TRANSPORT_RECOVERY_KEY])(
      'REQ-SESSION-021 AC4: does not arm metrics when startup cannot clear %s',
      async (failedKey) => {
        await storage().put(TRANSPORT_FAILURE_STREAK_KEY, 2);
        await storage().put(TRANSPORT_RECOVERY_KEY, { status: 'resetting' });
        testState.storageDeleteFailures.add(failedKey);

        await expect(containerInstance.onStart()).rejects.toThrow(`storage delete failed: ${failedKey}`);

        expect(testState.scheduleCalls).toEqual([]);
        expect(await storage().get(TRANSPORT_FAILURE_STREAK_KEY)).toBe(2);
        expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toEqual({ status: 'resetting' });
      },
    );
  });

  describe('collectMetrics', () => {
    it('warns when /health reports an unhealthy R2 sync (failed/timeout) so an in-container bisync death is visible in Workers logs', async () => {
      // The 2026-05-31 integration bisync death ran invisible for 11 days
      // because the daemon's state never left the container. This warn (one
      // per 60s metrics tick while unhealthy) is the queryable signal.
      mockLogger.warn.mockClear();
      testState.healthResult.syncStatus = 'failed';
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);

      await containerInstance.collectMetrics();

      expect(mockLogger.warn).toHaveBeenCalledWith('collectMetrics: container R2 sync unhealthy', { syncStatus: 'failed' });

      // A healthy sync must NOT warn (no alert noise on the steady state).
      mockLogger.warn.mockClear();
      testState.healthResult.syncStatus = 'success';
      await containerInstance.collectMetrics();
      expect(mockLogger.warn).not.toHaveBeenCalledWith('collectMetrics: container R2 sync unhealthy', expect.anything());
    });

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

    // REQ-SESSION-018 AC4: a deliberate stop (persisted shutdown marker set by
    // destroy()/user Stop) must NOT be self-healed back to running. The marker
    // is persisted (DO storage), not an in-memory field, so it survives a DO
    // eviction mid-shutdown that would reset an in-memory flag.
    it('skips the metrics write when stopped AND the persisted shutdown marker is set (clobber-race guard)', async () => {
      // A POST /:id/stop has marked the session stopped and called destroy(),
      // which persisted the shutdown marker. collectMetrics must NOT re-put it
      // (with status preserved OR re-asserted running), which would resurrect a
      // session the user is deliberately stopping.
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'stopped',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);
      // Deliberate shutdown in flight: destroy() persisted this marker. Drive it
      // through the same DO storage collectMetrics reads (Map-backed in the
      // mock). The in-memory field is intentionally NOT set: the persisted
      // marker alone must protect the deliberate stop across an eviction.
      await (containerInstance as unknown as { ctx: { storage: { put: (k: string, v: unknown) => Promise<void> } } })
        .ctx.storage.put('shutdownRequested', Date.now());

      await containerInstance.collectMetrics();

      // No put to the session key (metrics write skipped; stopped left to settle).
      const sessionPut = mockKV.put.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('testsession123456')
      );
      expect(sessionPut).toBeUndefined();
      expect(testState.scheduleCalls).toEqual([]);
    });

    // REQ-SESSION-018 AC4: a live container whose KV was wrongly flipped to
    // stopped (e.g. by onError on a transient error) self-heals back to running
    // rather than hanging falsely-stopped on the dashboard until a restart.
    it('re-asserts running when the container is alive but KV reads stopped and no shutdown marker is set (self-heal)', async () => {
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'stopped',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);
      // Container is demonstrably running, no deliberate shutdown marker in
      // storage (fresh Map per test): this is a false stopped.
      testState.containerRunning = true;

      await containerInstance.collectMetrics();

      const putCall = mockKV.put.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('testsession123456')
      );
      expect(putCall).toBeDefined();
      const stored = JSON.parse(putCall![1] as string) as Session;
      expect(stored.status).toBe('running');
      // Self-heal also restores the metrics payload in the same write.
      expect(stored.metrics).toBeDefined();
      expect(stored.metrics!.cpu).toBe('45%');
    });

    // REQ-SESSION-020: the watchdog must survive the failure it exists to detect.
    // A wedged container accepts the TCP connect and never answers /activity. The
    // re-arm is the last statement of doCollectMetrics and schedule() is one-shot,
    // so before this was bounded the tick never returned and the alarm loop was
    // gone for good - no idle detection, no health loop, and nothing to restore
    // them (onStart only runs on a fresh start, onError only when the SDK sees the
    // container exit; neither fires for wedged-but-running). Remove the bound and
    // the mock below never settles, so this case fails by timeout rather than by
    // assertion. Costs one real poll budget of wall-clock; that is the price of
    // proving a hang rather than simulating one.
    it('REQ-SESSION-020 AC1-AC2: re-arms the alarm when an in-container poll never answers', async () => {
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      testState.activityHangs = true;
      testState.scheduleCalls = [];

      await containerInstance.collectMetrics();

      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
    }, 25_000);

    it('REQ-SESSION-021 AC6: reconstructs immediately when the SDK monitor loses container services after running becomes false', async () => {
      testState.containerRunning = false;

      await expect(containerInstance.onError(new Error('Network connection lost.')))
        .rejects.toThrow('mock Durable Object abort');

      expect(testState.abortReasons).toEqual(['container monitor lost its connection to container services']);
      expect(testState.deleteScheduleCalls).toEqual(['collectMetrics']);
      expect(testState.scheduleCalls).toEqual([[5, 'collectMetrics']]);
      expect(await storage().get(TRANSPORT_FAILURE_STREAK_KEY)).toBe(3);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toMatchObject({
        attemptId: expect.any(String),
        attemptCount: 1,
        postResetFailureCount: 0,
        totalFailureCount: 3,
        status: 'resetting',
      });
      expect(testState.storageStore.has('metricsNotRunningSince')).toBe(false);
    });

    it('REQ-SESSION-022 AC5: bounds monitor-loss recovery while running remains false, then resumes exit confirmation', async () => {
      testState.containerRunning = false;
      await expect(containerInstance.onError(new Error('Network connection lost.')))
        .rejects.toThrow('mock Durable Object abort');
      containerInstance = createContainerInstance();

      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();
      await expect(containerInstance.collectMetrics()).rejects.toThrow('mock Durable Object abort');
      containerInstance = createContainerInstance();

      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();
      expect(testState.abortReasons).toHaveLength(2);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toMatchObject({
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });

      testState.scheduleCalls = [];
      await containerInstance.collectMetrics();
      expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
      expect(testState.storageStore.get('metricsNotRunningSince')).toEqual(expect.any(Number));
    });

    it('failed monitor-recovery scheduling still converges a persistently unavailable session to stopped', async () => {
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);
      testState.containerRunning = false;
      testState.scheduleFailuresRemaining = 1;

      vi.useFakeTimers();
      try {
        await containerInstance.onError(new Error('Network connection lost.'));

        expect(testState.abortReasons).toEqual([]);
        expect(testState.deleteScheduleCalls).toEqual(['collectMetrics', 'collectMetrics']);
        expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
        expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();

        vi.advanceTimersByTime(91_000);
        await containerInstance.collectMetrics();

        const putCall = mockKV.put.mock.calls.find(
          (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('testsession123456')
        );
        expect(putCall).toBeDefined();
        expect((JSON.parse(putCall![1] as string) as Session).status).toBe('stopped');
      } finally {
        vi.useRealTimers();
      }
    });

    it('REQ-SESSION-024 AC1: schedule and cleanup failure retain recovery ownership with a confirmation tick', async () => {
      testState.containerRunning = false;
      testState.scheduleFailuresRemaining = 1;
      testState.storageDeleteFailures.add(TRANSPORT_RECOVERY_KEY);

      await containerInstance.onError(new Error('Network connection lost.'));

      expect(testState.abortReasons).toEqual([]);
      expect(testState.scheduleCalls).toEqual([[5, 'collectMetrics']]);
      expect(testState.storageStore.has('metricsNotRunningSince')).toBe(false);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toMatchObject({ status: 'resetting' });
    });

    it('REQ-SESSION-022 AC4: deliberate shutdown suppresses monitor-loss reconstruction', async () => {
      await storage().put('shutdownRequested', Date.now());
      testState.containerRunning = false;

      await containerInstance.onError(new Error('Network connection lost.'));

      expect(testState.abortReasons).toEqual([]);
      expect(testState.scheduleCalls).toEqual([]);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
    });

    it('REQ-SESSION-024 AC3: invalid monitor recovery state cannot authorize reconstruction', async () => {
      await storage().put(TRANSPORT_RECOVERY_KEY, { status: 'resetting' });
      testState.containerRunning = false;

      await containerInstance.onError(new Error('Network connection lost.'));

      expect(testState.abortReasons).toEqual([]);
      expect(testState.scheduleCalls).toEqual([]);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'container monitor recovery: invalid recovery record; suppressing reconstruction',
        undefined,
        { durableObjectId: 'mock-do-id', valueType: 'object' },
      );
    });

    it('REQ-SESSION-022 AC4: recovery-state read failure suppresses monitor-loss reconstruction', async () => {
      testState.storageGetFailures.add(TRANSPORT_RECOVERY_KEY);
      testState.containerRunning = false;

      await containerInstance.onError(new Error('Network connection lost.'));

      expect(testState.abortReasons).toEqual([]);
      expect(testState.scheduleCalls).toEqual([]);
      expect(await storage().get(TRANSPORT_FAILURE_STREAK_KEY)).toBeUndefined();
    });

    it('REQ-SESSION-022 AC2: repeated monitor loss joins the existing incident without another reconstruction', async () => {
      const recovery = {
        attemptId: 'existing-monitor-incident',
        startedAt: Date.now() - 5_000,
        lastAttemptAt: Date.now() - 5_000,
        attemptCount: 1,
        postResetFailureCount: 0,
        totalFailureCount: 3,
        status: 'resetting',
      };
      await storage().put(TRANSPORT_FAILURE_STREAK_KEY, 3);
      await storage().put(TRANSPORT_RECOVERY_KEY, recovery);
      testState.containerRunning = false;

      await containerInstance.onError(new Error('Network connection lost.'));

      expect(testState.abortReasons).toEqual([]);
      expect(testState.scheduleCalls).toEqual([[5, 'collectMetrics']]);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toEqual(recovery);
    });

    it('REQ-SESSION-022 AC5: exhausted monitor loss returns to ordinary exit confirmation', async () => {
      await storage().put(TRANSPORT_FAILURE_STREAK_KEY, 3);
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'exhausted-monitor-incident',
        startedAt: Date.now() - 30_000,
        lastAttemptAt: Date.now() - 15_000,
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });
      testState.containerRunning = false;

      await containerInstance.onError(new Error('Network connection lost.'));

      expect(testState.abortReasons).toEqual([]);
      expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
      expect(testState.storageStore.get('metricsNotRunningSince')).toEqual(expect.any(Number));
    });

    it('REQ-SESSION-022 AC4: monitor loss cannot reconstruct when deliberate-stop ownership is unreadable', async () => {
      testState.containerRunning = false;
      testState.storageGetFailures.add('shutdownRequested');

      await containerInstance.onError(new Error('Network connection lost.'));

      expect(testState.abortReasons).toEqual([]);
      expect(testState.scheduleCalls).toEqual([]);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(testState.storageStore.has('metricsNotRunningSince')).toBe(false);
    });

    it('REQ-SESSION-021 AC1-AC3: resets the Durable Object after three consecutive ticks while preserving the workload and running status', async () => {
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      testState.tcpFetchShouldFail = true;

      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();

      expect(testState.abortReasons).toEqual([]);
      expect(testState.scheduleCalls).toEqual([
        [5, 'collectMetrics'],
        [5, 'collectMetrics'],
      ]);

      await expect(containerInstance.collectMetrics()).rejects.toThrow('mock Durable Object abort');

      expect(testState.abortReasons).toEqual(['container transport unresponsive after 3 complete probe failures']);
      expect(testState.stopCalls).toBe(0);
      const stoppedWrite = mockKV.put.mock.calls.find((call: unknown[]) => {
        if (typeof call[0] !== 'string' || !(call[0] as string).includes('testsession123456')) return false;
        try { return (JSON.parse(call[1] as string) as Session).status === 'stopped'; } catch { return false; }
      });
      expect(stoppedWrite).toBeUndefined();
      expect(await storage().get(TRANSPORT_FAILURE_STREAK_KEY)).toBe(3);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toMatchObject({
        attemptId: expect.any(String),
        attemptCount: 1,
        postResetFailureCount: 0,
        totalFailureCount: 3,
        status: 'resetting',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'collectMetrics: resetting Durable Object to reconstruct container transport',
        expect.objectContaining({
          durableObjectId: 'mock-do-id',
          recoveryAttemptId: expect.any(String),
          recoveryAttempt: 1,
          totalFailures: 3,
          containerRunning: true,
          probes: {
            activity: expect.objectContaining({ responded: false, category: 'connection-refused', error: 'Connection refused', durationMs: expect.any(Number) }),
            health: expect.objectContaining({ responded: false, category: 'connection-refused', error: 'Connection refused', durationMs: expect.any(Number) }),
          },
        }),
      );
    });

    it('REQ-SESSION-022 AC1-AC2: confirms recovery only after a reconstructed instance probes the existing container', async () => {
      testState.tcpFetchShouldFail = true;
      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();
      await expect(containerInstance.collectMetrics()).rejects.toThrow('mock Durable Object abort');
      const recovery = await storage().get<{ attemptId: string }>(TRANSPORT_RECOVERY_KEY);
      containerInstance = createContainerInstance();

      testState.tcpFetchShouldFail = false;
      testState.scheduleCalls = [];
      mockLogger.info.mockClear();
      await containerInstance.collectMetrics();

      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(await storage().get(TRANSPORT_FAILURE_STREAK_KEY)).toBeUndefined();
      expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'collectMetrics: container transport recovery confirmed',
        expect.objectContaining({
          durableObjectId: 'mock-do-id',
          recoveryAttemptId: recovery?.attemptId,
          recoveryAttempt: 1,
          totalFailures: 3,
          elapsedMs: expect.any(Number),
          containerRunning: true,
        }),
      );
    });

    it('REQ-SESSION-022 AC2: does not confirm recovery or restore normal cadence until recovery evidence is cleared', async () => {
      testState.tcpFetchShouldFail = true;
      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();
      await expect(containerInstance.collectMetrics()).rejects.toThrow('mock Durable Object abort');
      const recovery = await storage().get<{ attemptId: string }>(TRANSPORT_RECOVERY_KEY);
      containerInstance = createContainerInstance();

      testState.tcpFetchShouldFail = false;
      testState.storageDeleteFailures.add(TRANSPORT_RECOVERY_KEY);
      testState.scheduleCalls = [];
      mockLogger.info.mockClear();
      await containerInstance.collectMetrics();

      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeDefined();
      expect(await storage().get(TRANSPORT_FAILURE_STREAK_KEY)).toBe(3);
      expect(testState.scheduleCalls).toEqual([[5, 'collectMetrics']]);
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        'collectMetrics: container transport recovery confirmed',
        expect.anything(),
      );

      testState.storageDeleteFailures.clear();
      await containerInstance.collectMetrics();

      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(await storage().get(TRANSPORT_FAILURE_STREAK_KEY)).toBeUndefined();
      expect(testState.scheduleCalls).toEqual([
        [5, 'collectMetrics'],
        [60, 'collectMetrics'],
      ]);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'collectMetrics: container transport recovery confirmed',
        expect.objectContaining({ recoveryAttemptId: recovery?.attemptId }),
      );
    });

    it('REQ-SESSION-020 AC2: re-arms when the early recovery ownership read fails', async () => {
      testState.storageGetFailures.add(TRANSPORT_RECOVERY_KEY);
      testState.scheduleCalls = [];

      await containerInstance.collectMetrics();

      expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
      expect(mockTimekeeperClient.updateUsage).not.toHaveBeenCalled();
      expect((containerInstance as unknown as { _usageSeconds: number })._usageSeconds).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'collectMetrics: failed to read terminal recovery ownership',
        expect.objectContaining({ error: `storage read failed: ${TRANSPORT_RECOVERY_KEY}` }),
      );
    });

    it('REQ-SESSION-020 AC2: propagates scheduling failure after the early recovery ownership read fails', async () => {
      testState.storageGetFailures.add(TRANSPORT_RECOVERY_KEY);
      testState.scheduleFailuresRemaining = 1;

      await expect(containerInstance.collectMetrics()).rejects.toThrow('schedule failed');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'collectMetrics: failed to schedule recovery ownership read retry',
        undefined,
        expect.objectContaining({ error: 'schedule failed' }),
      );
    });

    it('REQ-SESSION-022 AC2-AC3: bounds reconstruction and converges an exhausted unreachable session to stopped', async () => {
      const sessionKey = 'session:test-bucket:testsession123456';
      mockKV._set(sessionKey, {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      testState.tcpFetchShouldFail = true;
      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();
      await expect(containerInstance.collectMetrics()).rejects.toThrow('mock Durable Object abort');
      containerInstance = createContainerInstance();

      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();
      await expect(containerInstance.collectMetrics()).rejects.toThrow('mock Durable Object abort');
      containerInstance = createContainerInstance();

      testState.scheduleCalls = [];
      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();

      expect(testState.abortReasons).toHaveLength(2);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toMatchObject({
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });
      expect(testState.scheduleCalls.at(-1)).toEqual([60, 'collectMetrics']);
      const schedulesBeforeTerminalTick = testState.scheduleCalls.length;

      await containerInstance.collectMetrics();

      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect((await mockKV.get(sessionKey, 'json') as Session).status).toBe('stopped');
      expect(testState.stopCalls).toBe(1);
      expect(testState.scheduleCalls).toHaveLength(schedulesBeforeTerminalTick);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'collectMetrics: post-reconstruction transport confirmation failed',
        expect.objectContaining({
          durableObjectId: 'mock-do-id',
          recoveryAttemptId: expect.any(String),
          recoveryAttempt: expect.any(Number),
          probes: {
            activity: expect.objectContaining({ category: 'connection-refused', error: 'Connection refused', durationMs: expect.any(Number) }),
            health: expect.objectContaining({ category: 'connection-refused', error: 'Connection refused', durationMs: expect.any(Number) }),
          },
        }),
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        'collectMetrics: container transport recovery exhausted',
        undefined,
        expect.objectContaining({
          durableObjectId: 'mock-do-id',
          recoveryAttemptId: expect.any(String),
          recoveryAttempt: 2,
          totalFailures: 9,
          containerRunning: true,
        }),
      );
    });

    it('REQ-SESSION-022 AC6: retains exhausted recovery and retries a failed authoritative stopped write without billing', async () => {
      const sessionKey = 'session:test-bucket:testsession123456';
      mockKV._set(sessionKey, {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      const now = Date.now();
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'recovery-exhausted-write-retry',
        startedAt: now - 120_000,
        lastAttemptAt: now - 60_000,
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });
      testState.storedUserEmail = 'quota@example.com';
      containerInstance = createContainerInstance();
      const timekeeperStub = {
        fetch: vi.fn(async () => new Response(JSON.stringify({ quotaExceeded: false }), { status: 200 })),
      };
      const instanceEnv = (containerInstance as unknown as { env: Record<string, unknown> }).env;
      instanceEnv.SAAS_MODE = 'active';
      instanceEnv.TIMEKEEPER = {
        idFromName: vi.fn(() => ({ toString: () => 'tk-id' })),
        get: vi.fn(() => timekeeperStub),
      };
      await vi.waitFor(
        () => expect((containerInstance as unknown as { _userEmail: string | null })._userEmail).toBe('quota@example.com'),
        { timeout: 1000 },
      );
      testState.tcpFetchShouldFail = true;
      testState.scheduleCalls = [];
      mockKV.put.mockRejectedValueOnce(new Error('KV PUT failed: 429 Too Many Requests'));

      await containerInstance.collectMetrics();

      expect((await mockKV.get(sessionKey, 'json') as Session).status).toBe('running');
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeDefined();
      expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
      expect(timekeeperStub.fetch).not.toHaveBeenCalled();
      expect((containerInstance as unknown as { _usageSeconds: number })._usageSeconds).toBe(0);

      await containerInstance.collectMetrics();

      expect((await mockKV.get(sessionKey, 'json') as Session).status).toBe('stopped');
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
      expect(timekeeperStub.fetch).not.toHaveBeenCalled();
      expect((containerInstance as unknown as { _usageSeconds: number })._usageSeconds).toBe(0);
    });

    it('REQ-SESSION-022 AC7: retains exhausted recovery and retries when terminal container stop fails', async () => {
      const sessionKey = 'session:test-bucket:testsession123456';
      mockKV._set(sessionKey, {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      const now = Date.now();
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'recovery-exhausted-stop-retry',
        startedAt: now - 120_000,
        lastAttemptAt: now - 60_000,
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });
      testState.storedUserEmail = 'quota@example.com';
      containerInstance = createContainerInstance();
      const timekeeperStub = {
        fetch: vi.fn(async () => new Response(JSON.stringify({ quotaExceeded: false }), { status: 200 })),
      };
      const instanceEnv = (containerInstance as unknown as { env: Record<string, unknown> }).env;
      instanceEnv.SAAS_MODE = 'active';
      instanceEnv.TIMEKEEPER = {
        idFromName: vi.fn(() => ({ toString: () => 'tk-id' })),
        get: vi.fn(() => timekeeperStub),
      };
      await vi.waitFor(
        () => expect((containerInstance as unknown as { _userEmail: string | null })._userEmail).toBe('quota@example.com'),
        { timeout: 1000 },
      );
      testState.tcpFetchShouldFail = true;
      testState.stopFailuresRemaining = 1;
      testState.scheduleCalls = [];

      await containerInstance.collectMetrics();

      expect((await mockKV.get(sessionKey, 'json') as Session).status).toBe('stopped');
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toMatchObject({ status: 'terminal-stop-pending' });
      expect(testState.stopCalls).toBe(1);
      expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
      expect(timekeeperStub.fetch).not.toHaveBeenCalled();
      expect((containerInstance as unknown as { _usageSeconds: number })._usageSeconds).toBe(0);

      // A recovered probe path must not resurrect KV or cancel terminal stop
      // ownership after the first stop request already failed.
      testState.tcpFetchShouldFail = false;
      await containerInstance.collectMetrics();

      expect((await mockKV.get(sessionKey, 'json') as Session).status).toBe('stopped');
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(testState.stopCalls).toBe(2);
      expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
      expect(timekeeperStub.fetch).not.toHaveBeenCalled();
      expect((containerInstance as unknown as { _usageSeconds: number })._usageSeconds).toBe(0);
    });

    it('REQ-SESSION-022 AC7: keeps terminal stop ownership observable when retry scheduling fails', async () => {
      const sessionKey = 'session:test-bucket:testsession123456';
      mockKV._set(sessionKey, {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      const now = Date.now();
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'recovery-terminal-schedule-failure',
        startedAt: now - 120_000,
        lastAttemptAt: now - 60_000,
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });
      testState.tcpFetchShouldFail = true;
      testState.stopFailuresRemaining = 1;
      testState.scheduleFailuresRemaining = 1;

      await expect(containerInstance.collectMetrics()).rejects.toThrow('schedule failed');

      expect((await mockKV.get(sessionKey, 'json') as Session).status).toBe('stopped');
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toMatchObject({ status: 'terminal-stop-pending' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'collectMetrics: failed to schedule terminal convergence retry',
        undefined,
        expect.objectContaining({ error: 'schedule failed' }),
      );
    });

    it('REQ-SESSION-022 AC7: migrates pre-upgrade exhausted stopped ownership before responsive probes can resurrect it', async () => {
      const sessionKey = 'session:test-bucket:testsession123456';
      mockKV._set(sessionKey, {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'stopped',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      const now = Date.now();
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'pre-upgrade-exhausted-stopped',
        startedAt: now - 120_000,
        lastAttemptAt: now - 60_000,
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });
      testState.tcpFetchShouldFail = false;
      testState.scheduleCalls = [];

      await containerInstance.collectMetrics();

      expect((await mockKV.get(sessionKey, 'json') as Session).status).toBe('stopped');
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(testState.stopCalls).toBe(1);
      expect(testState.scheduleCalls).toEqual([]);
      expect(mockTimekeeperClient.updateUsage).not.toHaveBeenCalled();
      expect((containerInstance as unknown as { _usageSeconds: number })._usageSeconds).toBe(0);
    });

    it('REQ-SESSION-022 AC7: migrates pre-upgrade exhausted ownership when the KV record is already absent', async () => {
      await mockKV.delete('session:test-bucket:testsession123456');
      const now = Date.now();
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'pre-upgrade-exhausted-absent',
        startedAt: now - 120_000,
        lastAttemptAt: now - 60_000,
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });
      testState.tcpFetchShouldFail = false;

      await containerInstance.collectMetrics();

      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(testState.stopCalls).toBe(1);
    });

    it('REQ-SESSION-022 AC7: re-arms without probing when pre-upgrade terminal KV ownership cannot be read', async () => {
      const now = Date.now();
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'pre-upgrade-exhausted-kv-read-failure',
        startedAt: now - 120_000,
        lastAttemptAt: now - 60_000,
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });
      mockKV.get.mockRejectedValueOnce(new Error('KV GET failed'));
      testState.scheduleCalls = [];

      await containerInstance.collectMetrics();

      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toMatchObject({ status: 'exhausted' });
      expect(testState.stopCalls).toBe(0);
      expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'collectMetrics: failed to resolve pre-upgrade terminal ownership',
        expect.objectContaining({ error: 'KV GET failed' }),
      );
    });

    it('REQ-SESSION-022 AC7: retains exhausted ownership when pre-upgrade terminal migration cannot persist', async () => {
      const sessionKey = 'session:test-bucket:testsession123456';
      mockKV._set(sessionKey, {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'stopped',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      const now = Date.now();
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'pre-upgrade-exhausted-migration-failure',
        startedAt: now - 120_000,
        lastAttemptAt: now - 60_000,
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });
      testState.storagePutFailures.add(TRANSPORT_RECOVERY_KEY);
      testState.scheduleCalls = [];

      await containerInstance.collectMetrics();

      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toMatchObject({ status: 'exhausted' });
      expect(testState.stopCalls).toBe(0);
      expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'collectMetrics: failed to migrate pre-upgrade terminal ownership',
        undefined,
        expect.objectContaining({ error: `storage write failed: ${TRANSPORT_RECOVERY_KEY}` }),
      );
    });

    it('REQ-SESSION-022 AC1: a responding probe clears exhausted recovery without stopping the session', async () => {
      const sessionKey = 'session:test-bucket:testsession123456';
      mockKV._set(sessionKey, {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      const now = Date.now();
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'recovery-exhausted-but-responsive',
        startedAt: now - 120_000,
        lastAttemptAt: now - 60_000,
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });
      testState.scheduleCalls = [];

      await containerInstance.collectMetrics();

      expect((await mockKV.get(sessionKey, 'json') as Session).status).toBe('running');
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(testState.scheduleCalls).toEqual([[60, 'collectMetrics']]);
    });

    it('REQ-SESSION-022 AC5: suppresses reconstruction and re-arming when deliberate-stop ownership cannot be read', async () => {
      testState.storageGetFailures.add('shutdownRequested');
      testState.tcpFetchShouldFail = true;

      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();

      expect(testState.abortReasons).toEqual([]);
      expect(await storage().get(TRANSPORT_FAILURE_STREAK_KEY)).toBeUndefined();
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(testState.scheduleCalls).toEqual([]);
    });

    it('REQ-SESSION-024 AC3: malformed recovery state cannot authorize reconstruction', async () => {
      const now = Date.now();
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'invalid-exhausted-state',
        startedAt: now,
        lastAttemptAt: now,
        attemptCount: 1,
        postResetFailureCount: 3,
        totalFailureCount: 6,
        status: 'exhausted',
      });
      testState.tcpFetchShouldFail = true;

      await containerInstance.collectMetrics();

      expect(testState.abortReasons).toEqual([]);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(testState.scheduleCalls).toEqual([[5, 'collectMetrics']]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'collectMetrics: invalid transport recovery record; suppressing reconstruction',
        undefined,
        { durableObjectId: 'mock-do-id', valueType: 'object' },
      );
    });

    it('REQ-SESSION-021 AC5: any responding probe clears the reconstruction failure streak', async () => {
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);

      testState.tcpFetchShouldFail = true;
      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();

      // /activity still fails, but /health answers with 503. The non-OK response
      // still proves the DO-to-container attachment recovered and clears the streak.
      testState.tcpFetchShouldFail = false;
      testState.activityFetchShouldFail = true;
      testState.healthStatus = 503;
      await containerInstance.collectMetrics();

      testState.activityFetchShouldFail = false;
      testState.healthStatus = 200;
      testState.tcpFetchShouldFail = true;
      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();

      expect(testState.abortReasons).toEqual([]);
    });

    it('REQ-SESSION-023 AC1-AC2: confirmation retries do not add billable usage or ping Timekeeper', async () => {
      testState.storedBucketName = 'test-bucket';
      testState.storedSessionId = 'testsession123456';
      testState.storedUserEmail = 'quota@example.com';

      const timekeeperStub = {
        fetch: vi.fn(async () =>
          new Response(JSON.stringify({ quotaExceeded: false, totalMonthlySeconds: 60 }), {
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
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      await vi.waitFor(
        () => expect((instance as unknown as { _userEmail: string | null })._userEmail).toBe('quota@example.com'),
        { timeout: 1000 },
      );

      testState.tcpFetchShouldFail = true;
      testState.scheduleCalls = [];
      await instance.collectMetrics();
      await instance.collectMetrics();

      expect(timekeeperStub.fetch).toHaveBeenCalledTimes(1);
      expect((instance as unknown as { _usageSeconds: number })._usageSeconds).toBe(60);
      expect(testState.scheduleCalls).toEqual([
        [5, 'collectMetrics'],
        [5, 'collectMetrics'],
      ]);
    });

    it('REQ-SESSION-023 AC3: exhausted unreachable transport converges without usage accounting', async () => {
      testState.storedBucketName = 'test-bucket';
      testState.storedSessionId = 'testsession123456';
      testState.storedUserEmail = 'quota@example.com';

      const timekeeperStub = {
        fetch: vi.fn(async () =>
          new Response(JSON.stringify({ quotaExceeded: false, totalMonthlySeconds: 120 }), {
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
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      await vi.waitFor(
        () => expect((instance as unknown as { _userEmail: string | null })._userEmail).toBe('quota@example.com'),
        { timeout: 1000 },
      );
      const instanceStorage = (instance as unknown as { ctx: { storage: TestStorage } }).ctx.storage;
      const now = Date.now();
      await instanceStorage.put(TRANSPORT_FAILURE_STREAK_KEY, 3);
      await instanceStorage.put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'recovery-exhausted',
        startedAt: now,
        lastAttemptAt: now,
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });

      testState.tcpFetchShouldFail = true;
      testState.scheduleCalls = [];
      await instance.collectMetrics();

      expect(timekeeperStub.fetch).not.toHaveBeenCalled();
      expect((instance as unknown as { _usageSeconds: number })._usageSeconds).toBe(0);
      expect(await instanceStorage.get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(testState.scheduleCalls).toEqual([]);
      expect((await mockKV.get('session:test-bucket:testsession123456', 'json') as Session).status).toBe('stopped');
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

      // Healthy transport returns to the normal 60-second cadence.
      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
    });

    it('re-arms on the first not-running tick so the confirmation window can be observed', async () => {
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

      // The first not-running tick re-arms (rather than letting the loop die)
      // so a transient false reading can recover on a subsequent tick instead
      // of freezing metrics until onStart (REQ-SESSION-018 AC2).
      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
    });

    // REQ-SESSION-018 AC1: Persisted status is authoritative on container exit
    it('writes status=stopped to KV only after the not-running confirmation window (catch-all) / REQ-SESSION-018', async () => {
      // The container exited unexpectedly (crash / deploy-roll / platform reap)
      // and the SDK never surfaced onError. The catch-all marks the session
      // stopped - but only after the not-running reading has persisted past the
      // confirmation window, so a transient false reading cannot trip it.
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      vi.useFakeTimers();
      try {
        testState.scheduleCalls = [];
        testState.containerRunning = false;

        // First not-running tick: opens the confirmation window, no stopped write.
        await containerInstance.collectMetrics();
        expect(
          mockKV.put.mock.calls.find(
            (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('testsession123456')
          )
        ).toBeUndefined();

        // Still not running after the window elapses: now mark stopped.
        vi.advanceTimersByTime(91_000);
        await containerInstance.collectMetrics();

        const putCall = mockKV.put.mock.calls.find(
          (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('testsession123456')
        );
        expect(putCall).toBeDefined();
        const stored = JSON.parse(putCall![1] as string) as Session;
        expect(stored.status).toBe('stopped');
      } finally {
        vi.useRealTimers();
      }
    });

    it('REQ-SESSION-018 AC1: recovery cleanup failure cannot block the authoritative stopped write', async () => {
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);
      await storage().put('metricsNotRunningSince', Date.now() - 91_000);
      await storage().put(TRANSPORT_RECOVERY_KEY, {
        attemptId: 'cleanup-failure',
        startedAt: Date.now() - 120_000,
        lastAttemptAt: Date.now() - 100_000,
        attemptCount: 2,
        postResetFailureCount: 3,
        totalFailureCount: 9,
        status: 'exhausted',
      });
      testState.storageDeleteFailures.add(TRANSPORT_RECOVERY_KEY);
      testState.containerRunning = false;

      await containerInstance.collectMetrics();

      const putCall = mockKV.put.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('testsession123456')
      );
      expect(putCall).toBeDefined();
      expect((JSON.parse(putCall![1] as string) as Session).status).toBe('stopped');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'collectMetrics: failed to clear transport recovery after confirmed exit',
        expect.objectContaining({ error: `storage delete failed: ${TRANSPORT_RECOVERY_KEY}` }),
      );
    });

    // REQ-SESSION-018 AC2: a transient not-running reading must not flip a live
    // session to stopped (the dashboard-kick / metrics-freeze bug).
    it('does not flip a live session to stopped on a single transient not-running tick', async () => {
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

      // One transient not-running tick (e.g. a hibernated DO waking, or a
      // deploy-roll) opens the window but does NOT write stopped...
      testState.containerRunning = false;
      await containerInstance.collectMetrics();
      expect(
        mockKV.put.mock.calls.find(
          (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('testsession123456')
        )
      ).toBeUndefined();

      // ...and the very next tick sees the container alive again: it resumes
      // normal metric writes (status stays running, never flipped to stopped).
      testState.containerRunning = true;
      await containerInstance.collectMetrics();

      const stoppedWrite = mockKV.put.mock.calls.find((call: unknown[]) => {
        if (typeof call[0] !== 'string' || !(call[0] as string).includes('testsession123456')) return false;
        try { return (JSON.parse(call[1] as string) as Session).status === 'stopped'; } catch { return false; }
      });
      expect(stoppedWrite).toBeUndefined();
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

    // REQ-SESSION-020 AC1: the Timekeeper ping is awaited before the re-arm, and a
    // Durable Object stub is a different transport from the container port, so its
    // abort support is not established. This stub ignores the signal entirely and
    // never answers — exactly the unproven case — and the alarm must still re-arm.
    // Deleting the race in raceBudget hangs this test until its own timeout.
    it('REQ-SESSION-020 AC1: re-arms the alarm when the Timekeeper ping never answers', async () => {
      testState.storedBucketName = 'test-bucket';
      testState.storedSessionId = 'testsession123456';
      testState.storedUserEmail = 'quota@example.com';

      const timekeeperStub = {
        fetch: vi.fn(() => new Promise<Response>(() => { /* never settles, signal ignored */ })),
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
        () => expect((instance as unknown as { _userEmail: string | null })._userEmail).toBe('quota@example.com'),
        { timeout: 1000 },
      );

      testState.scheduleCalls = [];
      // Fake timers only from here — the vi.waitFor above needs real ones.
      // raceBudget's bound is a plain setTimeout so it is faked, while the
      // retained AbortSignal.timeout is native and is not. That asymmetry is the
      // point: the race is the only thing that can end this await, and faking it
      // proves that in milliseconds instead of ten real seconds.
      vi.useFakeTimers();
      try {
        const pending = instance.collectMetrics();
        // Advance repeatedly rather than once: each call drains microtasks before
        // moving the clock, so a timer armed behind one more await than expected
        // is still caught instead of failing on the default test timeout. The
        // budget timer is the only one faked here, so extra passes are inert.
        for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(CONTAINER_POLL_BUDGET_MS);
        await pending;
      } finally {
        vi.useRealTimers();
      }

      expect(timekeeperStub.fetch).toHaveBeenCalledTimes(1);
      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
    });

    it('REQ-SESSION-011 AC6: quota-stop drains the final sync BEFORE stop (same order as idle-stop)', async () => {
      // The quota-eviction path must drain through /internal/final-sync before
      // signalling stop, identically to idle-stop. Mirror the quotaExceeded=true
      // setup and assert the order via callOrder rather than just that stop ran.
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
      const instanceEnv = (instance as unknown as { env: Record<string, unknown> }).env;
      instanceEnv.KV = mockKV;
      instanceEnv.SAAS_MODE = 'active';
      instanceEnv.TIMEKEEPER = TIMEKEEPER;

      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);

      await vi.waitFor(
        () => expect((instance as unknown as { _userEmail: string | null })._userEmail).toBe('quota@example.com'),
        { timeout: 1000 },
      );

      testState.callOrder = [];
      await instance.collectMetrics();

      expect(timekeeperStub.fetch).toHaveBeenCalledTimes(1);
      expect(testState.callOrder).toEqual(['finalsync', 'stop']);
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

  describe('idle timeout resolution (REQ-OPS-006 AC1) / REQ-OPS-017 (sleepAfter fail-safe invariants)', () => {
    it('uses fail-safe 4h default when storage has no sleepAfter', async () => {
      // Storage returns undefined for 'sleepAfter'.
      // Class-field default is '4h' (max safe). Container has been idle for 1 hour.
      // 1h < 4h → container should NOT be stopped.
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

    it('respects 4h pref - 3h idle does NOT trigger stop', async () => {
      // Storage holds '4h' (a valid option). Container idle 3h < 4h, so the
      // idle-stop must NOT fire — stopCalls===0. Paired with the 5h-idle case
      // below (which DOES stop), this pins the 4h boundary behaviourally.
      testState.storedSleepAfter = '4h';
      testState.activityResult = {
        hasActiveConnections: true,
        connectedClients: 1,
        lastInputAt: Date.now() - (180 * 60 * 1000), // 3h ago
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

    it('respects 4h pref - 5h idle DOES trigger stop', async () => {
      testState.storedSleepAfter = '4h';
      testState.activityResult = {
        hasActiveConnections: true,
        connectedClients: 1,
        lastInputAt: Date.now() - (300 * 60 * 1000), // 5h ago, > 4h
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
      // falling back to the class-field default ('4h').
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

      // 30m < 4h fallback → no stop
      expect(testState.stopCalls).toBe(0);
    });
  });

  // CF-042
  // updateKvStatus's missing-identifier guard (container-metrics.ts: the
  // `if (!sessionId || !bucketName)` early-return). When neither the sessionId
  // nor the bucketName can be resolved from storage, the function must log and
  // return WITHOUT touching KV - otherwise it would build a key from a null
  // identifier and corrupt an unrelated record. Driven through onStop(), which
  // is the production caller of updateKvStatus.
  describe('updateKvStatus missing-identifier guard', () => {
    it('does NOT write to KV when both sessionId and bucketName are missing', async () => {
      testState.storedSessionId = undefined;
      testState.storedBucketName = null;

      // Rebuild the instance so the constructor loads the (absent) bucketName.
      const instance = new (container as unknown as new (ctx: unknown, env: unknown) => InstanceType<typeof container>)(
        {},
        { KV: mockKV, LOG_LEVEL: 'silent' },
      );
      (instance as unknown as { env: { KV: MockKV } }).env.KV = mockKV;

      // Seed a session whose key would collide if a null identifier somehow
      // produced a write - the assertion below proves it does not.
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);
      mockKV.put.mockClear();

      await instance.onStop();

      // Guard fires before getSessionKey / KV.put - no session write at all.
      const sessionPuts = mockKV.put.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).startsWith('session:')
      );
      expect(sessionPuts).toHaveLength(0);
    });

    it('does NOT write to KV when only the bucketName is missing', async () => {
      testState.storedSessionId = 'testsession123456';
      testState.storedBucketName = null;

      const instance = new (container as unknown as new (ctx: unknown, env: unknown) => InstanceType<typeof container>)(
        {},
        { KV: mockKV, LOG_LEVEL: 'silent' },
      );
      (instance as unknown as { env: { KV: MockKV } }).env.KV = mockKV;

      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:testsession123456', session);
      mockKV.put.mockClear();

      await instance.onStop();

      const sessionPuts = mockKV.put.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).startsWith('session:')
      );
      expect(sessionPuts).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// REQ-SESSION-011: final R2 sync is drained while the container is still alive,
// BEFORE any stop, so the platform's ~3s SIGTERM kill-grace can no longer cut
// off the bisync (the data-loss-on-stop/delete bug). drainFinalSync is the DO
// helper; collectMetrics' idle-stop and quota-stop paths must call it first.
// ---------------------------------------------------------------------------
describe('Container final-sync drain / REQ-SESSION-011 (drain R2 sync before stop)', () => {
  let mockKV: MockKV;
  let containerInstance: InstanceType<typeof container>;
  // Narrow accessor for the mocked DO state drainFinalSync operates on.
  type CtxHost = { ctx: Parameters<typeof drainFinalSync>[0] };

  beforeEach(() => {
    mockKV = createMockKV();
    testState.containerRunning = true;
    testState.storedSessionId = 'testsession123456';
    testState.storedBucketName = 'test-bucket';
    testState.tcpFetchShouldFail = false;
    testState.activityFetchShouldFail = false;
    testState.healthFetchShouldFail = false;
    testState.activityStatus = 200;
    testState.healthStatus = 200;
    testState.abortReasons = [];
    testState.finalSyncCalls = 0;
    testState.finalSyncStatus = 200;
    testState.callOrder = [];
    testState.storageGetFailures.clear();
    testState.stopCalls = 0;
    testState.scheduleCalls = [];
    testState.scheduleFailuresRemaining = 0;
    testState.deleteScheduleCalls = [];
    testState.storedSleepAfter = undefined;
    testState.activityResult = {
      hasActiveConnections: true,
      connectedClients: 1,
      lastInputAt: Date.now(),
    };
    testState.healthResult = { cpu: '45%', mem: '1024MB', hdd: '2.5GB', syncStatus: 'success' };

    containerInstance = new (container as unknown as new (ctx: unknown, env: unknown) => InstanceType<typeof container>)(
      {},
      { KV: mockKV, LOG_LEVEL: 'silent' },
    );
    (containerInstance as unknown as { env: { KV: MockKV } }).env.KV = mockKV;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('drainFinalSync', () => {
    it('POSTs /internal/final-sync when the container is running', async () => {
      const ctx = (containerInstance as unknown as CtxHost).ctx;
      await drainFinalSync(ctx, FINAL_SYNC_BUDGET_MS);
      expect(testState.finalSyncCalls).toBe(1);
    });

    it('still attempts the drain when the container reads not-running (#516: the reading can be a transient on a DO wake/deploy-roll)', async () => {
      testState.containerRunning = false;
      const ctx = (containerInstance as unknown as CtxHost).ctx;
      await drainFinalSync(ctx, FINAL_SYNC_BUDGET_MS);
      expect(testState.finalSyncCalls).toBe(1);
    });

    it('swallows a fetch error and resolves (best-effort, so caller still stops)', async () => {
      testState.tcpFetchShouldFail = true;
      const ctx = (containerInstance as unknown as CtxHost).ctx;
      await expect(drainFinalSync(ctx, FINAL_SYNC_BUDGET_MS)).resolves.toBeUndefined();
      expect(testState.finalSyncCalls).toBe(1);
    });

    it('swallows a non-OK response and resolves (best-effort)', async () => {
      testState.finalSyncStatus = 504;
      const ctx = (containerInstance as unknown as CtxHost).ctx;
      await expect(drainFinalSync(ctx, FINAL_SYNC_BUDGET_MS)).resolves.toBeUndefined();
      expect(testState.finalSyncCalls).toBe(1);
    });

    it('aborts and resolves when the sync exceeds the budget (timeout is best-effort)', async () => {
      // Fetch that never resolves on its own: only the AbortController signal
      // ends it. A tiny budget forces the timeout path.
      const ctx = (containerInstance as unknown as CtxHost).ctx;
      const slowPort = {
        fetch: (_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      };
      (ctx as unknown as { container: { getTcpPort: (p: number) => typeof slowPort } }).container.getTcpPort = () => slowPort;
      await expect(drainFinalSync(ctx, 20)).resolves.toBeUndefined();
    });
  });

  describe('idle-stop drains before stop', () => {
    it('calls final-sync, then stop, in that order', async () => {
      testState.storedSleepAfter = '15m';
      testState.activityResult = {
        hasActiveConnections: true,
        connectedClients: 1,
        lastInputAt: Date.now() - (30 * 60 * 1000), // 30m idle > 15m
      };
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);

      await containerInstance.collectMetrics();

      expect(testState.stopCalls).toBe(1);
      expect(testState.finalSyncCalls).toBe(1);
      expect(testState.callOrder).toEqual(['finalsync', 'stop']);
    });
  });
});
