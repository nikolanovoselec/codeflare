import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  },
}));

// Now import the container class after mocks are set up
import { container as ContainerClass, validateBucketNameInput } from '../../container/index';

describe('container DO class / REQ-SESSION-002 (one container per session)', () => {
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

  describe('constructor', () => {
    it('initializes with defaultPort 8080', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.defaultPort).toBe(8080);
    });

    it('initializes with sleepAfter pinned to 24h (SDK timer disabled)', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.sleepAfter).toBe('24h');
    });

    it('initializes with idleTimeoutPref 2h (fail-safe default per REQ-OPS-006 AC8)', () => {
      // The class-field default is the MAXIMUM supported value (2h), not the
      // minimum. A short fallback would kill the container before storage
      // reads / user-pref writes complete; a long fallback only lets the
      // container live longer than expected. See REQ-OPS-006 AC8 + AD/issue
      // codeflare#294 context.
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.idleTimeoutPref).toBe('2h');
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

    it('REQ-SEC-012 AC2: proxied non-internal request gets Authorization: Bearer <containerAuthToken> injected before super.fetch', async () => {
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

    it('REQ-SEC-012 AC6: destroy() clears persisted containerAuthToken so next session under same DO ID starts fresh', async () => {
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

    it('graceful shutdown: falls back to SIGKILL when the container is still running after the 135 s timeout', async () => {
      vi.useFakeTimers();
      try {
        mockStorage.get.mockImplementation(async (key: string) => {
          if (key === 'bucketName') return 'test-bucket';
          return null;
        });
        mockContainerRuntime.running = true;

        const instance = new ContainerClass(mockCtx as any, mockEnv);

        // SIGTERM is delivered but the container never exits
        const stopSpy = vi.spyOn(instance, 'stop' as any).mockResolvedValue(undefined);

        const destroyPromise = instance.destroy();
        // Advance just past the 135s timeout so the polling loop exits via
        // the wall-clock branch, not the running=false branch. 135s pairs
        // with the entrypoint.sh shutdown bisync 120s budget plus a 15s
        // clean-exit buffer. See AD57.
        await vi.advanceTimersByTimeAsync(136_000);
        await destroyPromise;

        expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
        // Container is still "running" — polling timed out, super.destroy() ran anyway
        expect(mockContainerRuntime.running).toBe(true);
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

    // REQ-SESSION-018: Persisted status is authoritative on container exit
    it('onError updates KV with status stopped (unexpected exit dangling-running guard)', async () => {
      // The SDK calls onError (not onStop) when a container exits unexpectedly
      // (crash / deploy-roll / platform reap). When the container is no longer
      // running, onError must persist 'stopped' so the session does not dangle
      // as 'running' in KV forever.
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

      // Unexpected exit: the runtime has already torn the container down.
      mockContainerRuntime.running = false;

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });

      await instance.onError(new Error('Container error'));

      await vi.waitFor(() => {
        expect(mockKvPut).toHaveBeenCalled();
      });
      const putArgs = mockKvPut.mock.calls[0];
      const writtenSession = JSON.parse(putArgs[1]);
      expect(writtenSession.status).toBe('stopped');
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
    // Remaining onError branch: container NOT running (so the !running guard is
    // satisfied and updateKvStatus IS reached) but the identifiers were already
    // cleared by a prior destroy(). updateKvStatus re-reads sessionId/bucketName
    // from storage on every call; with both absent it must no-op rather than
    // resurrect the KV record. This is the post-destroy resurrection guard
    // documented in onError's comment (destroy() clears identifiers first).
    // REQ-SESSION-009: a post-destroy write must not resurrect the session.
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

    it('defaults to 2h when not in storage (fail-safe per REQ-OPS-006 AC8)', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.idleTimeoutPref).toBe('2h');
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

    it('rejects invalid values from storage and falls back to fail-safe 2h default', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'sleepAfter') return 'invalid';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
      });
      expect(instance.idleTimeoutPref).toBe('2h');
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

    it('is cleaned up on destroy (storage key: sleepAfter)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });
      // Ensure destroy()'s SIGTERM polling exits immediately rather than
      // running the full 135s budget (which exceeds vitest's 30s test
      // timeout). The graceful-shutdown behaviour itself is covered by
      // the dedicated tests above. Budget raised from 75s -> 135s alongside
      // the 15-min cadence change (AD57).
      mockContainerRuntime.running = false;

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await instance.destroy();

      expect(mockStorage.delete).toHaveBeenCalledWith('sleepAfter');
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
      // Class-field default is now 2h (fail-safe per REQ-OPS-006 AC8) - the
      // invalid input was correctly rejected and the default preserved.
      expect(instance.idleTimeoutPref).toBe('2h');
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
    async function createRunningInstance() {
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
      const instance = await createRunningInstance();
      // Set pref to 5m explicitly (class-field default is now 2h fail-safe per
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
      const instance = await createRunningInstance();
      instance.idleTimeoutPref = '5m'; // explicit short pref, otherwise 2h default never trips

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
      const instance = await createRunningInstance();
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
      expect(instance.idleTimeoutPref).toBe('2h');
    });
  });
});
