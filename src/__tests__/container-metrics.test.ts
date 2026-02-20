import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV, MockKV } from './helpers/mock-kv';
import type { Session } from '../types';

// ---------------------------------------------------------------------------
// Shared mutable state — vi.hoisted ensures this runs before vi.mock factories
// ---------------------------------------------------------------------------
const testState = vi.hoisted(() => ({
  storedSessionId: 'testsession123456' as string | undefined,
  storedBucketName: 'test-bucket' as string | null,
  containerRunning: true,
  tcpFetchResult: {
    cpu: '45%',
    mem: '1024MB',
    hdd: '2.5GB',
    syncStatus: 'success',
  } as Record<string, string>,
  tcpFetchShouldFail: false,
  scheduleCalls: [] as Array<[number, string]>,
  kvRef: null as MockKV | null,
}));

// ---------------------------------------------------------------------------
// Module-level mocks — must be before imports that depend on mocked modules
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
            fetch: async () => {
              if (testState.tcpFetchShouldFail) {
                throw new Error('Connection refused');
              }
              return new Response(JSON.stringify(testState.tcpFetchResult), {
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

describe('Container Metrics', () => {
  let mockKV: MockKV;
  let containerInstance: InstanceType<typeof container>;

  beforeEach(async () => {
    mockKV = createMockKV();
    testState.containerRunning = true;
    testState.storedSessionId = 'testsession123456';
    testState.storedBucketName = 'test-bucket';
    testState.tcpFetchShouldFail = false;
    testState.tcpFetchResult = {
      cpu: '45%',
      mem: '1024MB',
      hdd: '2.5GB',
      syncStatus: 'success',
    };
    testState.scheduleCalls = [];
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
    it('should call schedule(5, "collectMetrics") on start', async () => {
      await containerInstance.onStart();

      // Check that schedule was called with correct args
      expect(testState.scheduleCalls).toContainEqual([5, 'collectMetrics']);
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

      // Verify KV was written with metrics
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
      expect(testState.scheduleCalls).toContainEqual([5, 'collectMetrics']);
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

      // Verify metrics were cleared
      expect(mockKV.put).toHaveBeenCalled();
      const putCall = mockKV.put.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('testsession123456')
      );
      expect(putCall).toBeDefined();
      const stored = JSON.parse(putCall![1] as string) as Session;
      expect(stored.status).toBe('stopped');
      expect(stored.metrics).toBeUndefined();
      expect(stored.lastActiveAt).toBeDefined();
    });
  });
});
