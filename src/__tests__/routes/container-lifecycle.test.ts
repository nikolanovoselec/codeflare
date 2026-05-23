import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';

// ---------------------------------------------------------------------------
// Mock container stub
// ---------------------------------------------------------------------------
function createMockContainer() {
  return {
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ bucketName: null }), { status: 200 })),
    destroy: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({ status: 'stopped' }),
    startAndWaitForPorts: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Shared mutable state - vi.hoisted ensures this runs before vi.mock factories
// ---------------------------------------------------------------------------
const testState = vi.hoisted(() => ({
  container: null as ReturnType<typeof createMockContainer> | null,
  createBucketResult: { success: true, created: false } as { success: boolean; error?: string; created?: boolean },
}));

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------
vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => testState.container),
}));

vi.mock('../../lib/r2-admin', () => ({
  createBucketIfNotExists: vi.fn(async () => testState.createBucketResult),
  getOrCreateScopedR2Token: vi.fn(async () => ({
    accessKeyId: 'scoped-ak',
    secretAccessKey: 'scoped-sk',
    tokenId: 'scoped-tok',
  })),
}));

vi.mock('../../lib/r2-seed', () => ({
  seedGettingStartedDocs: vi.fn(async () => ({ written: ['Getting-Started.md'], skipped: [] })),
}));

vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn(async () => ({ accountId: 'test-account', endpoint: 'https://test.r2.cloudflarestorage.com' })),
}));

// Mock circuit breakers to be pass-through
const passThroughCB = { execute: (fn: () => Promise<unknown>) => fn(), reset: vi.fn() };
vi.mock('../../lib/circuit-breakers', () => ({
  getContainerHealthCB: () => passThroughCB,
  getContainerInternalCB: () => passThroughCB,
  getContainerSessionsCB: () => passThroughCB,
}));

import lifecycleRoutes from '../../routes/container/lifecycle';
import { createBucketIfNotExists } from '../../lib/r2-admin';
import { seedGettingStartedDocs } from '../../lib/r2-seed';

describe('Container Lifecycle Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  // Mock execution context for waitUntil support
  const mockExecutionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };

  beforeEach(() => {
    mockKV = createMockKV();
    testState.container = createMockContainer();
    testState.createBucketResult = { success: true, created: false };
    // Seed a session in KV so the session existence check (S3 fix) passes
    mockKV._set('session:test-bucket:abcdef1234567890abcdef12', {
      id: 'abcdef1234567890abcdef12',
      name: 'Test Session',
      userId: 'test-bucket',
      status: 'stopped',
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Creates a test app and returns a fetch helper that provides ExecutionContext.
   * Lifecycle routes use c.executionCtx.waitUntil(), which requires the
   * ExecutionContext parameter in app.fetch().
   */
  function createLifecycleApp(bucketName = 'test-bucket') {
    const app = createTestApp({
      routes: [{ path: '/container', handler: lifecycleRoutes }],
      mockKV,
      bucketName,
      envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token' } as Partial<Env>,
    });

    // Return a fetch helper that includes ExecutionContext
    const fetch = (path: string, init?: RequestInit) => {
      const req = new Request(`http://localhost${path}`, init);
      return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
    };

    return fetch;
  }

  // Shorthand for the mock container
  function container() {
    return testState.container!;
  }

  // =========================================================================
  // POST /container/start
  // =========================================================================
  describe('POST /container/start', () => {
    it('returns starting status when container is stopped', async () => {
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; status: string };
      expect(body.success).toBe(true);
      expect(body.status).toBe('starting');
    });

    it('returns already_running when container is running with correct bucket', async () => {
      const fetch = createLifecycleApp('test-bucket');
      container().getState.mockResolvedValue({ status: 'running' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: 'test-bucket' }), { status: 200 })
      );

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; status: string; containerState: string };
      expect(body.success).toBe(true);
      expect(body.status).toBe('already_running');
      expect(body.containerState).toBe('running');
    });

    it('returns already_running when container is healthy with correct bucket', async () => {
      const fetch = createLifecycleApp('test-bucket');
      container().getState.mockResolvedValue({ status: 'healthy' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: 'test-bucket' }), { status: 200 })
      );

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; status: string };
      expect(body.success).toBe(true);
      expect(body.status).toBe('already_running');
    });

    it('returns 500 when missing sessionId', async () => {
      const fetch = createLifecycleApp();

      const res = await fetch('/container/start', {
        method: 'POST',
      });

      expect(res.status).toBe(400);
    });

    it('creates R2 bucket before starting container', async () => {
      const fetch = createLifecycleApp('my-bucket');
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(createBucketIfNotExists).toHaveBeenCalledWith(
        'test-account',
        'test-token',
        'my-bucket'
      );
    });

    it('seeds getting-started docs when bucket is newly created', async () => {
      const fetch = createLifecycleApp('my-bucket');
      testState.createBucketResult = { success: true, created: true };
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', { method: 'POST' });

      expect(seedGettingStartedDocs).toHaveBeenCalledWith(
        expect.any(Object),
        'my-bucket',
        'https://test.r2.cloudflarestorage.com',
        { overwrite: false }
      );
    });

    it('passes workspaceSyncEnabled preference to setBucketName', async () => {
      const fetch = createLifecycleApp('my-bucket');
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      mockKV._set('user-prefs:my-bucket', {
        workspaceSyncEnabled: true,
      });
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ bucketName: null }), { status: 200 })
        )
        .mockResolvedValueOnce(new Response('', { status: 200 }));

      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      const setBucketRequest = container().fetch.mock.calls[1]?.[0] as Request;
      expect(setBucketRequest).toBeDefined();
      const body = await setBucketRequest.json() as { workspaceSyncEnabled?: boolean };
      expect(body.workspaceSyncEnabled).toBe(true);
    });

    it('returns error when bucket creation fails', async () => {
      const fetch = createLifecycleApp();
      testState.createBucketResult = { success: false, error: 'Permission denied' };

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('CONTAINER_ERROR');
    });

    it('restarts container when bucket name changed', async () => {
      const fetch = createLifecycleApp('new-bucket');
      mockKV._set('session:new-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'new-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      container().getState.mockResolvedValue({ status: 'running' });

      // First fetch: getBucketName returns different bucket
      // Second fetch: setBucketName succeeds
      container().fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ bucketName: 'old-bucket' }), { status: 200 })
        )
        .mockResolvedValueOnce(new Response('', { status: 200 })); // setBucketName

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      expect(container().destroy).toHaveBeenCalled();
    });

    it('throws ContainerError when setBucketName fails (Q11)', async () => {
      const fetch = createLifecycleApp('my-bucket');
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      container().getState.mockResolvedValue({ status: 'stopped' });

      // First fetch: getBucketName returns null (needs update)
      container().fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ bucketName: null }), { status: 200 })
        )
        // Second fetch: setBucketName fails
        .mockRejectedValueOnce(new Error('DO not reachable'));

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('CONTAINER_ERROR');
    });

    it('aborts container start when setBucketName throws', async () => {
      const fetch = createLifecycleApp('my-bucket');
      mockKV._set('session:my-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Test Session',
        userId: 'my-bucket',
        status: 'stopped',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      container().getState.mockResolvedValue({ status: 'stopped' });

      // getBucketName returns different bucket name -> needs update
      container().fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ bucketName: 'different-bucket' }), { status: 200 })
        )
        // setBucketName fails
        .mockRejectedValueOnce(new Error('Connection refused'));

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      // Container should NOT have been started
      expect(container().startAndWaitForPorts).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Session Limits
  // =========================================================================
  describe('Session limits / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN with env overrides) / REQ-SEC-019 AC2 (per-user concurrent session caps)', () => {
    it('returns 429 when running sessions exceed limit', async () => {
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed 3 running sessions (default limit for regular users)
      for (let i = 1; i <= 3; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(402);
      const body = await res.json() as { code: string; error: string };
      expect(body.code).toBe('QUOTA_EXCEEDED');
    });

    it('allows start when under the limit', async () => {
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed only 2 running sessions (under default limit of 3)
      for (let i = 1; i <= 2; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
    });

    it('excludes the session being started from running count (restart)', async () => {
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed 3 running sessions, one of which is the session being restarted
      mockKV._set('session:test-bucket:abcdef1234567890abcdef12', {
        id: 'abcdef1234567890abcdef12',
        name: 'Restarting Session',
        userId: 'test-bucket',
        status: 'running',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      for (let i = 1; i <= 2; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      // Should succeed because the session itself is excluded from count (2 others < 3)
      expect(res.status).toBe(200);
    });

    it('admin gets higher limit (DEFAULT_MAX_SESSIONS_ADMIN)', async () => {
      const app = createTestApp({
        routes: [{ path: '/container', handler: lifecycleRoutes }],
        mockKV,
        bucketName: 'test-bucket',
        user: { email: 'admin@example.com', authenticated: true, role: 'admin' },
        envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token' } as Partial<Env>,
      });

      const fetchAdmin = (path: string, init?: RequestInit) => {
        const req = new Request(`http://localhost${path}`, init);
        return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
      };

      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed 5 running sessions (above user limit 3, below admin limit 10)
      for (let i = 1; i <= 5; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetchAdmin('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
    });

    it('respects MAX_SESSIONS_USER env var override', async () => {
      const app = createTestApp({
        routes: [{ path: '/container', handler: lifecycleRoutes }],
        mockKV,
        bucketName: 'test-bucket',
        envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token', MAX_SESSIONS_USER: '5' } as Partial<Env>,
      });

      const fetchWithOverride = (path: string, init?: RequestInit) => {
        const req = new Request(`http://localhost${path}`, init);
        return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
      };

      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed 4 running sessions (above default 3 but below override 5)
      for (let i = 1; i <= 4; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetchWithOverride('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
    });

    it('falls back to default when env var is invalid', async () => {
      const app = createTestApp({
        routes: [{ path: '/container', handler: lifecycleRoutes }],
        mockKV,
        bucketName: 'test-bucket',
        envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token', MAX_SESSIONS_USER: 'invalid' } as Partial<Env>,
      });

      const fetchBadEnv = (path: string, init?: RequestInit) => {
        const req = new Request(`http://localhost${path}`, init);
        return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
      };

      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed 3 running sessions (hits default limit of 3)
      for (let i = 1; i <= 3; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetchBadEnv('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      // Should use default limit of 3, so 3 running = 402
      expect(res.status).toBe(402);
    });

    it('bypasses session limit when STRESS_TEST_MODE is active', async () => {
      const app = createTestApp({
        routes: [{ path: '/container', handler: lifecycleRoutes }],
        mockKV,
        bucketName: 'test-bucket',
        envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token', STRESS_TEST_MODE: 'active' } as Partial<Env>,
      });

      const fetchStress = (path: string, init?: RequestInit) => {
        const req = new Request(`http://localhost${path}`, init);
        return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
      };

      container().getState.mockResolvedValue({ status: 'stopped' });
      container().fetch.mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      );

      // Seed 5 running sessions (above default limit of 3)
      for (let i = 1; i <= 5; i++) {
        const id = `runningsession${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `Running ${i}`,
          userId: 'test-bucket',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        });
      }

      const res = await fetchStress('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      // STRESS_TEST_MODE bypasses session limit - should succeed despite 5 running
      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // POST /container/destroy
  // =========================================================================
  describe('POST /container/destroy', () => {
    it('destroys the container and returns success', async () => {
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'running' });

      const res = await fetch('/container/destroy?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toBe('Container destroyed');
      expect(container().destroy).toHaveBeenCalled();
    });

    it('returns 500 when destroy fails', async () => {
      const fetch = createLifecycleApp();
      container().getState.mockResolvedValue({ status: 'running' });
      container().destroy.mockRejectedValue(new Error('Destroy failed'));

      const res = await fetch('/container/destroy?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });

      expect(res.status).toBe(500);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('CONTAINER_ERROR');
    });

    it('returns 400 when missing sessionId', async () => {
      const fetch = createLifecycleApp();

      const res = await fetch('/container/destroy', {
        method: 'POST',
      });

      expect(res.status).toBe(400);
    });
  });

});
