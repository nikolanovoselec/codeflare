import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV, MockKV } from './helpers/mock-kv';
import { createMockSessionD1 } from './helpers/mock-session-d1';
import type { Session } from '../types';
import { D1SessionRepository, type D1Session } from '../lib/session-repository';

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
  } as Record<string, unknown>,
  beforeHealthResponse: undefined as (() => void) | undefined,
  tcpFetchShouldFail: false,
  hostProbeCalls: 0,
  activityFetchShouldFail: false,
  healthFetchShouldFail: false,
  activityStatus: 200,
  healthStatus: 200,
  stopCalls: 0,
  platformStopSignals: [] as Array<number | string | undefined>,
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
  finalSyncError: null as Error | null,
  agentDrainCalls: 0,
  agentFinalDrainCalls: 0,
  agentDrainStatus: 200,
  agentAckDrainStatus: 200,
  agentDrainEvents: [] as Array<Record<string, unknown>>,
  agentDrainRequests: [] as Array<{ body: Record<string, unknown>; authorization?: string }>,
  runtimeObservationAuthorizations: [] as Array<string | null>,
  callOrder: [] as string[],
  storageGetFailures: new Set<string>(),
  storagePutFailures: new Set<string>(),
  storageDeleteFailures: new Set<string>(),
  storageStore: new Map<string, unknown>(),
  waitUntilTasks: [] as Promise<unknown>[],
}));

// ---------------------------------------------------------------------------
// Module-level mocks - must be before imports that depend on mocked modules
// ---------------------------------------------------------------------------
vi.mock('@cloudflare/containers', () => {
  class MockContainer {
    ctx: {
      id: { toString: () => string };
      container: { running: boolean; signal: (signal: number) => void; getTcpPort: (port: number) => { fetch: (url: string, init?: RequestInit) => Promise<Response> } };
      storage: { get: <T>(key: string) => Promise<T | undefined>; put: (key: string, value: unknown) => Promise<void>; delete: (key: string | string[]) => Promise<void>; sync: () => Promise<void>;
        transaction: <T>(work: (tx: Pick<MockContainer['ctx']['storage'], 'get' | 'put' | 'delete'>) => Promise<T>) => Promise<T> };
      blockConcurrencyWhile: (fn: () => Promise<void>) => Promise<void>;
      waitUntil: (promise: Promise<unknown>) => void;
      abort: (reason: string) => never;
    };
    env: Record<string, unknown>;
    envVars: Record<string, string> | undefined;
    ready: Promise<void> = Promise.resolve();

    constructor() {
      this.ctx = {
        id: { toString: () => 'mock-do-id' },
        container: {
          get running() { return testState.containerRunning; },
          signal: (signal: number) => {
            testState.platformStopSignals.push(signal);
            testState.callOrder.push('signal');
          },
          getTcpPort: () => ({
            fetch: async (url: string, init?: RequestInit) => {
              if (url.includes('/internal/agent-events/drain')) {
                testState.agentDrainCalls += 1;
                const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
                const headers = init?.headers as Record<string, string> | undefined;
                testState.agentDrainRequests.push({ body, authorization: headers?.Authorization });
                if (body.final === true) {
                  testState.agentFinalDrainCalls += 1;
                  testState.callOrder.push('agent-events-final');
                }
                const isAck = Array.isArray(body.ackEventIds) && body.ackEventIds.length > 0;
                return new Response(JSON.stringify({
                  hostNow: 1_700_000_000_000,
                  events: testState.agentDrainEvents,
                }), {
                  status: isAck ? testState.agentAckDrainStatus : testState.agentDrainStatus,
                  headers: { 'Content-Type': 'application/json' },
                });
              }
              if (url.includes('/internal/final-sync')) {
                // drainFinalSync's call. Record it (and order vs stop) and honor
                // the failure switch / configured status so best-effort behavior
                // can be exercised independently of the /activity+/health probes.
                testState.finalSyncCalls += 1;
                testState.callOrder.push('finalsync');
                if (testState.finalSyncError) throw testState.finalSyncError;
                if (testState.tcpFetchShouldFail) {
                  throw new Error('Connection refused');
                }
                return new Response(JSON.stringify({ synced: testState.finalSyncStatus === 200 }), {
                  status: testState.finalSyncStatus,
                  headers: { 'Content-Type': 'application/json' },
                });
              }
              testState.hostProbeCalls += 1;
              const runtimeObservation = url.includes('/internal/runtime-observation');
              if (runtimeObservation) {
                testState.runtimeObservationAuthorizations.push(new Headers(init?.headers).get('Authorization'));
              }
              if (testState.tcpFetchShouldFail
                  || ((runtimeObservation || url.includes('/activity')) && testState.activityFetchShouldFail)
                  || ((runtimeObservation || url.includes('/health')) && testState.healthFetchShouldFail)) {
                throw new Error('Connection refused');
              }
              // A wedged container: the TCP connect succeeds and nothing is ever
              // written back. Settles ONLY on abort, mirroring how the existing
              // drainFinalSync budget test models this same port. Remove the
              // caller's signal and nothing ends this promise, so collectMetrics
              // never returns and the case fails by timeout.
              if (testState.activityHangs && (runtimeObservation || url.includes('/activity'))) {
                return new Promise<Response>((_resolve, reject) => {
                  init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                });
              }
              if (runtimeObservation || url.includes('/health')) testState.beforeHealthResponse?.();
              const body = runtimeObservation
                ? {
                    lastInputAt: testState.activityResult.lastInputAt ?? null,
                    cpu: testState.healthResult.cpu,
                    memory: testState.healthResult.mem,
                    disk: testState.healthResult.hdd,
                    syncStatus: testState.healthResult.syncStatus,
                    editorReady: testState.healthResult.editorReady,
                    editorReadyError: testState.healthResult.editorReadyError,
                    workspaceRepos: testState.healthResult.workspaceRepos,
                    observedAt: new Date().toISOString(),
                  }
                : url.includes('/activity') ? testState.activityResult : testState.healthResult;
              return new Response(JSON.stringify(body), {
                status: runtimeObservation ? Math.max(testState.activityStatus, testState.healthStatus) : url.includes('/activity') ? testState.activityStatus : testState.healthStatus,
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
          const operations = {
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
          return { ...operations, transaction: async <T>(work: (tx: typeof operations) => Promise<T>) => {
            const before = new Map(store);
            try { return await work(operations); }
            catch (error) {
              store.clear();
              for (const [key, value] of before) store.set(key, value);
              throw error;
            }
          } };
        })(),
        blockConcurrencyWhile: (fn: () => Promise<void>) => {
          this.ready = fn();
          return this.ready;
        },
        waitUntil: (promise: Promise<unknown>) => {
          testState.waitUntilTasks.push(promise);
          // Observe immediately; the original rejection still fails teardown below.
          void promise.catch(() => undefined);
        },
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
      testState.platformStopSignals.push(_signal);
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
const sendAgentEventPushesMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/logger', () => ({
  createLogger: () => mockLogger,
}));
vi.mock('../lib/push-sender', () => ({
  AGENT_EVENT_PUSH_BUDGET_MS: 4_000,
  sendAgentEventPushes: sendAgentEventPushesMock,
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

afterEach(async () => {
  while (testState.waitUntilTasks.length > 0) {
    await Promise.all(testState.waitUntilTasks.splice(0));
  }
});

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
      { KV: mockKV, USAGE_DB: createMockSessionD1(mockKV), LOG_LEVEL: 'silent' },
    );
    (instance as unknown as { env: { KV: MockKV; USAGE_DB: D1Database } }).env = { KV: mockKV, USAGE_DB: createMockSessionD1(mockKV) };
    return instance;
  };

  const enableTimekeeper = async ({ saasMode = true, quotaExceeded = false } = {}) => {
    testState.storedUserEmail = 'quota@example.com';
    containerInstance = createContainerInstance();
    const timekeeperStub = {
      fetch: vi.fn(async (_request: Request) => new Response(JSON.stringify({ quotaExceeded }), { status: 200 })),
    };
    const instanceEnv = (containerInstance as unknown as { env: Record<string, unknown> }).env;
    if (saasMode) instanceEnv.SAAS_MODE = 'active';
    instanceEnv.TIMEKEEPER = {
      idFromName: vi.fn(() => ({ toString: () => 'tk-id' })),
      get: vi.fn(() => timekeeperStub),
    };
    await (containerInstance as unknown as { ready: Promise<void> }).ready;
    return timekeeperStub;
  };

  beforeEach(async () => {
    mockKV = createMockKV();
    testState.containerRunning = true;
    testState.storedSessionId = 'testsession123456';
    testState.storedBucketName = 'test-bucket';
    testState.tcpFetchShouldFail = false;
    testState.hostProbeCalls = 0;
    testState.activityFetchShouldFail = false;
    testState.healthFetchShouldFail = false;
    testState.activityStatus = 200;
    testState.healthStatus = 200;
    testState.beforeHealthResponse = undefined;
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
    testState.platformStopSignals = [];
    testState.stopFailuresRemaining = 0;
    testState.storedSleepAfter = undefined;
    testState.storedUserEmail = undefined;
    testState.kvRef = mockKV;
    testState.finalSyncCalls = 0;
    testState.finalSyncStatus = 200;
    testState.finalSyncError = null;
    testState.agentDrainCalls = 0;
    testState.agentFinalDrainCalls = 0;
    testState.agentDrainStatus = 200;
    testState.agentAckDrainStatus = 200;
    testState.agentDrainEvents = [];
    testState.agentDrainRequests = [];
    sendAgentEventPushesMock.mockReset();
    sendAgentEventPushesMock.mockImplementation(async ({ events }: { events: Array<{ eventId: string }> }) => ({
      sentEventIds: events.map((event) => event.eventId),
    }));
    testState.callOrder = [];
    testState.storageGetFailures.clear();
    testState.storagePutFailures.clear();
    testState.storageDeleteFailures.clear();
    testState.storageStore.clear();
    testState.storageStore.set('containerAuthToken', 'agent-event-token');
    testState.storageStore.set('lifecycleGeneration', 0);
    testState.storageStore.set('observationSequence', -1);

    containerInstance = createContainerInstance();
    await (containerInstance as unknown as { ready: Promise<void> }).ready;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Observe real serialized logger output, not mock counts or a logging facade.
  async function withStructuredLogs(work: (entries: Array<{ level: string; data?: Record<string, unknown> }>) => Promise<void>) {
    const actual = await vi.importActual<typeof import('../lib/logger')>('../lib/logger');
    const entries: Array<{ level: string; data?: Record<string, unknown> }> = [];
    const capture = (line: unknown) => { entries.push(JSON.parse(String(line))); };
    const spies = [vi.spyOn(console, 'log').mockImplementation(capture),
      vi.spyOn(console, 'info').mockImplementation(capture),
      vi.spyOn(console, 'warn').mockImplementation(capture),
      vi.spyOn(console, 'error').mockImplementation(capture)];
    const logger = actual.createLogger('lifecycle-contract');
    actual.setLogLevel('info');
    mockLogger.info.mockImplementation(logger.info);
    mockLogger.warn.mockImplementation(logger.warn);
    mockLogger.error.mockImplementation(logger.error);
    mockLogger.debug.mockImplementation(logger.debug);
    try { await work(entries); }
    finally {
      actual.setLogLevel('silent');
      for (const spy of spies) spy.mockRestore();
      for (const method of [mockLogger.info, mockLogger.warn, mockLogger.error, mockLogger.debug]) method.mockReset();
    }
  }

  describe('REQ-SESSION-025: actual lifecycle observations', () => {
    const runningSession = () => mockKV._set('session:test-bucket:testsession123456', {
      id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
      workspace: 'terminal', createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
    } as Session);

    it('AC3: repeated healthy observations retain runtime state without repeating ordinary log output', async () => {
      runningSession();
      await withStructuredLogs(async entries => {
        await containerInstance.collectMetrics();
        const initial = structuredClone(entries);
        await containerInstance.collectMetrics();
        await containerInstance.collectMetrics();
        expect(entries).toEqual(initial);
        expect(await mockKV.get('session:test-bucket:testsession123456', 'json')).toMatchObject({
          status: 'running', metrics: { cpu: '45%', mem: '1024MB', hdd: '2.5GB', syncStatus: 'success' },
        });
        expect(testState.platformStopSignals).toEqual([]);
      });
    });

    it('AC1/4: an SDK error retains actionable context without exporting private payloads or changing retry timing', async () => {
      runningSession();
      await withStructuredLogs(async entries => {
        await containerInstance.onError(new Error('Network connection lost. Bearer PRIVATE_RUNTIME_CANARY /private/runtime-path transcript:PRIVATE_RUNTIME_TEXT'));
        expect(entries).toContainEqual(expect.objectContaining({ level: 'error', data: expect.objectContaining({
          sessionId: 'testsession123456', lifecycleGeneration: 0, incidentId: null, errorClass: expect.any(String),
        }) }));
        expect(entries).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ reason: 'unknown' }) }));
        const serialized = JSON.stringify(entries);
        for (const value of ['PRIVATE_RUNTIME_CANARY', '/private/runtime-path', 'PRIVATE_RUNTIME_TEXT']) expect(serialized).not.toContain(value);
        expect(testState.scheduleCalls).toContainEqual([5, 'collectMetrics']);
        expect(await mockKV.get('session:test-bucket:testsession123456', 'json')).toMatchObject({ status: 'running' });
        expect(testState.platformStopSignals).toEqual([]);
      });
    });

    const privatePayload = 'Bearer PRIVATE_METRICS_CANARY /private/metrics-path transcript:PRIVATE_METRICS_TEXT';
    const expectPrivateSafeLogs = (entries: unknown[]) => {
      const serialized = JSON.stringify(entries);
      for (const value of ['PRIVATE_METRICS_CANARY', '/private/metrics-path', 'PRIVATE_METRICS_TEXT']) expect(serialized).not.toContain(value);
    };

    it.each(['error', 'string'] as const)('AC4: private-bearing %s probe failure retains classification and owned retry', async kind => {
      runningSession();
      const message = `Network connection lost. ${privatePayload}`;
      testState.beforeHealthResponse = () => { throw kind === 'error' ? new Error(message) : message; };
      await withStructuredLogs(async entries => {
        await containerInstance.collectMetrics();
        const session = await mockKV.get('session:test-bucket:testsession123456', 'json') as Session & Pick<D1Session, 'unreachableIncidentId'>;
        expect(session).toMatchObject({ status: 'unreachable', lifecycleGeneration: 0, unreachableIncidentId: expect.any(String) });
        expect(entries).toContainEqual(expect.objectContaining({ data: expect.objectContaining({
          sessionId: session.id, lifecycleGeneration: 0, incidentId: session.unreachableIncidentId,
          probes: expect.objectContaining({ activity: expect.objectContaining({ responded: false, category: 'network-lost' }) }),
        }) }));
        expectPrivateSafeLogs(entries);
        expect(testState.scheduleCalls).toContainEqual([5, 'collectMetrics']);
        expect(testState.storageStore.get('usageSeconds')).toBeUndefined();
        expect(testState.platformStopSignals).toEqual([]);
        expect(testState.abortReasons).toEqual([]);
      });
    });

    it('AC4: private recovery persistence refusal retains ownership without reset', async () => {
      runningSession();
      testState.beforeHealthResponse = () => { throw new Error(`Connection refused ${privatePayload}`); };
      const put = vi.mocked(storage().put).getMockImplementation()!;
      vi.spyOn(storage(), 'put').mockImplementation(async (key, value) => {
        if (key === TRANSPORT_FAILURE_STREAK_KEY) throw new Error(privatePayload);
        await put(key, value);
      });
      await withStructuredLogs(async entries => {
        await containerInstance.collectMetrics();
        const session = await mockKV.get('session:test-bucket:testsession123456', 'json') as Session & Pick<D1Session, 'unreachableIncidentId'>;
        expect(session).toMatchObject({ status: 'unreachable', unreachableIncidentId: expect.any(String) });
        expect(entries).toContainEqual(expect.objectContaining({ level: 'warn', data: expect.objectContaining({
          sessionId: session.id, lifecycleGeneration: 0, incidentId: session.unreachableIncidentId, errorClass: 'storage_write_failed',
        }) }));
        expectPrivateSafeLogs(entries);
        expect(await storage().get(TRANSPORT_FAILURE_STREAK_KEY)).toBeUndefined();
        expect(testState.scheduleCalls).toContainEqual([5, 'collectMetrics']);
        expect(testState.platformStopSignals).toEqual([]);
        expect(testState.abortReasons).toEqual([]);
      });
    });

    it('AC4: retry alarm rejects with the original error without exporting its private payload', async () => {
      runningSession();
      const failure = new Error(privatePayload);
      testState.storageGetFailures.add(TRANSPORT_RECOVERY_KEY);
      vi.spyOn(containerInstance, 'schedule').mockRejectedValueOnce(failure);
      await withStructuredLogs(async entries => {
        await expect(containerInstance.collectMetrics()).rejects.toBe(failure);
        expect(entries).toContainEqual(expect.objectContaining({ level: 'error', data: expect.objectContaining({
          sessionId: 'testsession123456', lifecycleGeneration: 0, incidentId: null, errorClass: 'schedule_failed',
        }) }));
        expectPrivateSafeLogs(entries);
        expect(await mockKV.get('session:test-bucket:testsession123456', 'json')).toMatchObject({ status: 'running' });
        expect(testState.storageStore.get('usageSeconds')).toBeUndefined();
        expect(testState.platformStopSignals).toEqual([]);
      });
    });

    it.each(['read', 'write'] as const)('AC4: private startup timing %s failure cannot authorize idle stop', async operation => {
      runningSession();
      testState.activityResult.lastInputAt = null;
      (containerInstance as unknown as { containerStartedAt: number }).containerStartedAt = 0;
      if (operation === 'read') {
        const get = storage().get.bind(storage());
        vi.spyOn(storage(), 'get').mockImplementation(async <T>(key: string): Promise<T | undefined> => {
          if (key === 'containerStartedAt') throw new Error(privatePayload);
          return get<T>(key);
        });
      } else {
        const put = vi.mocked(storage().put).getMockImplementation()!;
        vi.spyOn(storage(), 'put').mockImplementation(async (key, value) => {
          if (key === 'containerStartedAt') throw privatePayload;
          await put(key, value);
        });
      }
      await withStructuredLogs(async entries => {
        await containerInstance.collectMetrics();
        expect(entries).toContainEqual(expect.objectContaining({ level: 'warn', data: expect.objectContaining({
          sessionId: 'testsession123456', lifecycleGeneration: 0, incidentId: null,
          errorClass: operation === 'read' ? 'storage_read_failed' : 'storage_write_failed',
        }) }));
        expectPrivateSafeLogs(entries);
        expect(await mockKV.get('session:test-bucket:testsession123456', 'json')).toMatchObject({ status: 'running', metrics: { cpu: '45%', syncStatus: 'success' } });
        expect(testState.platformStopSignals).toEqual([]);
        expect(testState.abortReasons).toEqual([]);
        expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
      });
    });

    it('AC4: private D1 projection error retains runtime and retry without billing', async () => {
      await enableTimekeeper();
      runningSession();
      const d1 = (containerInstance as unknown as { env: { USAGE_DB: D1Database } }).env.USAGE_DB;
      const prepare = d1.prepare.bind(d1);
      vi.spyOn(d1, 'prepare').mockImplementation((sql: string) => {
        const statement = prepare(sql);
        if (sql.includes('observation_sequence=?4')) (statement as unknown as { run: () => Promise<unknown> }).run = async () => { throw new Error(privatePayload); };
        return statement;
      });
      await withStructuredLogs(async entries => {
        await containerInstance.collectMetrics();
        expect(entries).toContainEqual(expect.objectContaining({ level: 'warn', data: expect.objectContaining({
          sessionId: 'testsession123456', lifecycleGeneration: 0, incidentId: null, errorClass: 'd1_projection_failed',
        }) }));
        expectPrivateSafeLogs(entries);
        expect(await mockKV.get('session:test-bucket:testsession123456', 'json')).toMatchObject({ status: 'running' });
        expect(testState.storageStore.get('usageSeconds')).toBeUndefined();
        expect(testState.platformStopSignals).toEqual([]);
        expect(testState.abortReasons).toEqual([]);
        expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
      });
    });

    it('AC4: private Timekeeper failure retains accrued usage and re-arms', async () => {
      const timekeeper = await enableTimekeeper();
      runningSession();
      timekeeper.fetch.mockRejectedValueOnce(new Error(privatePayload));
      await withStructuredLogs(async entries => {
        await containerInstance.collectMetrics();
        expect(entries).toContainEqual(expect.objectContaining({ level: 'warn', data: expect.objectContaining({
          sessionId: 'testsession123456', lifecycleGeneration: 0, incidentId: null, errorClass: 'timekeeper_ping_failed',
        }) }));
        expectPrivateSafeLogs(entries);
        expect(await storage().get('usageSeconds')).toBe(60);
        expect(await mockKV.get('session:test-bucket:testsession123456', 'json')).toMatchObject({ status: 'running' });
        expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
        expect(testState.platformStopSignals).toEqual([]);
      });
    });

    it('AC1/2/4: idle final-sync failure stays correlated and private-safe while best-effort stop still completes', async () => {
      runningSession();
      testState.storedSleepAfter = '15m';
      testState.activityResult.lastInputAt = Date.now() - 30 * 60_000;
      testState.finalSyncError = new Error('Bearer PRIVATE_SYNC_CANARY /private/sync-path transcript:PRIVATE_SYNC_TEXT');
      await withStructuredLogs(async entries => {
        await containerInstance.collectMetrics();
        expect(testState.callOrder).toEqual(['agent-events-final', 'finalsync', 'stop']);
        expect(entries).toContainEqual(expect.objectContaining({ level: 'warn', data: expect.objectContaining({
          sessionId: 'testsession123456', lifecycleGeneration: 0, incidentId: null, errorClass: expect.any(String),
        }) }));
        // Closed initiator metadata distinguishes policy shutdown from an unknown SDK callback.
        expect(entries).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ reason: 'idle' }) }));
        const serialized = JSON.stringify(entries);
        for (const value of ['PRIVATE_SYNC_CANARY', '/private/sync-path', 'PRIVATE_SYNC_TEXT']) expect(serialized).not.toContain(value);
      });
    });

    it.each(['idle', 'quota'] as const)(
      'REQ-SESSION-026 AC1: %s stop propagates its required alarm failure, not an ancillary failure',
      async reason => {
        const timekeeper = reason === 'quota' ? await enableTimekeeper({ quotaExceeded: true }) : undefined;
        runningSession();
        // A healthy tick begins billable, then the SDK hint drops while the host responds.
        // Starting SDK-false would be a recovery tick and correctly skip quota polling.
        testState.beforeHealthResponse = () => { testState.containerRunning = false; };
        if (reason === 'idle') {
          testState.storedSleepAfter = '15m';
          testState.activityResult.lastInputAt = Date.now() - 30 * 60_000;
        }
        const failure = new Error(`required alarm unavailable ${privatePayload}`);
        // Only the required stop alarm fails. An unrelated later re-arm would succeed;
        // it must not hide this terminal failure. This is not the monitored-exit retry lane.
        const schedule = vi.spyOn(containerInstance, 'schedule').mockRejectedValueOnce(failure);
        try {
          await withStructuredLogs(async entries => {
            await expect(containerInstance.collectMetrics()).rejects.toBe(failure);
            expect(entries).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ reason }) }));
            expect(entries).toContainEqual(expect.objectContaining({ level: 'error', data: expect.objectContaining({
              sessionId: 'testsession123456', lifecycleGeneration: 0,
              incidentId: null, errorClass: 'schedule_failed',
            }) }));
            expect(entries.map(entry => entry.data?.errorClass)).not.toContain('runtime_observation_failed');
            expect(entries.map(entry => entry.data?.errorClass)).not.toContain('timekeeper_ping_failed');
            expectPrivateSafeLogs(entries);
          });
          expect(testState.callOrder).toEqual(['agent-events-final', 'finalsync', 'signal']);
          expect(testState.platformStopSignals).toEqual([15]);
          expect(testState.scheduleCalls).toEqual([]);
          expect(testState.abortReasons).toEqual([]);
          expect(await mockKV.get('session:test-bucket:testsession123456', 'json')).toMatchObject({
            status: 'running', lifecycleGeneration: 0, workspace: 'terminal',
          });
          // Quota is learned from the ordinary ping: preserve its one existing usage minute,
          // but do not turn the failed stop into an additional billable observation.
          expect(await storage().get('usageSeconds')).toBe(reason === 'quota' ? 60 : undefined);
          if (timekeeper) {
            const body = await ((timekeeper.fetch.mock.calls as unknown as Array<[Request]>)[0][0]).clone().json();
            expect(body).toMatchObject({ totalSeconds: 60, sessionId: 'testsession123456' });
          }
        } finally { schedule.mockRestore(); }
      },
    );

    it('AC2: quota shutdown is distinct from idle and still drains before stopping', async () => {
      await enableTimekeeper({ quotaExceeded: true });
      runningSession();
      await withStructuredLogs(async entries => {
        await containerInstance.collectMetrics();
        expect(testState.callOrder).toEqual(['agent-events-final', 'finalsync', 'stop']);
        expect(entries).toContainEqual(expect.objectContaining({ data: expect.objectContaining({
          sessionId: 'testsession123456', lifecycleGeneration: 0, reason: 'quota',
        }) }));
      });
    });
  });

  describe('onStart', () => {
    beforeEach(() => {
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'starting',
        lifecycleGeneration: 0, createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      });
    });

    it('should call schedule(60, "collectMetrics") on start', async () => {
      await containerInstance.onStart();

      // Check that schedule was called with correct args
      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
      expect(await storage().get<number>('containerStartedAt')).toBeGreaterThan(0);
    });

    it('preserves generation ownership and idle baseline on a duplicate onStart', async () => {
      await containerInstance.onStart();
      const startedAt = await storage().get<number>('containerStartedAt');
      const recovery = {
        attemptId: 'preserve-this-recovery', startedAt: Date.now(), lastAttemptAt: Date.now(),
        attemptCount: 1, postResetFailureCount: 0, totalFailureCount: 1, status: 'resetting',
      };
      await storage().put('shutdownRequested', Date.now());
      await storage().put(TRANSPORT_RECOVERY_KEY, recovery);
      await storage().put('observationSequence', 7);
      const schedulesBeforeReplay = [...testState.scheduleCalls];
      const deletionsBeforeReplay = [...testState.deleteScheduleCalls];

      await expect(containerInstance.onStart()).resolves.toBeUndefined();

      expect(await storage().get('containerStartedAt')).toBe(startedAt);
      expect(await storage().get('shutdownRequested')).toEqual(expect.any(Number));
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toEqual(recovery);
      expect(await storage().get('observationSequence')).toBe(7);
      expect(testState.scheduleCalls).toEqual(schedulesBeforeReplay);
      expect(testState.deleteScheduleCalls).toEqual(deletionsBeforeReplay);
    });

    it('REQ-SESSION-022: a reconstructed onStart replay preserves its assigned D1 incident and deadline', async () => {
      const incident = { id: 'testsession123456', name: 'Test', userId: 'test-bucket',
        status: 'unreachable', lifecycleGeneration: 0, observationSequence: 4,
        unreachableIncidentId: 'assigned-incident', unreachableFirstObservedAt: '2027-01-01T00:00:00.000Z',
        unreachableDeadlineMs: 1_800_000_120_000 };
      mockKV._set('session:test-bucket:testsession123456', incident);
      await storage().put('observationSequence', 4);
      await storage().put('containerStartedAt', 1_800_000_000_000);
      await containerInstance.onStart();
      expect(await mockKV.get('session:test-bucket:testsession123456', 'json')).toEqual(incident);
      expect(await storage().get('observationSequence')).toBe(4);
      expect(testState.scheduleCalls).toEqual([]);
    });

    it('rejects a stale onStart replay without clearing shutdown ownership', async () => {
      await containerInstance.onStart();
      await storage().put('lifecycleGeneration', 99);
      await storage().put('shutdownRequested', Date.now());

      await expect(containerInstance.onStart()).rejects.toThrow('D1 start generation replay unavailable');
      expect(await storage().get('shutdownRequested')).toEqual(expect.any(Number));
    });

    it('rejects a stopping onStart callback without clearing shutdown ownership', async () => {
      await storage().put('shutdownRequested', Date.now());
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'stopping', lifecycleGeneration: 0,
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      });

      await expect(containerInstance.onStart()).rejects.toThrow('D1 start generation unavailable');
      expect(await storage().get('shutdownRequested')).toEqual(expect.any(Number));
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

    it('REQ-SESSION-021 AC4: does not arm metrics when startup cannot clear prior transport state', async () => {
      for (const failedKey of [TRANSPORT_FAILURE_STREAK_KEY, TRANSPORT_RECOVERY_KEY]) {
        testState.scheduleCalls = [];
        testState.storageDeleteFailures.clear();
        await storage().put(TRANSPORT_FAILURE_STREAK_KEY, 2);
        await storage().put(TRANSPORT_RECOVERY_KEY, { status: 'resetting' });
        testState.storageDeleteFailures.add(failedKey);

        await expect(containerInstance.onStart()).rejects.toThrow(`storage delete failed: ${failedKey}`);

        expect(testState.scheduleCalls).toEqual([]);
        expect(await storage().get(TRANSPORT_FAILURE_STREAK_KEY)).toBe(2);
        expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toEqual({ status: 'resetting' });
      }
    });
  });

  describe('collectMetrics', () => {
    const setNotificationSession = () => {
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456',
        name: 'Pi #1',
        userId: 'test@example.com',
        agentType: 'pi',
        status: 'running',
        createdAt: '2026-08-21T00:00:00.000Z',
        lastAccessedAt: '2026-08-21T00:00:00.000Z',
      } as Session);
      const env = (containerInstance as unknown as { env: Record<string, unknown> }).env;
      env.VAPID_SUBJECT = 'mailto:ops@codeflare.example';
      env.VAPID_PUBLIC_KEY = 'public-key';
      env.VAPID_PRIVATE_KEY = 'private-key';
    };

    it('REQ-TERM-023 AC4 / D2-D4: drains, validates, enriches, sends, then ACK-clears on every running tick', async () => {
      setNotificationSession();
      testState.agentDrainEvents = [{
        schemaVersion: 1,
        eventId: 'event-a',
        kind: 'input-required',
        createdAt: 1_699_999_999_000,
      }];

      await containerInstance.collectMetrics();

      expect(testState.agentDrainCalls).toBe(2);
      expect(testState.agentDrainRequests[0]).toEqual({
        body: { ackEventIds: [] },
        authorization: 'Bearer agent-event-token',
      });
      expect(sendAgentEventPushesMock).toHaveBeenCalledTimes(1);
      expect(sendAgentEventPushesMock).toHaveBeenCalledWith(expect.objectContaining({
        bucketName: 'test-bucket',
        session: expect.objectContaining({ id: 'testsession123456', name: 'Pi #1', agentType: 'pi' }),
        events: [expect.objectContaining({ eventId: 'event-a', kind: 'input-required' })],
        vapid: {
          subject: 'mailto:ops@codeflare.example',
          publicKey: 'public-key',
          privateKey: 'private-key',
        },
      }));
      expect(testState.agentDrainRequests[1]?.body).toEqual({ ackEventIds: ['event-a'] });
    });

    it.each([
      { schemaVersion: 2, eventId: 'bad-version', kind: 'input-required', createdAt: 1_700_000_000_000 },
      { schemaVersion: 1, eventId: 'bad-kind', kind: 'arbitrary', createdAt: 1_700_000_000_000 },
      { schemaVersion: 1, eventId: 'too-old', kind: 'input-required', createdAt: 1_699_999_000_000 },
      { schemaVersion: 1, eventId: 'injected', kind: 'input-required', createdAt: 1_700_000_000_000, sessionName: 'attacker' },
    ])('REQ-SEC-024 AC1 / D3: rejects $eventId independently without delivery, ACK or payload logging', async badEvent => {
      setNotificationSession();
      testState.agentDrainEvents = [badEvent];
      await withStructuredLogs(async entries => {
        await containerInstance.collectMetrics();
        expect(sendAgentEventPushesMock).not.toHaveBeenCalled();
        expect(testState.agentDrainRequests.map(request => request.body)).toEqual([{ ackEventIds: [] }]);
        expect(JSON.stringify(entries)).not.toContain(badEvent.eventId);
        expect(JSON.stringify(entries)).not.toContain('attacker');
      });
      expect(testState.agentDrainCalls).toBe(1);
    });

    it('D3: rejects an over-cap response instead of delivering a truncated attacker-controlled batch', async () => {
      setNotificationSession();
      testState.agentDrainEvents = Array.from({ length: 9 }, (_, index) => ({
        schemaVersion: 1,
        eventId: `event-${index}`,
        kind: 'input-required',
        createdAt: 1_700_000_000_000,
      }));

      await containerInstance.collectMetrics();

      expect(sendAgentEventPushesMock).not.toHaveBeenCalled();
      expect(testState.agentDrainCalls).toBe(1);
    });

    it('D4: resolves the trusted Session before probes so health failure does not skip delivery', async () => {
      setNotificationSession();
      testState.healthFetchShouldFail = true;
      testState.agentDrainEvents = [{
        schemaVersion: 1,
        eventId: 'event-health-failed',
        kind: 'input-required',
        createdAt: 1_700_000_000_000,
      }];

      await containerInstance.collectMetrics();

      expect(sendAgentEventPushesMock).toHaveBeenCalledWith(expect.objectContaining({
        session: expect.objectContaining({ id: 'testsession123456' }),
      }));
    });

    it('REQ-TERM-023 AC5: a stalled push provider cannot stop metrics or alarm re-arming', async () => {
      setNotificationSession();
      testState.agentDrainEvents = [{
        schemaVersion: 1,
        eventId: 'event-stalled-provider',
        kind: 'input-required',
        createdAt: 1_699_999_999_000,
      }];
      testState.scheduleCalls = [];
      sendAgentEventPushesMock.mockImplementationOnce(() => new Promise(() => {}));

      await containerInstance.collectMetrics();

      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
      expect(testState.stopCalls).toBe(0);
    }, 10_000);

    it('D2: after send succeeds but ACK fails, re-offer is ACKed without same-instance re-send', async () => {
      setNotificationSession();
      testState.agentDrainEvents = [{
        schemaVersion: 1,
        eventId: 'event-reoffered',
        kind: 'input-required',
        createdAt: 1_700_000_000_000,
      }];
      testState.agentAckDrainStatus = 500;

      await containerInstance.collectMetrics();
      await containerInstance.collectMetrics();

      expect(sendAgentEventPushesMock).toHaveBeenCalledTimes(1);
      expect(testState.agentDrainRequests.filter(
        (request) => (request.body.ackEventIds as string[]).includes('event-reoffered'),
      )).toHaveLength(2);
    });

    it('D3/D4: delivered notifications preserve parsed activity and cannot extend the idle deadline', async () => {
      let now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const timekeeper = await enableTimekeeper({ saasMode: false });
      setNotificationSession();
      const key = 'session:test-bucket:testsession123456';
      const original = await mockKV.get(key, 'json') as Session;
      const inputAt = now - 59 * 60_000;
      const startedAt = now - 2 * 3_600_000;
      testState.storedSleepAfter = '1h';
      testState.activityResult.lastInputAt = inputAt;
      await storage().put('containerStartedAt', startedAt);
      mockKV._set(key, { ...original, lastInputAt: new Date(inputAt).toISOString() });
      testState.agentDrainEvents = [{ schemaVersion: 1, eventId: 'idle-notification',
        kind: 'input-required', createdAt: now - 1000 }];

      await containerInstance.collectMetrics();

      // These are outputs of processing Response.json(), not the untouched host fixture.
      const projected = await mockKV.get(key, 'json') as Session & { lastInputAt: string };
      expect(projected.lastInputAt).toBe(new Date(inputAt).toISOString());
      expect(projected.lastAccessedAt).toBe(original.lastAccessedAt);
      expect(projected.lastActiveAt).toBe(original.lastActiveAt);
      expect(await storage().get('containerStartedAt')).toBe(startedAt);
      expect(await storage().get('usageSeconds')).toBe(60);
      const usagePings = await Promise.all(timekeeper.fetch.mock.calls.map(async ([request]) => request.clone().json()));
      expect(usagePings).toEqual([{ bucketName: 'test-bucket', sessionId: 'testsession123456',
        totalSeconds: 60, email: 'quota@example.com' }]);
      expect(testState.agentDrainRequests.map(request => request.body)).toContainEqual({ ackEventIds: ['idle-notification'] });
      expect(testState.platformStopSignals).toEqual([]);

      now += 2 * 60_000;
      await containerInstance.collectMetrics();

      expect(testState.platformStopSignals).toEqual(['SIGTERM']);
      expect(await storage().get('containerStartedAt')).toBe(startedAt);
      expect(await storage().get('usageSeconds')).toBe(60);
      expect(await Promise.all(timekeeper.fetch.mock.calls.map(async ([request]) => request.clone().json())))
        .toEqual(usagePings);
      expect((await mockKV.get(key, 'json') as Session & { lastInputAt: string }).lastInputAt)
        .toBe(new Date(inputAt).toISOString());
    });

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

      expect(mockLogger.warn).toHaveBeenCalledWith('collectMetrics: container R2 sync unhealthy', {
        sessionId: 'testsession123456', lifecycleGeneration: 0, incidentId: null, syncStatus: 'failed',
      });

      // A healthy sync must NOT warn (no alert noise on the steady state).
      mockLogger.warn.mockClear();
      testState.healthResult.syncStatus = 'success';
      await containerInstance.collectMetrics();
      expect(mockLogger.warn).not.toHaveBeenCalledWith('collectMetrics: container R2 sync unhealthy', expect.anything());
    });

    it('REQ-IDE-049 AC4: fresh-merges metrics and repairs readiness after a concurrent session update', async () => {
      const key = 'session:test-bucket:testsession123456';
      testState.healthResult.editorReady = true;
      const initial: Session = {
        id: 'testsession123456',
        name: 'Before health probe',
        userId: 'test-bucket',
        workspace: 'vscode',
        status: 'running',
        editorReady: false,
        editorReadyError: true,
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set(key, initial);
      testState.beforeHealthResponse = () => {
        const { editorReadyError: _staleError, ...concurrent } = initial;
        mockKV._set(key, {
          ...concurrent,
          name: 'Updated during health probe',
          editorReady: true,
        });
      };

      await containerInstance.collectMetrics();

      const stored = await mockKV.get(key, 'json') as Session;
      expect(stored).toMatchObject({
        name: 'Updated during health probe',
        status: 'running',
        editorReady: true,
        metrics: { cpu: '45%', mem: '1024MB', hdd: '2.5GB', syncStatus: 'success' },
      });
      expect(stored.editorReadyError).toBe(false);
      expect(mockKV.put.mock.calls.some(
        ([writtenKey]) => /^(session-editor|session-metrics|session-status-correction):/.test(String(writtenKey)),
      )).toBe(false);
    });

    it('authenticates the private runtime observation probe', async () => {
      testState.runtimeObservationAuthorizations = [];
      await vi.waitFor(() => expect(
        (containerInstance as unknown as { _containerAuthToken: string | null })._containerAuthToken,
      ).toBe('agent-event-token'));
      await containerInstance.collectMetrics();

      expect(testState.runtimeObservationAuthorizations).toEqual(['Bearer agent-event-token']);
    });

    it('does not stop a hibernated coordinator when startup has no input timestamp', async () => {
      const startedAt = Date.now() - 120_000;
      testState.activityResult.lastInputAt = 0;
      testState.storedSleepAfter = '30m';
      testState.storageStore.set('containerStartedAt', startedAt);
      (containerInstance as unknown as { containerStartedAt: number }).containerStartedAt = 0;
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      } as Session);

      await containerInstance.collectMetrics();

      expect(testState.stopCalls).toBe(0);
      expect((containerInstance as unknown as { containerStartedAt: number }).containerStartedAt).toBe(startedAt);
      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
    });

    it('persists one fallback baseline across a second coordinator reconstruction', async () => {
      let now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      testState.activityResult.lastInputAt = null;
      testState.storedSleepAfter = '30m';
      (containerInstance as unknown as { containerStartedAt: number }).containerStartedAt = 0;
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      } as Session);

      await containerInstance.collectMetrics();
      const baseline = await storage().get<number>('containerStartedAt');
      now += 60_000;
      containerInstance = createContainerInstance();
      await vi.waitFor(() => expect(
        (containerInstance as unknown as { _containerAuthToken: string | null })._containerAuthToken,
      ).toBe('agent-event-token'));
      await containerInstance.collectMetrics();

      expect(baseline).toEqual(expect.any(Number));
      expect(await storage().get('containerStartedAt')).toBe(baseline);
      expect(testState.stopCalls).toBe(0);
    });

    it('replaces non-finite persisted startup baselines', async () => {
      testState.activityResult.lastInputAt = 0;
      testState.storedSleepAfter = '30m';
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      } as Session);

      for (const invalidBaseline of [NaN, Infinity]) {
        testState.storageStore.set('containerStartedAt', invalidBaseline);
        (containerInstance as unknown as { containerStartedAt: number }).containerStartedAt = 0;
        await containerInstance.collectMetrics();
        const baseline = await storage().get<number>('containerStartedAt');
        expect(typeof baseline === 'number' && Number.isFinite(baseline)).toBe(true);
        expect(baseline).toBeGreaterThan(0);
      }
      expect(testState.stopCalls).toBe(0);
    });

    it('does not authorize idle stopping when fallback baseline persistence fails', async () => {
      testState.activityResult.lastInputAt = 0;
      testState.storedSleepAfter = '30m';
      testState.storagePutFailures.add('containerStartedAt');
      (containerInstance as unknown as { containerStartedAt: number }).containerStartedAt = 0;
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      } as Session);

      await containerInstance.collectMetrics();

      expect(testState.stopCalls).toBe(0);
      expect((containerInstance as unknown as { containerStartedAt: number }).containerStartedAt).toBe(0);
      expect(await storage().get('observationSequence')).toBe(0);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
      const projected = await mockKV.get('session:test-bucket:testsession123456', 'json') as Session;
      expect(projected.metrics?.cpu).toBe('45%');
    });

    it('keeps host transport healthy when startup-reference storage cannot be read', async () => {
      testState.activityResult.lastInputAt = null;
      testState.storedSleepAfter = '30m';
      testState.storageGetFailures.add('containerStartedAt');
      (containerInstance as unknown as { containerStartedAt: number }).containerStartedAt = 0;
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      } as Session);

      await containerInstance.collectMetrics();

      expect(testState.stopCalls).toBe(0);
      expect(testState.abortReasons).toEqual([]);
      expect(await storage().get('observationSequence')).toBe(0);
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeUndefined();
      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
      const projected = await mockKV.get('session:test-bucket:testsession123456', 'json') as Session;
      expect(projected.metrics?.cpu).toBe('45%');
    });

    it.each(['missing', 'unreadable', 'unpersistable'] as const)(
      'REQ-SESSION-004/034: valid input enforces its 1h deadline with %s startup timing',
      async fault => {
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        testState.storedSleepAfter = '1h';
        testState.activityResult.lastInputAt = now;
        mockKV._set('session:test-bucket:testsession123456', {
          id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
          createdAt: new Date(now).toISOString(), lastAccessedAt: new Date(now).toISOString(),
        } as Session);
        await containerInstance.collectMetrics();

        // Reconstructed timing state has no usable startup reference, but the
        // authenticated host still supplies genuine input timing evidence.
        (containerInstance as unknown as { containerStartedAt: number }).containerStartedAt = 0;
        testState.storageStore.delete('containerStartedAt');
        if (fault === 'unreadable') testState.storageGetFailures.add('containerStartedAt');
        if (fault === 'unpersistable') testState.storagePutFailures.add('containerStartedAt');
        testState.activityResult.lastInputAt = now - 59 * 60_000;

        await containerInstance.collectMetrics();
        expect(testState.platformStopSignals).toEqual([]);
        now += 2 * 60_000;
        await containerInstance.collectMetrics();
        expect(testState.platformStopSignals).toEqual(['SIGTERM']);
      },
    );

    it.each([
      { provenance: 'stored', value: '1h', readFailure: false, noInput: false, decision: 'stop' },
      { provenance: 'missing', value: undefined, readFailure: false, noInput: false, decision: 'continue' },
      { provenance: 'invalid', value: 'INVALID_POLICY_CANARY', readFailure: false, noInput: false, decision: 'continue' },
      { provenance: 'read-failed', value: '1h', readFailure: true, noInput: false, decision: 'continue' },
      { provenance: 'stored', value: '1h', readFailure: false, noInput: true, decision: 'timing-unavailable' },
    ])('idle decision diagnostic contract: $provenance / $decision', async scenario => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date(now).toISOString(), lastAccessedAt: new Date(now).toISOString(),
      } as Session);
      // Missing policy is observed once; unchanged activity age must not require another ordinary event.
      if (scenario.provenance !== 'missing') await containerInstance.collectMetrics();
      testState.storedSleepAfter = scenario.value;
      testState.activityResult.lastInputAt = scenario.noInput ? null : now - 2 * 3_600_000;
      if (scenario.readFailure) testState.storageGetFailures.add('sleepAfter');
      if (scenario.noInput) {
        (containerInstance as unknown as { containerStartedAt: number }).containerStartedAt = 0;
        testState.storageGetFailures.add('containerStartedAt');
      }
      const emitted: unknown[] = [];
      mockLogger.info.mockImplementation((message: string, data?: Record<string, unknown>) => {
        if (message === 'collectMetrics: idle policy decision') emitted.push(data);
      });
      try {
        await containerInstance.collectMetrics();
        // Closed metadata contract: no raw input, policy contents, credentials,
        // endpoints or other incidental host-observation data may be emitted.
        expect(emitted).toContainEqual({
          durableObjectId: 'mock-do-id', sessionId: 'testsession123456',
          idleTimeoutPref: scenario.provenance === 'stored' ? '1h' : '12h',
          policySource: scenario.provenance, checkedAt: now,
          observedInputAt: scenario.noInput ? null : now - 2 * 3_600_000,
          referenceTime: scenario.noInput ? null : now - 2 * 3_600_000,
          canEnforceIdle: !scenario.noInput, decision: scenario.decision,
        });
        expect(testState.platformStopSignals).toEqual(scenario.decision === 'stop' ? ['SIGTERM'] : []);
      } finally { mockLogger.info.mockReset(); }
    });

    it.each([['8h', 8], ['12h', 12]] as const)('REQ-SESSION-004: %s stays alive until its configured idle deadline and then requests SIGTERM', async (duration, hours) => {
      let now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      testState.storedSleepAfter = duration;
      testState.activityResult.lastInputAt = now - hours * 3_600_000 + 60_000;
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date(now).toISOString(), lastAccessedAt: new Date(now).toISOString(),
      } as Session);
      await containerInstance.collectMetrics();
      expect(testState.platformStopSignals).toEqual([]);
      now += 120_000;
      await containerInstance.collectMetrics();
      expect(testState.platformStopSignals).toEqual(['SIGTERM']);
    });

    it('stops after genuine idle expiry from the persisted startup reference', async () => {
      testState.activityResult.lastInputAt = 0;
      testState.storedSleepAfter = '30m';
      testState.storageStore.set('containerStartedAt', Date.now() - (31 * 60_000));
      // A valid baseline is only read. A write failure must not suppress its
      // established idle deadline.
      testState.storagePutFailures.add('containerStartedAt');
      (containerInstance as unknown as { containerStartedAt: number }).containerStartedAt = 0;
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      } as Session);

      await containerInstance.collectMetrics();

      expect(testState.stopCalls).toBe(1);
    });

    it('projects one lifecycle observation when no separate clone inventory is reported', async () => {
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      } as Session);
      const d1 = (containerInstance as unknown as { env: { USAGE_DB: D1Database } }).env.USAGE_DB;
      const prepare = d1.prepare.bind(d1);
      let projections = 0;
      vi.spyOn(d1, 'prepare').mockImplementation((sql: string) => {
        const statement = prepare(sql);
        if (sql.includes('observation_sequence=?4')) {
          const run = statement.run.bind(statement);
          (statement as unknown as { run: () => Promise<unknown> }).run = async () => {
            projections += 1;
            return run();
          };
        }
        return statement;
      });

      await containerInstance.collectMetrics();

      expect(projections).toBe(1);
      const projected = await mockKV.get('session:test-bucket:testsession123456', 'json') as Session & {
        lifecycleGeneration?: number;
        observationSequence?: number;
      };
      expect(projected.status).toBe('running');
      expect(projected.lifecycleGeneration).toBe(0);
      expect(projected.observationSequence).toBe(0);
      expect(projected.metrics).toMatchObject({ cpu: '45%', mem: '1024MB', hdd: '2.5GB' });
    });

    it('continues without transport recovery when the lifecycle projection fails', async () => {
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      } as Session);
      const d1 = (containerInstance as unknown as { env: { USAGE_DB: D1Database } }).env.USAGE_DB;
      const prepare = d1.prepare.bind(d1);
      vi.spyOn(d1, 'prepare').mockImplementation((sql: string) => {
        const statement = prepare(sql);
        if (sql.includes('observation_sequence=?4')) {
          (statement as unknown as { run: () => Promise<unknown> }).run = async () => {
            throw new Error('D1 unavailable');
          };
        }
        return statement;
      });

      await containerInstance.collectMetrics();

      expect(testState.abortReasons).toEqual([]);
      expect(testState.stopCalls).toBe(0);
      expect(testState.scheduleCalls).toContainEqual([60, 'collectMetrics']);
    });

    it('propagates a required ownership-read retry alarm failure without billing or destructive effects', async () => {
      const key = 'session:test-bucket:testsession123456';
      mockKV._set(key, {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        workspace: 'terminal', createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      } as Session);
      await enableTimekeeper({ quotaExceeded: true });
      testState.storageGetFailures.add(TRANSPORT_RECOVERY_KEY);
      testState.scheduleFailuresRemaining = 1;

      const errors: unknown[] = [];
      mockLogger.error.mockImplementation((...args: unknown[]) => { errors.push(args[2]); });
      try {
        const observed = containerInstance.collectMetrics().then(
          () => ({ ok: true }),
          error => ({ ok: false, error }),
        );
        expect(await observed).toMatchObject({ ok: false, error: new Error('schedule failed') });
        expect(errors).toContainEqual(expect.objectContaining({
          sessionId: 'testsession123456', lifecycleGeneration: 0,
          incidentId: null, errorClass: 'schedule_failed',
        }));
        expect(JSON.stringify(errors)).not.toContain('agent-event-token');
      } finally { mockLogger.error.mockReset(); }

      expect(testState.scheduleCalls).toEqual([]);
      expect(testState.callOrder).toEqual([]);
      expect(testState.platformStopSignals).toEqual([]);
      expect(testState.abortReasons).toEqual([]);
      expect(await storage().get('usageSeconds')).toBeUndefined();
      expect(await mockKV.get(key, 'json')).toMatchObject({ status: 'running', workspace: 'terminal' });
    });

    it('REQ-SESSION-026 AC1: required alarm failure retains the observed D1 incident identity', async () => {
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      } as Session);
      testState.tcpFetchShouldFail = true;
      testState.scheduleFailuresRemaining = 1;
      const errors: unknown[] = [];
      mockLogger.error.mockImplementation((...args: unknown[]) => { errors.push(args[2]); });
      try {
        await expect(containerInstance.collectMetrics()).rejects.toThrow('schedule failed');
        const env = (containerInstance as unknown as { env: { USAGE_DB: D1Database } }).env;
        const session = await new D1SessionRepository(env.USAGE_DB).getSession('test-bucket', 'testsession123456');
        expect(session?.unreachableIncidentId).toEqual(expect.any(String));
        expect(errors).toContainEqual(expect.objectContaining({
          sessionId: 'testsession123456', lifecycleGeneration: 0,
          incidentId: session?.unreachableIncidentId, errorClass: 'schedule_failed',
        }));
        expect(await storage().get('usageSeconds')).toBeUndefined();
        expect(JSON.stringify(errors)).not.toContain('agent-event-token');
      } finally { mockLogger.error.mockReset(); }
    });

    it.each(['stop', 'error'] as const)('REQ-SESSION-026 AC1: %s callback alarm failures retain captured context and ownership', async (callback) => {
      const key = 'session:test-bucket:testsession123456';
      mockKV._set(key, {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running', lifecycleGeneration: 0,
        createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      } as Session);
      const env = (containerInstance as unknown as { env: { USAGE_DB: D1Database } }).env;
      const incident = await new D1SessionRepository(env.USAGE_DB).observeUnreachable(
        'test-bucket', 'testsession123456', 0, 0, 'observed-incident', Date.now(),
      );
      expect(incident?.unreachableIncidentId).toBe('observed-incident');
      testState.scheduleFailuresRemaining = 1;
      const errors: unknown[] = [];
      mockLogger.error.mockImplementation((...args: unknown[]) => { errors.push(args[2]); });
      try {
        await expect(callback === 'stop'
          ? containerInstance.onStop()
          : containerInstance.onError(new Error('Network connection lost.'))).rejects.toThrow('schedule failed');
        expect(errors).toContainEqual(expect.objectContaining({
          sessionId: 'testsession123456', lifecycleGeneration: 0,
          incidentId: callback === 'stop' ? 'observed-incident' : null, errorClass: 'schedule_failed',
        }));
        expect(await mockKV.get(key, 'json')).toMatchObject({ status: 'unreachable', unreachableIncidentId: 'observed-incident' });
        expect(await storage().get('usageSeconds')).toBeUndefined();
      } finally { mockLogger.error.mockReset(); }
    });

    it('deliberate shutdown still suppresses an unnecessary ownership-read retry alarm', async () => {
      await storage().put('shutdownRequested', Date.now());
      testState.storageGetFailures.add(TRANSPORT_RECOVERY_KEY);
      testState.scheduleFailuresRemaining = 1;

      await expect(containerInstance.collectMetrics()).resolves.toBeUndefined();

      expect(testState.scheduleCalls).toEqual([]);
      expect(testState.platformStopSignals).toEqual([]);
      expect(testState.abortReasons).toEqual([]);
    });

    it('REQ-GITHUB-015 AC1: tracks the repositories the container reports in its workspace', async () => {
      const key = 'session:test-bucket:testsession123456';
      testState.healthResult.workspaceRepos = [
        { repo: 'octo/web' },
        { repo: 'octo/api', ref: 'develop' },
      ];
      mockKV._set(key, {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running',
        clone: { repo: 'octo/api', ref: 'develop' },
        createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);

      await containerInstance.collectMetrics();

      expect((await mockKV.get(key, 'json') as Session).clones).toEqual([
        { repo: 'octo/api', ref: 'develop' },
        { repo: 'octo/web' },
      ]);
    });

    it('REQ-GITHUB-015 AC1: stops tracking a repository the user removed from the workspace', async () => {
      const key = 'session:test-bucket:testsession123456';
      testState.healthResult.workspaceRepos = [{ repo: 'octo/api', ref: 'develop' }];
      mockKV._set(key, {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running',
        clones: [{ repo: 'octo/api', ref: 'develop' }, { repo: 'octo/gone' }],
        createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);

      await containerInstance.collectMetrics();

      expect((await mockKV.get(key, 'json') as Session).clones).toEqual([{ repo: 'octo/api', ref: 'develop' }]);
    });

    it('REQ-GITHUB-015 AC2: refuses malformed reported repositories and leaves tracking untouched', async () => {
      const key = 'session:test-bucket:testsession123456';
      testState.healthResult.workspaceRepos = 'octo/api';
      mockKV._set(key, {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running',
        clones: [{ repo: 'octo/api' }],
        createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);

      await containerInstance.collectMetrics();

      expect((await mockKV.get(key, 'json') as Session).clones).toEqual([{ repo: 'octo/api' }]);

      testState.healthResult.workspaceRepos = [{ repo: 'no-slash' }, { repo: 'octo/kept' }];
      await containerInstance.collectMetrics();

      expect((await mockKV.get(key, 'json') as Session).clones).toEqual([{ repo: 'octo/kept' }]);
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
      const putCall = [...mockKV.put.mock.calls].reverse().find(
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

    it('REQ-SESSION-009 AC4: skips a running-session metrics write after shutdown begins', async () => {
      const key = 'session:test-bucket:testsession123456';
      mockKV._set(key, {
        id: 'testsession123456',
        name: 'Do not recreate',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      await (containerInstance as unknown as { ctx: { storage: { put: (k: string, v: unknown) => Promise<void> } } })
        .ctx.storage.put('shutdownRequested', Date.now());

      await containerInstance.collectMetrics();

      expect(mockKV.put.mock.calls.some(([writtenKey]) => writtenKey === key)).toBe(false);
      expect(testState.scheduleCalls).toEqual([]);
    });

    it('REQ-SESSION-009 AC4: rechecks shutdown after an in-flight primary session read', async () => {
      const key = 'session:test-bucket:testsession123456';
      mockKV._set(key, {
        id: 'testsession123456',
        name: 'Delete race',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);
      const originalGet = mockKV.get.getMockImplementation()!;
      let releaseRead!: () => void;
      let markReadStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
      const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
      mockKV.get.mockImplementation(async (readKey, type) => {
        const captured = originalGet(readKey, type);
        if (readKey === key) {
          markReadStarted();
          await readRelease;
        }
        return captured;
      });

      const metrics = containerInstance.collectMetrics();
      await readStarted;
      await (containerInstance as unknown as { ctx: { storage: { put: (k: string, v: unknown) => Promise<void> } } })
        .ctx.storage.put('shutdownRequested', Date.now());
      await mockKV.delete(key);
      releaseRead();
      await metrics;

      expect(await originalGet(key, 'json')).toBeNull();
      expect(mockKV.put.mock.calls.some(([writtenKey]) => writtenKey === key)).toBe(false);
      expect(testState.scheduleCalls).toEqual([]);
    });

    // REQ-SESSION-018 AC5: a deliberate stop (persisted shutdown marker set by
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

    // REQ-SESSION-018 AC5: a live container whose KV was wrongly flipped to
    // stopped (e.g. by onError on a transient error) self-heals back to running
    // rather than hanging falsely-stopped on the dashboard until a restart.
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

      expect(testState.scheduleCalls).toContainEqual([5, 'collectMetrics']);
    }, 25_000);

    it('REQ-SESSION-021/022: a monitor transport error schedules a no-start host observation before reconstruction', async () => {
      testState.containerRunning = false;
      await containerInstance.onError(new Error('Network connection lost.'));
      expect(testState.abortReasons).toEqual([]);
      expect(testState.scheduleCalls.at(-1)).toEqual([5, 'collectMetrics']);
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
    it('REQ-SESSION-018 AC7: persistent not-running readings cannot certify process exit', async () => {
      // DO reconstruction can report not-running beyond the old confirmation
      // window while a workload survives. Time alone cannot release ownership.
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
        expect((await mockKV.get('session:test-bucket:testsession123456', 'json') as Session).status).toBe('running');

        vi.advanceTimersByTime(91_000);
        await containerInstance.collectMetrics();
        expect((await mockKV.get('session:test-bucket:testsession123456', 'json') as Session).status).not.toBe('stopped');
        // Uncertainty stays scheduled rather than silently declaring an exit.
        expect(testState.scheduleCalls.at(-1)?.[1]).toBe('collectMetrics');
      } finally {
        vi.useRealTimers();
      }
    });

    it('REQ-SESSION-018 AC7: failed recovery cleanup cannot turn old not-running evidence into stopped', async () => {
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

      expect((await mockKV.get('session:test-bucket:testsession123456', 'json') as Session).status).not.toBe('stopped');
      expect(await storage().get(TRANSPORT_RECOVERY_KEY)).toBeDefined();
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
      expect((await mockKV.get('session:test-bucket:testsession123456', 'json') as Session).status).toBe('running');

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

    it('REQ-SUB-006 AC2 + REQ-SUB-007 AC5: records usage outside SaaS without enforcing a quota response', async () => {
      const timekeeperStub = await enableTimekeeper({ saasMode: false, quotaExceeded: true });
      const stopSpy = vi.spyOn(containerInstance, 'stop');

      await containerInstance.collectMetrics();

      expect(timekeeperStub.fetch).toHaveBeenCalledTimes(1);
      expect((containerInstance as unknown as { _usageSeconds: number })._usageSeconds).toBe(60);
      expect(stopSpy).not.toHaveBeenCalled();
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
        { KV: mockKV, USAGE_DB: createMockSessionD1(mockKV), LOG_LEVEL: 'silent', SAAS_MODE: 'active', TIMEKEEPER },
      );
      // The MockContainer constructor in vi.mock('@cloudflare/containers')
      // resets this.env to { KV: null } and ignores the constructor env arg,
      // so SAAS_MODE and TIMEKEEPER must be assigned post-construction.
      const instanceEnv = (instance as unknown as { env: Record<string, unknown> }).env;
      instanceEnv.KV = mockKV;
      instanceEnv.USAGE_DB = createMockSessionD1(mockKV);
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
        { KV: mockKV, USAGE_DB: createMockSessionD1(mockKV), LOG_LEVEL: 'silent', SAAS_MODE: 'active', TIMEKEEPER },
      );
      const instanceEnv = (instance as unknown as { env: Record<string, unknown> }).env;
      instanceEnv.KV = mockKV;
      instanceEnv.USAGE_DB = createMockSessionD1(mockKV);
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

    it('REQ-SESSION-011 AC6 / REQ-SESSION-032 AC1: quota-stop drains final agent events, then final sync, then stop', async () => {
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
        { KV: mockKV, USAGE_DB: createMockSessionD1(mockKV), LOG_LEVEL: 'silent', SAAS_MODE: 'active', TIMEKEEPER },
      );
      const instanceEnv = (instance as unknown as { env: Record<string, unknown> }).env;
      instanceEnv.KV = mockKV;
      instanceEnv.USAGE_DB = createMockSessionD1(mockKV);
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
      expect(testState.agentFinalDrainCalls).toBe(1);
      expect(testState.callOrder).toEqual(['agent-events-final', 'finalsync', 'stop']);
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
        { KV: mockKV, USAGE_DB: createMockSessionD1(mockKV), LOG_LEVEL: 'silent', SAAS_MODE: 'active', TIMEKEEPER },
      );
      const instanceEnv = (instance as unknown as { env: Record<string, unknown> }).env;
      instanceEnv.KV = mockKV;
      instanceEnv.USAGE_DB = createMockSessionD1(mockKV);
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
    it('uses fail-safe 12h default when storage has no sleepAfter', async () => {
      // Storage returns undefined for 'sleepAfter'.
      // Class-field default is '12h' (max safe). Container has been idle for 1 hour.
      // 1h < 12h → container should NOT be stopped.
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
      // falling back to the class-field default ('12h').
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

      // 30m < 12h fallback → no stop
      expect(testState.stopCalls).toBe(0);
    });
  });

  it('REQ-SESSION-018 AC7: an SDK callback with missing identity cannot alter another session', async () => {
    testState.storedSessionId = undefined;
    testState.storedBucketName = null;
    const other: Session = {
      id: 'testsession123456', name: 'Other', userId: 'test-bucket', status: 'running',
      createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
    };
    mockKV._set('session:test-bucket:testsession123456', other);
    const instance = createContainerInstance();
    await instance.onStop();
    expect(await mockKV.get('session:test-bucket:testsession123456', 'json')).toMatchObject({
      status: 'running', userId: 'test-bucket',
    });
  });

  describe('confirmed stopped projection', () => {
    it('REQ-SESSION-018 AC7: synthetic SDK onStop cannot confirm D1 stopped', async () => {
      // Seed a session with metrics
      const session: Session = {
        id: 'testsession123456',
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
        lastActiveAt: '2024-01-15T09:25:00.000Z',
        metrics: {
          cpu: '25%',
          mem: '512MB',
          hdd: '1GB',
          syncStatus: 'success',
          updatedAt: '2024-01-15T10:00:00.000Z',
        },
      };
      mockKV._set('session:test-bucket:testsession123456', session);

      // The SDK can synthesize onStop after a DO reset from a false
      // running=false observation; no positive exit proof was supplied.
      await containerInstance.onStop();
      const stored = await mockKV.get('session:test-bucket:testsession123456', 'json') as Session;
      expect(stored.status).toBe('running');
      expect(stored.metrics?.cpu).toBe('25%');
      expect(stored.lastActiveAt).toBe('2024-01-15T09:25:00.000Z');
      expect(testState.scheduleCalls.at(-1)).toEqual([60, 'collectMetrics']);
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
    mockKV._set('session:test-bucket:testsession123456', {
      id: 'testsession123456', userId: 'test-bucket', name: 'Test', status: 'running',
      createdAt: '2027-01-01T00:00:00.000Z', lastAccessedAt: '2027-01-01T00:00:00.000Z',
      lifecycleGeneration: 0, observationSequence: -1,
    });
    testState.containerRunning = true;
    testState.storedSessionId = 'testsession123456';
    testState.storedBucketName = 'test-bucket';
    testState.tcpFetchShouldFail = false;
    testState.hostProbeCalls = 0;
    testState.activityFetchShouldFail = false;
    testState.healthFetchShouldFail = false;
    testState.activityStatus = 200;
    testState.healthStatus = 200;
    testState.abortReasons = [];
    testState.finalSyncCalls = 0;
    testState.finalSyncStatus = 200;
    testState.agentDrainCalls = 0;
    testState.agentFinalDrainCalls = 0;
    testState.agentDrainStatus = 200;
    testState.agentAckDrainStatus = 200;
    testState.agentDrainEvents = [];
    testState.agentDrainRequests = [];
    sendAgentEventPushesMock.mockReset();
    sendAgentEventPushesMock.mockImplementation(async ({ events }: { events: Array<{ eventId: string }> }) => ({
      sentEventIds: events.map((event) => event.eventId),
    }));
    testState.callOrder = [];
    testState.storageGetFailures.clear();
    testState.storageStore.clear();
    testState.storageStore.set('containerAuthToken', 'agent-event-token');
    testState.storageStore.set('lifecycleGeneration', 0);
    testState.storageStore.set('observationSequence', -1);
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
      { KV: mockKV, USAGE_DB: createMockSessionD1(mockKV), LOG_LEVEL: 'silent' },
    );
    (containerInstance as unknown as { env: { KV: MockKV; USAGE_DB: D1Database } }).env = { KV: mockKV, USAGE_DB: createMockSessionD1(mockKV) };
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
    it('REQ-SESSION-032 AC1: calls final agent-event drain, then final sync, then stop', async () => {
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
      expect(testState.agentFinalDrainCalls).toBe(1);
      expect(testState.finalSyncCalls).toBe(1);
      expect(testState.callOrder).toEqual(['agent-events-final', 'finalsync', 'stop']);
    });

    it('REQ-SESSION-032 AC6: an event-drain failure still runs final sync and stop', async () => {
      testState.storedSleepAfter = '15m';
      testState.activityResult = {
        hasActiveConnections: false,
        connectedClients: 0,
        lastInputAt: Date.now() - (30 * 60 * 1000),
      };
      testState.agentDrainStatus = 500;
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);

      await containerInstance.collectMetrics();

      expect(testState.agentFinalDrainCalls).toBe(1);
      expect(testState.finalSyncCalls).toBe(1);
      expect(testState.stopCalls).toBe(1);
      expect(testState.callOrder).toEqual(['agent-events-final', 'finalsync', 'stop']);
    });

    it('REQ-SESSION-032 AC7: final-sync failure preserves the event attempt and still stops', async () => {
      testState.storedSleepAfter = '15m';
      testState.activityResult = {
        hasActiveConnections: false,
        connectedClients: 0,
        lastInputAt: Date.now() - (30 * 60 * 1000),
      };
      testState.finalSyncStatus = 504;
      mockKV._set('session:test-bucket:testsession123456', {
        id: 'testsession123456', name: 'Test', userId: 'test-bucket', status: 'running',
        createdAt: '2024-01-15T09:00:00.000Z', lastAccessedAt: '2024-01-15T09:30:00.000Z',
      } as Session);

      await containerInstance.collectMetrics();

      expect(testState.agentFinalDrainCalls).toBe(1);
      expect(testState.finalSyncCalls).toBe(1);
      expect(testState.stopCalls).toBe(1);
      expect(testState.callOrder).toEqual(['agent-events-final', 'finalsync', 'stop']);
    });
  });
});
