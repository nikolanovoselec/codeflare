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
import { container as ContainerClass } from '../../container/index';

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
    transaction: ReturnType<typeof vi.fn>;
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
      transaction: vi.fn(async (fn: (txn: { get: typeof mockStorage.get; put: typeof mockStorage.put }) => Promise<unknown>) =>
        fn({ get: mockStorage.get, put: mockStorage.put })),
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

  describe('constructor', () => {
    it('initializes with defaultPort 8080', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.defaultPort).toBe(8080);
    });

    it('initializes with sleepAfter pinned to 24h (SDK timer disabled)', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.sleepAfter).toBe('24h');
    });

    it('initializes with idleTimeoutPref 4h (fail-safe default per REQ-OPS-006 AC8)', () => {
      // The class-field default is the MAXIMUM supported value (4h), not the
      // minimum. A short fallback would kill the container before storage
      // reads / user-pref writes complete; a long fallback only lets the
      // container live longer than expected. See REQ-OPS-006 AC8 + AD/issue
      // codeflare#294 context.
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.idleTimeoutPref).toBe('4h');
    });

    it('calls blockConcurrencyWhile in constructor', () => {
      new ContainerClass(mockCtx as any, mockEnv);
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalledTimes(1);
    });

    it('restores containerAuthToken from storage so DO wake does not desync from a running container', async () => {
      // Regression for the silent-401 bug: prior to persistence, every DO
      // wake regenerated a fresh UUID via updateEnvVars() while the
      // container process kept its old CONTAINER_AUTH_TOKEN env var, so the
      // Bearer header attached by the fetch override no longer matched and
      // every proxied request received `{"error":"Unauthorized"}` from
      // host/src/server.ts until the user manually recreated the session.
      const PRIOR_TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return PRIOR_TOKEN;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      // Constructor's blockConcurrencyWhile body has multiple sequential
      // awaits before updateEnvVars() fires; vi.waitFor polls until the
      // microtask chain finishes (same pattern as the
      // "constructor loads bucketName and calls updateEnvVars" test).
      await vi.waitFor(() => {
        expect(instance.envVars).toBeDefined();
        expect(instance.envVars?.CONTAINER_AUTH_TOKEN).toBe(PRIOR_TOKEN);
      });
      // Storage.put must NOT be called with a new UUID for this key —
      // we restored, not regenerated.
      const putKeys = mockStorage.put.mock.calls.map((c) => c[0]);
      expect(putKeys).not.toContain('containerAuthToken');
    });

    it('persists a freshly-generated containerAuthToken so subsequent wakes restore it', async () => {
      // No prior token in storage → generator path. Must write back so the
      // next wake's restore branch sees a value and skips re-generation.
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await vi.waitFor(() => {
        expect(instance.envVars).toBeDefined();
        expect(instance.envVars?.CONTAINER_AUTH_TOKEN).toMatch(/^[0-9a-f-]{36}$/);
      });
      const tok = instance.envVars?.CONTAINER_AUTH_TOKEN;

      // And the generated token landed in storage under the same key the
      // restore branch reads, so a subsequent wake will hit the restore
      // path instead of regenerating.
      await vi.waitFor(() => {
        const putCalls = mockStorage.put.mock.calls;
        const tokenPut = putCalls.find((c) => c[0] === 'containerAuthToken');
        expect(tokenPut).toBeDefined();
        expect(tokenPut?.[1]).toBe(tok);
      });
    });

  });

  // REQ-VAULT-008 AC1: Container DO mints a per-session vault encryption
  // key, persists it in ctx.storage, and returns the same value on
  // every read until container.destroy() wipes storage. The key is
  // injected by the Worker into SilverBullet's /.config response so
  // SB encrypts IndexedDB without prompting the user.
  describe('claimBucketOwner / REQ-STOR-001 tenant isolation', () => {
    it('atomically preserves the first allowed owner and rejects a colliding identity', async () => {
      let owner: string | undefined;
      mockStorage.get.mockImplementation(async (key: string) => key === 'bucketOwnerEmail' ? owner : null);
      mockStorage.put.mockImplementation(async (key: string, value: string) => {
        if (key === 'bucketOwnerEmail') owner = value;
      });
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await expect(instance.claimBucketOwner('ab@example.com', true)).resolves.toBe('owned');
      await expect(instance.claimBucketOwner('a+b@example.com', true)).resolves.toBe('conflict');
      expect(owner).toBe('ab@example.com');
      expect(mockStorage.transaction).toHaveBeenCalledTimes(2);
    });

    it('serializes simultaneous ownership claims so exactly one colliding identity wins', async () => {
      let owner: string | undefined;
      let transactionTail = Promise.resolve();
      mockStorage.get.mockImplementation(async (key: string) => key === 'bucketOwnerEmail' ? owner : null);
      mockStorage.put.mockImplementation(async (key: string, value: string) => {
        if (key === 'bucketOwnerEmail') owner = value;
      });
      mockStorage.transaction.mockImplementation((fn: (txn: { get: typeof mockStorage.get; put: typeof mockStorage.put }) => Promise<unknown>) => {
        const result = transactionTail.then(() => fn({ get: mockStorage.get, put: mockStorage.put }));
        transactionTail = result.then(() => undefined, () => undefined);
        return result;
      });
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const results = await Promise.all([
        instance.claimBucketOwner('ab@example.com', true),
        instance.claimBucketOwner('a+b@example.com', true),
      ]);

      expect(results.sort()).toEqual(['conflict', 'owned']);
      expect(owner).toBe('ab@example.com');
    });

    it('refuses an ambiguous first claim without persisting an owner', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await expect(instance.claimBucketOwner('ab@example.com', false)).resolves.toBe('ambiguous');
      expect(mockStorage.put).not.toHaveBeenCalledWith('bucketOwnerEmail', expect.anything());
    });
  });

  describe('ensureVaultKey (REQ-VAULT-008 AC1)', () => {
    it('generates a 32-byte vault key on first call and persists it', async () => {
      // Fresh DO -- no key in storage. ensureVaultKey() must generate
      // 32 random bytes, base64-encode them, persist under the
      // `vaultKey` storage key, and return the encoded string.
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'vaultKey') return null;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      // Constructor blockConcurrencyWhile may have run by now; wait
      // for envVars to be settled so we know init finished.
      // Wait for the constructor's blockConcurrencyWhile body to reach
      // the vaultKey restore -- once the storage.get('vaultKey') call
      // lands in the mock, init is past the relevant restore branch.
      await vi.waitFor(() =>
        expect(mockStorage.get.mock.calls.some((c) => c[0] === 'vaultKey')).toBe(true),
      );

      const key = await (instance as any).ensureVaultKey();
      expect(typeof key).toBe('string');
      // base64 of 32 bytes = 44 chars (including trailing '=' padding).
      expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);

      // Persistence: the storage layer must have been called with
      // ('vaultKey', <key>). Find the last put call for this key.
      const putCall = mockStorage.put.mock.calls.find((c) => c[0] === 'vaultKey');
      expect(putCall).toBeDefined();
      expect(putCall?.[1]).toBe(key);
    });

    it('returns the same key on every subsequent call without re-generating', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'vaultKey') return null;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      // Wait for the constructor's blockConcurrencyWhile body to reach
      // the vaultKey restore -- once the storage.get('vaultKey') call
      // lands in the mock, init is past the relevant restore branch.
      await vi.waitFor(() =>
        expect(mockStorage.get.mock.calls.some((c) => c[0] === 'vaultKey')).toBe(true),
      );

      const first = await (instance as any).ensureVaultKey();
      const second = await (instance as any).ensureVaultKey();
      const third = await (instance as any).ensureVaultKey();

      expect(first).toBe(second);
      expect(second).toBe(third);

      // Only ONE write to storage; subsequent calls must hit the
      // in-memory cache.
      const puts = mockStorage.put.mock.calls.filter((c) => c[0] === 'vaultKey');
      expect(puts.length).toBe(1);
    });

    it('restores an existing key from storage instead of generating a new one (DO wake)', async () => {
      // Simulates a DO that previously generated a key, hibernated,
      // and is now waking up. Storage returns the previously persisted
      // value; ensureVaultKey() must return it untouched and MUST NOT
      // write a new value to storage.
      const PRIOR_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'vaultKey') return PRIOR_KEY;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      // Wait for the constructor's blockConcurrencyWhile body to reach
      // the vaultKey restore -- once the storage.get('vaultKey') call
      // lands in the mock, init is past the relevant restore branch.
      await vi.waitFor(() =>
        expect(mockStorage.get.mock.calls.some((c) => c[0] === 'vaultKey')).toBe(true),
      );

      const key = await (instance as any).ensureVaultKey();
      expect(key).toBe(PRIOR_KEY);

      // No new put for vaultKey on this run -- the restore branch must
      // not regenerate.
      const newPuts = mockStorage.put.mock.calls.filter((c) => c[0] === 'vaultKey');
      expect(newPuts.length).toBe(0);
    });
  });

  describe('internal route dispatch', () => {
    it('dispatches POST /_internal/setBucketName to handler', async () => {
      // No existing bucket - storage returns null for all keys
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

    it('setBucketName stores sessionMode and passes it as SESSION_MODE env var', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return null;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', sessionMode: 'advanced' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      // SESSION_MODE should be in envVars
      expect(instance.envVars?.SESSION_MODE).toBe('advanced');
    });

    it('setBucketName defaults SESSION_MODE to "default" when sessionMode not provided', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return null;
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

      // Should default to 'default'
      expect(instance.envVars?.SESSION_MODE).toBe('default');
    });

    it('setBucketName returns 400 for non-string sessionMode', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', sessionMode: 123 }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(400);
    });

    // REQ-MEM-001 AC4 / REQ-SESSION-016: the previous regression coverage
    // exercised applyBucketName and applyPrefsOnRestart in isolation with
    // userTimezone already in the input arg, which would stay green even if
    // the handleSetBucketName destructure were reverted to the PR #390 bug
    // shape (silently dropping userTimezone from the Worker JSON body).
    // These two tests post to /_internal/setBucketName end-to-end and assert
    // the env var actually surfaces, so removing the destructure makes them
    // red.
    it('setBucketName reads userTimezone from JSON body and emits USER_TIMEZONE env var', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return null;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', userTimezone: 'Europe/Zurich' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      expect(mockStorage.put).toHaveBeenCalledWith('userTimezone', 'Europe/Zurich');
      expect(instance.envVars?.USER_TIMEZONE).toBe('Europe/Zurich');
    });

    it('setBucketName updates USER_TIMEZONE on restart (bucket already set, prefs change path)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'existing-bucket';
        if (key === 'userTimezone') return 'Europe/Zurich';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'existing-bucket', userTimezone: 'America/New_York' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(409);

      expect(mockStorage.put).toHaveBeenCalledWith('userTimezone', 'America/New_York');
      expect(instance.envVars?.USER_TIMEZONE).toBe('America/New_York');
    });

    // REQ-MEM-001 AC4: malformed IANA shapes (path traversal, junk) must
    // not reach storage or the env var. entrypoint.sh uses USER_TIMEZONE
    // to build the /etc/localtime symlink target, so a value like
    // '../../etc/shadow' would otherwise be an unbounded-path injection vector.
    it('setBucketName rejects malformed userTimezone shape (first-time path)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return null;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', userTimezone: '../../etc/shadow' }),
        headers: { 'Content-Type': 'application/json' },
      });

      // 200 is intentional: malformed values are silently dropped per the
      // sticky-once-set semantics in applyBucketName, not surfaced as a 400.
      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const putCalls = mockStorage.put.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(putCalls).not.toContain('userTimezone');
      expect(instance.envVars?.USER_TIMEZONE).toBeUndefined();
    });

    // Mirror of the first-time-path test for the restart branch in
    // applyPrefsOnRestart. A revert of normalizeIanaTz on the restart
    // branch (container-env.ts applyPrefsOnRestart) would otherwise slip
    // past CI because the only HTTP malformed-shape assertion lives on
    // the first-time path.
    it('setBucketName rejects malformed userTimezone shape (restart path, bucket already set)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'existing-bucket';
        if (key === 'userTimezone') return 'Europe/Zurich';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'existing-bucket', userTimezone: '../../etc/shadow' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(409);

      const putCalls = mockStorage.put.mock.calls
        .filter((c: unknown[]) => c[0] === 'userTimezone')
        .map((c: unknown[]) => c[1] as string);
      expect(putCalls).not.toContain('../../etc/shadow');
      expect(instance.envVars?.USER_TIMEZONE).toBe('Europe/Zurich');
    });

    it('proxies unknown routes via super.fetch when container is running', async () => {
      mockContainerRuntime.running = true;
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/unknown-route', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      // super.fetch() handles proxying (SDK manages readiness + networking)
      expect(response).toBeDefined();
    });
  });

  describe('fetch gate — 503 when container not running / REQ-SESSION-009 (DO fetch gates on container.running, returns 503 for non-internal routes) / REQ-SESSION-012 (wake-loop prevention: 503 on HTTP + 4503 close code on WS prevent client reconnect storms from waking hibernated containers)', () => {
    it('should return 503 for non-internal routes when container is not running', async () => {
      mockContainerRuntime.running = false;

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/some-route', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(503);
    });

    it('should allow internal routes when container is not running', async () => {
      mockContainerRuntime.running = false;
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/getBucketName', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      // Internal routes are handled by the route map before the gate
      expect(response.status).toBe(200);
      const body = await response.json() as { bucketName: string | null };
      expect(body).toHaveProperty('bucketName');
    });

    it('REQ-SEC-022 AC1: proxied non-internal request gets Authorization: Bearer <containerAuthToken> injected before super.fetch', async () => {
      mockContainerRuntime.running = true;
      const PRIOR_TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return PRIOR_TOKEN;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      // Wait for constructor's blockConcurrencyWhile body to finish restoring
      // containerAuthToken from storage, so the fetch override sees it.
      await vi.waitFor(() => {
        expect(instance.envVars?.CONTAINER_AUTH_TOKEN).toBe(PRIOR_TOKEN);
      });

      // Spy on the MockContainer (super) prototype's fetch and capture the
      // Request the DO override forwards.
      const proto = Object.getPrototypeOf(Object.getPrototypeOf(instance));
      const superFetchSpy = vi.spyOn(proto, 'fetch')
        .mockResolvedValue(new Response('proxied', { status: 200 }));

      try {
        const request = new Request('http://container/some-route', { method: 'GET' });
        await instance.fetch(request);

        expect(superFetchSpy).toHaveBeenCalledTimes(1);
        const forwarded = superFetchSpy.mock.calls[0][0] as Request;
        expect(forwarded.headers.get('Authorization')).toBe(`Bearer ${PRIOR_TOKEN}`);
      } finally {
        superFetchSpy.mockRestore();
      }
    });

    it('should return JSON error body with correct Content-Type', async () => {
      mockContainerRuntime.running = false;

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/some-route', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(503);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      const body = await response.json() as { error: string };
      expect(body.error).toBe('Container not running');
    });
  });

  describe('destroy', () => {
    // Most existing tests in this block assert storage cleanup, not the new
    // graceful-shutdown polling. Default to !running so the override skips the
    // 25 s SIGTERM-and-poll branch; tests that need the graceful path opt in.
    beforeEach(() => {
      mockContainerRuntime.running = false;
    });

    it('calls super.destroy() and cleans up operational storage', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await instance.destroy();

      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
      expect(mockStorage.delete).toHaveBeenCalledWith('metricsTransportRecovery');
    });

    it('REQ-SESSION-022 AC1: clears transport recovery independently when later teardown cleanup fails', async () => {
      mockStorage.delete.mockImplementation(async (key: string) => {
        if (key === '_sessionId') throw new Error('storage unavailable');
      });
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await expect(instance.destroy()).resolves.toBeUndefined();

      const deletedKeys = mockStorage.delete.mock.calls.map((call) => call[0]);
      expect(deletedKeys).toContain('metricsTransportRecovery');
      expect(deletedKeys.indexOf('metricsTransportRecovery')).toBeLessThan(deletedKeys.indexOf('_sessionId'));
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

    // REQ-TERM-022 / REQ-SESSION-020: the ordering is the contract, not the write.
    // onStop() runs AFTER the clear below and its updateKvStatus reads
    // host._bucketName, which the clear has nulled - so it hits the
    // missing-identifiers guard and records nothing, leaving a torn-down session
    // as 'running'. The terminal upgrade's authoritative 4503 gate reads exactly
    // that field, so 'running' is what sends reconnects to the forward path
    // instead of telling the client to stop. Recording the stop before the clear
    // is what survives a teardown that is killed partway, which is the case that
    // produced a 20-minute reconnect storm in prod.
    it('records the session stopped BEFORE clearing the identifiers that write needs', async () => {
      // Snapshot what a concurrent collectMetrics tick would observe at the exact
      // moment the 'stopped' record lands: it reads the persisted marker to tell a
      // deliberate stop from a false one, so the marker must already be durable.
      let markerDurableAtKvWrite = false;
      const mockKvPut = vi.fn().mockImplementation(async () => {
        markerDurableAtKvWrite = mockStorage.put.mock.calls
          .some((c: unknown[]) => c[0] === 'shutdownRequested');
      });
      const mockKvGet = vi.fn().mockResolvedValue({ id: 'sess123', status: 'running', name: 'Test' });
      mockEnv.KV = { get: mockKvGet, put: mockKvPut };

      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await instance.destroy();

      expect(mockKvPut).toHaveBeenCalled();
      const written = mockKvPut.mock.calls[0][1];
      const record = typeof written === 'string' ? JSON.parse(written) : written;
      expect(record.status).toBe('stopped');

      // Ordering: if the write moved after the clear it would silently no-op, and
      // an assertion on the value alone would still pass.
      expect(mockKvPut.mock.invocationCallOrder[0])
        .toBeLessThan(mockStorage.delete.mock.invocationCallOrder[0]);

      // ...and not so early that the window between it and the marker lets a
      // concurrent tick self-heal the record back to 'running'.
      expect(markerDurableAtKvWrite).toBe(true);
    });

    // REQ-SESSION-018 AC5: destroy() persists the deliberate-stop marker (and
    // drops the metrics alarm) BEFORE clearing identifiers, so a DO eviction
    // mid-shutdown cannot let a surviving collectMetrics alarm self-heal a
    // deliberately-stopped session back to running. The marker must be PERSISTED
    // (survives the eviction that resets in-memory fields), not an in-memory flag.
    it('persists the shutdown marker and drops the metrics alarm before clearing identifiers', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const deleteSchedulesSpy = vi.spyOn(instance, 'deleteSchedules' as any);

      await instance.destroy();

      expect(mockStorage.put).toHaveBeenCalledWith('shutdownRequested', expect.any(Number));
      expect(deleteSchedulesSpy).toHaveBeenCalledWith('collectMetrics');
    });

    it('REQ-SEC-012 AC3: destroy() clears persisted containerAuthToken so next session under same DO ID starts fresh', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'old-token-uuid';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('containerAuthToken');
      });

      await instance.destroy();

      // Persisted token must be deleted so a fresh DO incarnation does not
      // inherit it (cross-lifecycle reuse would defeat REQ-SEC-012 AC1).
      expect(mockStorage.delete).toHaveBeenCalledWith('containerAuthToken');
      // And the in-memory copy is nulled so any racing fetch() does not
      // continue to inject the now-revoked token.
      expect((instance as unknown as { _containerAuthToken: string | null })._containerAuthToken).toBeNull();
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

    // CF-050
    // Positive counterpart to the cleared-identifiers test above. That test is a
    // pure negative (no KV write after destroy clears the identifiers), which on
    // its own could pass even if onStop never wrote under ANY condition. This
    // test pins the intended behaviour: with identifiers present, onStop writes
    // status='stopped' to KV. Together the two prove the negative above is the
    // result of the cleared identifiers, not of onStop being inert.
    // REQ-SESSION-018: persisted status is authoritative on container exit.
    it('onStop writes status=stopped to KV when bucketName + sessionId are present', async () => {
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

      await instance.onStop();

      await vi.waitFor(() => {
        expect(mockKvPut).toHaveBeenCalled();
      });
      const writtenSession = JSON.parse(mockKvPut.mock.calls[0][1]);
      expect(writtenSession.status).toBe('stopped');
      expect(writtenSession.lastActiveAt).toBeDefined();
    });

    // REQ-VAULT-006: shutdown bisync completes vault writes before SIGKILL (graceful SIGTERM drain)
    it('graceful shutdown: sends SIGTERM and exits the polling loop once the container reports !running', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });
      mockContainerRuntime.running = true;

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      // SIGTERM simulation: the trap exits, container.running flips to false
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
        mockContainerRuntime.running = false;
      });

      await instance.destroy();

      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
      expect(mockContainerRuntime.running).toBe(false);
      // Storage cleanup also happened
      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
    });

    it('REQ-SESSION-011: drains a final R2 sync (POST /internal/final-sync) BEFORE signalling stop', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'tok-final-sync';
        return null;
      });
      mockContainerRuntime.running = true;

      const order: string[] = [];
      // Record the drain call and resolve it OK so drainFinalSync completes
      // its happy path; the order array proves it lands before stop().
      mockTcpPortFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/internal/final-sync')) {
          order.push('finalsync');
        }
        return new Response(JSON.stringify({ synced: true }), { status: 200 });
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
        order.push('stop');
        mockContainerRuntime.running = false;
      });

      await instance.destroy();

      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
      // The whole point of the fix: the live bisync is awaited while the
      // container is still running, then we stop. Never the reverse.
      expect(order).toEqual(['finalsync', 'stop']);
    });

    it('REQ-SESSION-011: the final-sync drain authenticates with the container token captured BEFORE the storage clear (401 regression)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'tok-teardown-456';
        return null;
      });
      mockContainerRuntime.running = true;

      // Capture the drain request init so the Authorization header is assertable.
      // The raw port.fetch bypasses the DO fetch override that injects auth; pre-fix
      // this request carried no header and the in-container host 401'd it on EVERY
      // stop/delete (observed: 30 days of outcome:incomplete httpStatus:401 audits,
      // zero successes) - the actual bisync-on-delete data loss.
      let drainInit: RequestInit | undefined;
      mockTcpPortFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/internal/final-sync')) {
          drainInit = init;
          // The drain fires AFTER the operational-storage clear (REQ-SESSION-009
          // ordering), so a header here proves the token was captured pre-clear,
          // not read late from already-wiped storage.
          expect(mockStorage.delete).toHaveBeenCalledWith('containerAuthToken');
        }
        return new Response(JSON.stringify({ synced: true }), { status: 200 });
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
        mockContainerRuntime.running = false;
      });

      await instance.destroy();

      expect((drainInit?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer tok-teardown-456');
    });

    it('REQ-SESSION-011: missing auth token records the reason and makes zero final-sync requests', async () => {
      mockStorage.get.mockResolvedValue(null);
      mockContainerRuntime.running = true;
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      vi.spyOn(instance, 'stop' as any).mockImplementation(async () => { mockContainerRuntime.running = false; });

      await instance.destroy();

      expect(mockTcpPortFetch).not.toHaveBeenCalledWith(expect.stringContaining('/internal/final-sync'), expect.anything());
      expect(mockStorage.put).toHaveBeenCalledWith('finalSyncAudit', expect.objectContaining({ reason: 'missing-auth-token' }));
    });

    it('REQ-SESSION-011: still stops when the final-sync drain fails (best-effort, no throw)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'tok-final-sync';
        return null;
      });
      mockContainerRuntime.running = true;

      // Drain endpoint rejects: drainFinalSync must swallow it so teardown
      // still proceeds to stop rather than wedging the destroy.
      mockTcpPortFetch.mockRejectedValue(new Error('Connection refused'));

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
        mockContainerRuntime.running = false;
      });

      await expect(instance.destroy()).resolves.toBeUndefined();
      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
    });

    // #516: a deliberate stop/delete that lands during a transient not-running
    // reading (DO wake / deploy-roll) must STILL attempt the final drain - skipping
    // it silently dropped the last edits. Pre-fix, the running gate skipped the whole
    // block. Post-fix, the drain fetch fires regardless and the outcome is persisted.
    it('REQ-SESSION-011/#516: attempts the final-sync drain on delete even when container.running reads transiently false, and persists a durable audit marker', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'tok-final-sync';
        return null;
      });
      // The transient: container reports not-running at teardown start.
      mockContainerRuntime.running = false;

      let drainAttempted = false;
      mockTcpPortFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/internal/final-sync')) {
          drainAttempted = true;
          return new Response(JSON.stringify({ synced: true }), { status: 200 });
        }
        return new Response('', { status: 200 });
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await instance.destroy();

      // Drain was attempted despite running===false (the #516 fix).
      expect(drainAttempted).toBe(true);
      // The outcome is durably recorded - never silently swallowed.
      const auditPut = mockStorage.put.mock.calls.find((c) => c[0] === 'finalSyncAudit');
      expect(auditPut).toBeDefined();
      expect((auditPut![1] as { outcome: string }).outcome).toBe('completed');
    });

    // Any non-OK final-sync HTTP response (res.ok === false) must be recorded as a
    // non-completed, queryable audit outcome carrying the session id + http
    // status/reason - never swallowed - and the session must still delete (data
    // loss past the window is acceptable per the fix decision; a SILENT loss is
    // not). Post budget-inversion fix a host *timeout* 504 no longer reaches the DO
    // (the DO's AbortSignal at FINAL_SYNC_BUDGET_MS=120s fires before the host's
    // 125s 504), so the authoritative ceiling path is the fetch *rejection* covered
    // by the "errored" sibling test below; this case guards the reachable non-OK
    // branch (e.g. a fast 503/non-2xx) and the body-capture plumbing. The 504 here
    // is illustrative of the res.ok===false mapping, not the timeout race.
    it('REQ-SESSION-011: a non-OK final-sync response is audited as "incomplete" with the session id + http status/reason, and the delete still proceeds', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        if (key === 'containerAuthToken') return 'tok-final-sync';
        return null;
      });
      mockContainerRuntime.running = true;

      mockTcpPortFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/internal/final-sync')) {
          return new Response(JSON.stringify({ synced: false, reason: 'timeout' }), { status: 504 });
        }
        return new Response('', { status: 200 });
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      // The constructor loads _sessionId via blockConcurrencyWhile; the test mock
      // does not await that init, so set the in-memory field directly (as the
      // containerStartedAt test does). destroy() captures host._sessionId before
      // the storage-clear nulls it.
      (instance as any)._sessionId = 'sess123';
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
        mockContainerRuntime.running = false;
      });

      await expect(instance.destroy()).resolves.toBeUndefined();
      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');

      const auditPut = mockStorage.put.mock.calls.find((c) => c[0] === 'finalSyncAudit');
      expect(auditPut).toBeDefined();
      const event = auditPut![1] as { outcome: string; sessionId?: string; httpStatus?: number; reason?: string };
      expect(event.outcome).toBe('incomplete'); // 504 is res.ok===false -> not completed
      expect(event.sessionId).toBe('sess123'); // captured before the storage-clear nulls _sessionId
      expect(event.httpStatus).toBe(504);
      expect(event.reason).toBe('timeout');
    });

    // This is the AUTHORITATIVE ceiling path post budget-inversion fix: when the
    // sync runs past the DO's FINAL_SYNC_BUDGET_MS, the DO's AbortSignal.timeout
    // aborts the fetch (an 'AbortError' rejection) before the host's 125s 504 can
    // return - so the drain rejects, and that must audit as 'errored' (not a
    // swallowed completion) while destroy still proceeds. Also covers a transient
    // not-running reading where the port fetch simply fails.
    it('#516: persists outcome "errored" and still completes destroy when the drain fetch is aborted/rejected (DO AbortSignal ceiling)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'tok-final-sync';
        return null;
      });
      mockContainerRuntime.running = false;
      const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      mockTcpPortFetch.mockRejectedValue(abortErr);
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await expect(instance.destroy()).resolves.toBeUndefined();
      const auditPut = mockStorage.put.mock.calls.find((c) => c[0] === 'finalSyncAudit');
      expect(auditPut).toBeDefined();
      expect((auditPut![1] as { outcome: string }).outcome).toBe('errored');
    });

    it('REQ-SESSION-006 AC2: rejects after logging when forced SDK destroy rejects', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const forcedError = new Error('provider force-destroy failed');
      const superDestroySpy = vi.spyOn(instance, 'superDestroy').mockRejectedValue(forcedError);
      const loggerWarn = (instance as any).logger.warn as ReturnType<typeof vi.fn>;

      await expect(instance.destroy()).rejects.toBe(forcedError);

      expect(superDestroySpy).toHaveBeenCalled();
      expect(loggerWarn).toHaveBeenCalledWith(
        'Forced destroy failed or exceeded teardown deadline',
        { error: forcedError.message },
      );
    });

    it('REQ-SESSION-011 AC5: rejects at the entry-to-exit deadline and observes a later forced-destroy rejection', async () => {
      vi.useFakeTimers();
      try {
        mockContainerRuntime.running = true;
        const instance = new ContainerClass(mockCtx as any, mockEnv);
        const stopSpy = vi.spyOn(instance, 'stop' as any).mockResolvedValue(undefined);
        const loggerWarn = (instance as any).logger.warn as ReturnType<typeof vi.fn>;
        let rejectForcedDestroy!: (error: Error) => void;
        const forcedDestroy = new Promise<void>((_, reject) => {
          rejectForcedDestroy = reject;
        });
        const superDestroySpy = vi.spyOn(instance, 'superDestroy').mockReturnValue(forcedDestroy);

        const destroyPromise = instance.destroy();
        const deadlineRejection = expect(destroyPromise).rejects.toThrow('teardown deadline exceeded');
        await vi.advanceTimersByTimeAsync(136_000);
        await deadlineRejection;

        expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
        expect(mockContainerRuntime.running).toBe(true);
        expect(superDestroySpy).toHaveBeenCalled();
        expect(loggerWarn).toHaveBeenCalledWith(
          'Forced destroy failed or exceeded teardown deadline',
          { error: 'teardown deadline exceeded' },
        );

        rejectForcedDestroy(new Error('late provider rejection'));
        await vi.advanceTimersByTimeAsync(0);
        expect(loggerWarn).toHaveBeenCalledWith(
          'Forced destroy failed after teardown deadline',
          { error: 'late provider rejection' },
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('onStop logs shutdownElapsedMs reflecting real elapsed time between destroy and onStop', async () => {
      vi.useFakeTimers();
      try {
        mockStorage.get.mockImplementation(async (key: string) => {
          if (key === 'bucketName') return 'test-bucket';
          return null;
        });
        mockContainerRuntime.running = true;

        const instance = new ContainerClass(mockCtx as any, mockEnv);
        // Stop spy that takes "real" time to flip running flag. Drives
        // _shutdownStartedAt to actually accumulate elapsed time the
        // assertion below can pin a lower bound on.
        vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
          // simulate a slow shutdown (e.g. bisync still running)
          await new Promise((resolve) => setTimeout(resolve, 1500));
          mockContainerRuntime.running = false;
        });

        const loggerInfo = (instance as any).logger.info as ReturnType<typeof vi.fn>;
        loggerInfo.mockClear();

        const destroyPromise = instance.destroy();
        // Drive enough fake time for the 1500ms stop + polling pollMs to
        // finish; 2000 is comfortably above both.
        await vi.advanceTimersByTimeAsync(2000);
        await destroyPromise;

        // Drive additional time before onStop fires, so any regression
        // that computes elapsed-ms incorrectly (e.g. uses onStop's own
        // start rather than destroy's _shutdownStartedAt) shows up as a
        // smaller-than-expected number.
        await vi.advanceTimersByTimeAsync(3000);
        await instance.onStop();

        const stoppedCall = loggerInfo.mock.calls.find(
          (call) => call[0] === 'Container stopped',
        );
        expect(stoppedCall).toBeDefined();
        const meta = stoppedCall![1] as { shutdownElapsedMs: number | null };
        expect(meta.shutdownElapsedMs).toBeTypeOf('number');
        // Lower bound: destroy ran ~2s, then 3s before onStop = 5s total.
        // Pin to 4500 to absorb timer fuzz but still fail if the
        // implementation reports onStop's own elapsed (3000) or zero.
        expect(meta.shutdownElapsedMs).toBeGreaterThanOrEqual(4500);
      } finally {
        vi.useRealTimers();
      }
    });

    it('graceful shutdown: still calls super.destroy() if stop() rejects', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });
      mockContainerRuntime.running = true;

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockRejectedValue(new Error('signal delivery failed'));

      // The override must catch the throw; the route depends on destroy() always returning
      await expect(instance.destroy()).resolves.toBeUndefined();
      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
      // Storage cleanup still ran
      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
    });

    it('graceful shutdown: skips SIGTERM when ctx.container is already not running', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });
      mockContainerRuntime.running = false;

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockResolvedValue(undefined);

      await instance.destroy();

      // No need to send SIGTERM if the container is already gone
      expect(stopSpy).not.toHaveBeenCalled();
      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
    });
  });
});
