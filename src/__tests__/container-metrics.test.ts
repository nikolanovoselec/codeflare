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
  // REQ-SESSION-011: POST /internal/final-sync (drainFinalSync). finalSyncStatus
  // controls the mocked response status; callOrder records final-sync vs stop so
  // tests can assert the drain happens BEFORE the stop.
  finalSyncCalls: 0,
  finalSyncStatus: 200,
  callOrder: [] as string[],
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
        storage: (() => {
          // Map-backed so put/get/delete actually round-trip (the
          // collectMetrics not-running confirmation marker relies on it). The
          // special-cased identifier keys still read from testState.
          const store = new Map<string, unknown>();
          return {
            get: async <T>(key: string): Promise<T | undefined> => {
              if (key === '_sessionId') return testState.storedSessionId as T;
              if (key === 'bucketName') return testState.storedBucketName as T;
              if (key === 'sleepAfter') return testState.storedSleepAfter as T;
              if (key === 'userEmail') return testState.storedUserEmail as T;
              return store.has(key) ? (store.get(key) as T) : undefined;
            },
            put: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
            delete: vi.fn(async (key: string) => { store.delete(key); }),
          };
        })(),
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
      testState.callOrder.push('stop');
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
import { drainFinalSync, FINAL_SYNC_BUDGET_MS } from '../container/container-metrics';

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
    testState.finalSyncCalls = 0;
    testState.finalSyncStatus = 200;
    testState.callOrder = [];

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
    it('writes status=stopped to KV only after the not-running confirmation window (catch-all)', async () => {
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
    testState.finalSyncCalls = 0;
    testState.finalSyncStatus = 200;
    testState.callOrder = [];
    testState.stopCalls = 0;
    testState.scheduleCalls = [];
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

    it('is a no-op (no fetch) when the container is not running', async () => {
      testState.containerRunning = false;
      const ctx = (containerInstance as unknown as CtxHost).ctx;
      await drainFinalSync(ctx, FINAL_SYNC_BUDGET_MS);
      expect(testState.finalSyncCalls).toBe(0);
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
