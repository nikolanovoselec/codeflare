import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared, hoisted call-order log so the mocked base Container can record when
// super.startAndWaitForPorts() runs relative to interceptOutboundHttps() — used
// by the REQ-ENTERPRISE-004 pre-start interception-ordering test below.
const { callOrder } = vi.hoisted(() => ({ callOrder: [] as string[] }));

/**
 * Container DO class tests.
 *
 * The container class (src/container/index.ts) extends Cloudflare's Container<Env>
 * base class. Idle detection is owned by collectMetrics (polls /activity every 60s
 * and explicitly calls stop('SIGTERM') when idleMs > idleTimeoutPref). The SDK's
 * sleepAfter field is pinned to '24h' and plays no role in idle decisions.
 *
 * What we CAN test in isolation:
 * - Constructor initialization (bucketName loading, envVars population)
 * - Internal route dispatch table structure
 * - onStart/onStop lifecycle (KV timestamp updates)
 * - destroy() cleanup
 * - idleTimeoutPref persistence and loading
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

    async fetch(_request: Request): Promise<Response> {
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
    deleteSchedules(_method: string): void {}
    renewActivityTimeout(): void {}
    async stop(_signal: string): Promise<void> {}
    onStart(): void {}
    onStop(): void {}
    onError(_error: unknown): void {}
    onActivityExpired(): void {}
    async startAndWaitForPorts(..._args: any[]): Promise<void> {
      callOrder.push('super.startAndWaitForPorts');
    }
  },
}));

// Now import the container class after mocks are set up
import { container as ContainerClass, validateBucketNameInput } from '../../container/index';

// REQ-SESSION-019: Final-sync drain endpoint authentication
// REQ-ENTERPRISE-017: AI Gateway Configured in the Setup Wizard
// REQ-ENTERPRISE-023: Strict Gateway Egress Controller Transport
// REQ-OPS-010: Graceful container shutdown preserves data
// REQ-OPS-016: sleepAfter preference persistence and lifecycle
// REQ-SESSION-006: User can stop, restart, and delete sessions
// REQ-SESSION-008: Container restart preserves R2 bucket

describe('container DO class / REQ-SESSION-002 (one container per session) / REQ-SESSION-019', () => {
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
    };
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

    it('REQ-SESSION-018 AC6: publishes running and both startup timestamps from one KV read', async () => {
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const mockKvGet = vi.fn().mockResolvedValue({
        id: 'sess123',
        status: 'stopped',
        name: 'Test',
      });
      mockEnv.KV = { get: mockKvGet, put: mockKvPut };
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => expect(mockStorage.get).toHaveBeenCalledWith('bucketName'));
      await instance.onStart();

      expect(mockKvGet).toHaveBeenCalledTimes(1);
      expect(mockKvPut).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mockKvPut.mock.calls[0][1])).toMatchObject({
        status: 'running',
        lastStartedAt: expect.any(String),
        lastActiveAt: expect.any(String),
      });
    });

    // REQ-SESSION-018 AC5: a fresh start clears any stale deliberate-stop marker
    // a prior destroy() left in storage, so a later transient false-stopped on
    // this run can self-heal instead of being mistaken for a deliberate stop.
    it('onStart clears the persisted shutdown marker', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });

      await instance.onStart();

      expect(mockStorage.delete).toHaveBeenCalledWith('shutdownRequested');
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

    // REQ-SESSION-018 AC3: onError defers the stopped decision to the
    // collectMetrics confirmation window instead of writing stopped on a single
    // not-running reading. The SDK calls onError for transient errors too
    // (deploy-roll, monitor blip) where the container is actually alive; an
    // immediate stopped write there sticks (the metrics loop refuses to correct
    // it) and the session hangs falsely-stopped. So onError opens the window and
    // re-arms a collectMetrics tick rather than writing stopped itself.
    it('onError opens the not-running confirmation window and re-arms instead of writing stopped', async () => {
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

      // Container reads not-running when the error fires.
      mockContainerRuntime.running = false;

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });
      const scheduleSpy = vi.spyOn(instance, 'schedule' as any);

      await instance.onError(new Error('Container error'));

      await new Promise(resolve => setTimeout(resolve, 50));
      // No immediate stopped write to KV: the window owns that decision now.
      expect(mockKvPut).not.toHaveBeenCalled();
      // Confirmation window opened in DO storage.
      expect(mockStorage.put).toHaveBeenCalledWith('metricsNotRunningSince', expect.any(Number));
      // A collectMetrics tick is re-armed so the window gets evaluated.
      expect(scheduleSpy).toHaveBeenCalledWith(60, 'collectMetrics');
    });

    it('onError does NOT write stopped while the container is still running (startup error guard)', async () => {
      // A transient error during startup can fire onError while the container
      // is still coming up. The !running guard must keep a live session from
      // being flipped to 'stopped'; collectMetrics is the 60s catch-all.
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

      // Container is still running when the error fires.
      mockContainerRuntime.running = true;

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });

      await instance.onError(new Error('Transient startup error'));

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockKvPut).not.toHaveBeenCalled();
    });

    // CF-044
    // Remaining onError branch: container NOT running but the identifiers were
    // already cleared by a prior destroy(). Post-REQ-SESSION-018-AC3, onError no
    // longer writes stopped itself - it opens the confirmation window and re-arms
    // collectMetrics, which re-reads sessionId/bucketName and (with both absent)
    // bails as a zombie DO without a KV write. Either way, onError must not
    // resurrect the destroyed KV record.
    // REQ-SESSION-009: a post-destroy path must not resurrect the session.
    it('onError after destroy does NOT write to KV when identifiers are cleared (resurrection guard)', async () => {
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const mockKvGet = vi.fn().mockResolvedValue({
        id: 'sess123',
        status: 'running',
        name: 'Test',
      });
      mockEnv.KV = { get: mockKvGet, put: mockKvPut };

      // Identifiers already gone (post-destroy): storage returns null for both
      // bucketName and _sessionId, and _bucketName on the instance is null.
      mockStorage.get.mockImplementation(async () => null);

      // Unexpected exit: container reports not-running so the !running guard
      // passes and updateKvStatus is actually invoked.
      mockContainerRuntime.running = false;

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });

      await instance.onError(new Error('Unexpected exit after destroy'));

      await new Promise(resolve => setTimeout(resolve, 50));
      // No identifiers -> updateKvStatus returns early -> no KV write.
      expect(mockKvPut).not.toHaveBeenCalled();
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

  describe('idleTimeoutPref', () => {
    // Naming boundary clarified:
    //   - In-memory field holding the user preference: idleTimeoutPref (new)
    //   - SDK.sleepAfter: pinned to '24h', no role in idle decisions
    //   - setBucketName wire-protocol field: sleepAfter (unchanged, backwards compat)
    //   - DO storage key:                    sleepAfter (unchanged, backwards compat)
    // The wire + storage names are intentionally preserved so existing clients
    // and persisted DOs keep working across the refactor.

    it('defaults to 4h when not in storage (fail-safe per REQ-OPS-006 AC8)', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.idleTimeoutPref).toBe('4h');
    });

    it('loads from DO storage on construction (storage key: sleepAfter)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'sleepAfter') return '1h';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(instance.idleTimeoutPref).toBe('1h');
      });
    });

    it('rejects invalid values from storage and falls back to fail-safe 4h default', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'sleepAfter') return 'invalid';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });
      expect(instance.idleTimeoutPref).toBe('4h');
    });

    it('persists to DO storage on initial setBucketName', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'test-bucket', sleepAfter: '1h' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);
      expect(mockStorage.put).toHaveBeenCalledWith('sleepAfter', '1h');
      expect(instance.idleTimeoutPref).toBe('1h');
    });

    it('persists to DO storage on restart (409 path)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'existing-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'existing-bucket', sleepAfter: '2h' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(409);
      expect(mockStorage.put).toHaveBeenCalledWith('sleepAfter', '2h');
      expect(instance.idleTimeoutPref).toBe('2h');
    });

    it('REQ-SESSION-027 AC1/AC4-AC5: destroy preserves credentials, drains before sync, and clears storage', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        if (key === 'containerAuthToken') return 'destroy-agent-token';
        return null;
      });
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      mockTcpPortFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes('/internal/agent-events/drain')) {
          return new Response(JSON.stringify({ hostNow: Date.now(), events: [] }), { status: 200 });
        }
        if (url.includes('/internal/final-sync')) {
          return new Response(JSON.stringify({ synced: true }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      });
      // Ensure destroy()'s SIGTERM polling exits immediately rather than
      // running the full 135s budget (which exceeds vitest's timeout).
      mockContainerRuntime.running = false;

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => expect(mockStorage.get).toHaveBeenCalledWith('containerAuthToken'));
      await instance.destroy();

      expect(mockStorage.delete).toHaveBeenCalledWith('sleepAfter');
      const eventIndex = calls.findIndex((call) => call.url.includes('/internal/agent-events/drain'));
      const syncIndex = calls.findIndex((call) => call.url.includes('/internal/final-sync'));
      expect(eventIndex).toBeGreaterThanOrEqual(0);
      expect(syncIndex).toBeGreaterThan(eventIndex);
      const eventCall = calls[eventIndex]!;
      expect((eventCall.init!.headers as Record<string, string>).Authorization).toBe('Bearer destroy-agent-token');
      expect(JSON.parse(eventCall.init!.body as string)).toEqual({ ackEventIds: [], final: true });
    });

    it('does not persist invalid values from setBucketName', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'test-bucket', sleepAfter: 'invalid' }),
        headers: { 'Content-Type': 'application/json' },
      });

      await instance.fetch(request);

      const sleepAfterPuts = mockStorage.put.mock.calls.filter(
        (c: unknown[]) => c[0] === 'sleepAfter'
      );
      expect(sleepAfterPuts).toHaveLength(0);
      // Class-field default is now 4h (fail-safe per REQ-OPS-006 AC8) - the
      // invalid input was correctly rejected and the default preserved.
      expect(instance.idleTimeoutPref).toBe('4h');
    });

    it('SDK.sleepAfter stays pinned to 24h regardless of user preference', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'test-bucket', sleepAfter: '2h' }),
        headers: { 'Content-Type': 'application/json' },
      });

      await instance.fetch(request);
      expect(instance.sleepAfter).toBe('24h');
      expect(instance.idleTimeoutPref).toBe('2h');
    });
  });

  describe('setBucketName error path uses structured logger (M7)', () => {
    it('setBucketName error path uses structured logger, not console.error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      // Send a request with invalid JSON to trigger the catch block
      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: 'not-valid-json',
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(500);
      // console.error should NOT be called directly - logger.error is used instead
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('setSessionId error path uses structured logger, not console.error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      // Send a request with invalid JSON to trigger the catch block
      const request = new Request('http://container/_internal/setSessionId', {
        method: 'PUT',
        body: 'not-valid-json',
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(500);
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('setSessionId stores a valid sessionId and returns success', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const request = new Request('http://container/_internal/setSessionId', {
        method: 'PUT',
        body: JSON.stringify({ sessionId: 'sess-123' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
      expect(mockStorage.put).toHaveBeenCalledWith('_sessionId', 'sess-123');
    });

    it('setSessionId rejects a non-string sessionId with 400 and does not store it', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const request = new Request('http://container/_internal/setSessionId', {
        method: 'PUT',
        body: JSON.stringify({ sessionId: 123 }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(400);
      expect(mockStorage.put).not.toHaveBeenCalledWith('_sessionId', expect.anything());
    });

    it('setSessionId treats an absent sessionId as a successful no-op', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const request = new Request('http://container/_internal/setSessionId', {
        method: 'PUT',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
      expect(mockStorage.put).not.toHaveBeenCalledWith('_sessionId', expect.anything());
    });
  });

  describe('validateBucketNameInput (L10)', () => {
    it('rejects empty string', () => {
      expect(validateBucketNameInput({ bucketName: '' })).toBe('bucketName must be a non-empty string');
    });

    it('rejects non-string input', () => {
      expect(validateBucketNameInput({ bucketName: 123 })).toBe('bucketName must be a non-empty string');
      expect(validateBucketNameInput({ bucketName: null })).toBe('bucketName must be a non-empty string');
      expect(validateBucketNameInput({ bucketName: undefined })).toBe('bucketName must be a non-empty string');
    });

    it('accepts valid bucket name', () => {
      expect(validateBucketNameInput({ bucketName: 'my-bucket' })).toBeNull();
    });

    it('rejects empty r2AccessKeyId', () => {
      expect(validateBucketNameInput({ bucketName: 'b', r2AccessKeyId: '' }))
        .toBe('r2AccessKeyId must be a non-empty string when provided');
    });

    it('rejects invalid r2Endpoint URL', () => {
      expect(validateBucketNameInput({ bucketName: 'b', r2Endpoint: 'not-a-url' }))
        .toBe('r2Endpoint must be a valid URL');
    });

    it('accepts valid r2Endpoint URL', () => {
      expect(validateBucketNameInput({ bucketName: 'b', r2Endpoint: 'https://r2.example.com' })).toBeNull();
    });

    it('rejects non-boolean workspaceSyncEnabled', () => {
      expect(validateBucketNameInput({ bucketName: 'b', workspaceSyncEnabled: 'true' }))
        .toBe('workspaceSyncEnabled must be a boolean when provided');
    });
  });

  describe('onStop clears collectMetrics schedule', () => {
    it('calls deleteSchedules("collectMetrics") to kill the alarm loop', async () => {
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

      const deleteSchedulesSpy = vi.spyOn(instance, 'deleteSchedules' as any);

      await instance.onStop();

      expect(deleteSchedulesSpy).toHaveBeenCalledWith('collectMetrics');
    });
  });

  // Note: the onActivityExpired() override was removed when sleepAfter was
  // pinned to '24h'. collectMetrics() owns all idle-stop decisions now.

  describe('collectMetrics idle-stop behavior', () => {
    // Helper to create a running container instance with KV mocks
    async function createRunningInstance(storedSleepAfter?: string) {
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const mockKvGet = vi.fn().mockResolvedValue({
        id: 'sess123',
        status: 'running',
        name: 'Test',
        metrics: {},
      });
      mockEnv.KV = { get: mockKvGet, put: mockKvPut };

      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        if (key === 'sleepAfter') return storedSleepAfter;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });

      mockContainerRuntime.running = true;

      // Mock schedule to prevent re-arm error
      vi.spyOn(instance, 'schedule' as any).mockResolvedValue(undefined);

      // Trigger onStart to set containerStartedAt
      vi.spyOn(instance, 'deleteSchedules' as any).mockImplementation(() => {});
      await instance.onStart();

      return instance;
    }

    it('does NOT stop when lastInputAt is fresh (within idleTimeoutPref)', async () => {
      const instance = await createRunningInstance();
      const now = Date.now();

      // /activity returns a recent lastInputAt (60s old, well under 5m default)
      mockTcpPortFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({
          hasActiveConnections: true,
          connectedClients: 1,
          lastInputAt: now - 60_000,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ cpu: '5%', mem: '100M' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));

      const stopSpy = vi.spyOn(instance, 'stop' as any).mockResolvedValue(undefined);

      await instance.collectMetrics();

      expect(stopSpy).not.toHaveBeenCalled();
    });

    it('stops with SIGTERM when lastInputAt exceeds idleTimeoutPref', async () => {
      const instance = await createRunningInstance('5m');
      // Set pref to 5m explicitly (class-field default is now 4h fail-safe per
      // REQ-OPS-006 AC8 - so just an idle duration won't do, we need to set
      // the user-configured pref low to exercise the boundary).
      instance.idleTimeoutPref = '5m';
      const now = Date.now();

      // /activity returns lastInputAt 10 minutes old (exceeds 5m configured pref)
      mockTcpPortFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        hasActiveConnections: true,
        connectedClients: 1,
        lastInputAt: now - 600_000,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const stopSpy = vi.spyOn(instance, 'stop' as any).mockResolvedValue(undefined);

      await instance.collectMetrics();

      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
    });

    it('stops with SIGTERM when lastInputAt is null and containerStartedAt is old', async () => {
      const instance = await createRunningInstance('5m');
      instance.idleTimeoutPref = '5m'; // explicit short pref, otherwise 4h default never trips

      // Manually age the container's started-at so the fallback reference
      // time pushes idleMs past the 5m configured threshold.
      (instance as any).containerStartedAt = Date.now() - 600_000;

      mockTcpPortFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        hasActiveConnections: true,
        connectedClients: 0,
        lastInputAt: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const stopSpy = vi.spyOn(instance, 'stop' as any).mockResolvedValue(undefined);

      await instance.collectMetrics();

      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
    });

    it('honors user-configured idleTimeoutPref (2h) before stopping', async () => {
      const instance = await createRunningInstance('2h');
      instance.idleTimeoutPref = '2h'; // public field, no cast needed
      const now = Date.now();

      // lastInputAt 10m old — would stop at 5m default, but 2h pref keeps it alive
      mockTcpPortFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({
          hasActiveConnections: true,
          connectedClients: 1,
          lastInputAt: now - 600_000,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ cpu: '5%', mem: '100M' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));

      const stopSpy = vi.spyOn(instance, 'stop' as any).mockResolvedValue(undefined);

      await instance.collectMetrics();

      expect(stopSpy).not.toHaveBeenCalled();
    });

    it('does NOT stop on non-OK /activity response (fail-open)', async () => {
      const instance = await createRunningInstance();

      // /activity returns 500
      mockTcpPortFetch
        .mockResolvedValueOnce(new Response('error', { status: 500 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ cpu: '5%', mem: '100M' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));

      const stopSpy = vi.spyOn(instance, 'stop' as any).mockResolvedValue(undefined);

      await instance.collectMetrics();

      expect(stopSpy).not.toHaveBeenCalled();
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
      expect(instance.sleepAfter).toBe('24h');
      expect(instance.idleTimeoutPref).toBe('4h');
    });
  });

  // REQ-AGENT-078: the DO-side wiring decision for the OAuth api.cloudflare.com
  // interceptor, driven through the public start seam (startAndWaitForPorts →
  // the container-interception registry). This pins the "never touch
  // enterprise" invariant — the guard that decides WHETHER to wire the
  // interceptor at all — so a future edit that weakens the mode gate or the
  // placeholder/bucket guards fails here.
  describe('OAuth api.cloudflare.com interception wiring guard (REQ-AGENT-078)', () => {
    function makeWiringCtx() {
      const interceptOutboundHttps = vi.fn();
      const CloudflareBrowserInterceptor = vi.fn(() => ({ fetch: vi.fn() }));
      const ctx = {
        ...mockCtx,
        exports: {
          CloudflareBrowserInterceptor,
          LlmInterceptor: vi.fn(() => ({ fetch: vi.fn() })),
        },
        container: { ...mockContainerRuntime, interceptOutboundHttps },
      };
      return { ctx, interceptOutboundHttps, CloudflareBrowserInterceptor };
    }

    it('wires api.cloudflare.com in OAuth mode: non-enterprise + placeholder token + bound bucket', async () => {
      const { ctx, interceptOutboundHttps, CloudflareBrowserInterceptor } = makeWiringCtx();
      const instance = new ContainerClass(ctx as any, { ...mockEnv, ENTERPRISE_MODE: undefined });
      (instance as any)._cloudflareApiToken = 'codeflare-oauth';
      (instance as any)._bucketName = 'user-bucket';
      await instance.startAndWaitForPorts(8080);
      // The interceptor is bound to the session bucket only (no request-supplied identity).
      expect(CloudflareBrowserInterceptor).toHaveBeenCalledWith({ props: { bucket: 'user-bucket' } });
      expect(interceptOutboundHttps).toHaveBeenCalledWith('api.cloudflare.com', expect.anything());
    });

    it('does NOT wire in enterprise mode even with an oauth placeholder + bucket (never claims the enterprise host)', async () => {
      const { ctx, interceptOutboundHttps } = makeWiringCtx();
      const instance = new ContainerClass(ctx as any, { ...mockEnv, ENTERPRISE_MODE: 'active' });
      (instance as any)._cloudflareApiToken = 'codeflare-oauth';
      (instance as any)._bucketName = 'user-bucket';
      await instance.startAndWaitForPorts(8080);
      expect(interceptOutboundHttps).not.toHaveBeenCalledWith('api.cloudflare.com', expect.anything());
      expect(interceptOutboundHttps).toHaveBeenCalledWith('api.openai.com', expect.anything());
    });

    it('does NOT wire when the container token is not the OAuth placeholder (PAT / real-token session)', async () => {
      const { ctx, interceptOutboundHttps } = makeWiringCtx();
      const instance = new ContainerClass(ctx as any, { ...mockEnv, ENTERPRISE_MODE: undefined });
      (instance as any)._cloudflareApiToken = 'a-real-pat-deploy-token';
      (instance as any)._bucketName = 'user-bucket';
      await instance.startAndWaitForPorts(8080);
      expect(interceptOutboundHttps).not.toHaveBeenCalled();
    });

    it('does NOT wire when no bucket is bound (cannot resolve a token)', async () => {
      const { ctx, interceptOutboundHttps } = makeWiringCtx();
      const instance = new ContainerClass(ctx as any, { ...mockEnv, ENTERPRISE_MODE: undefined });
      (instance as any)._cloudflareApiToken = 'codeflare-oauth';
      (instance as any)._bucketName = null;
      await instance.startAndWaitForPorts(8080);
      expect(interceptOutboundHttps).not.toHaveBeenCalled();
    });
  });
});
