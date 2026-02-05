import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import lifecycleRoutes from '../../routes/session/lifecycle';
import type { Env, Session } from '../../types';
import { NotFoundError } from '../../lib/error-types';
import { AuthVariables } from '../../middleware/auth';
import { createMockKV } from '../helpers/mock-kv';

// Mock container
function createMockContainer(healthy = true) {
  return {
    fetch: vi.fn().mockImplementation((req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return healthy
          ? Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
          : Promise.reject(new Error('Container not running'));
      }
      if (url.pathname === '/sessions' && req.method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

const testState = vi.hoisted(() => ({
  container: null as ReturnType<typeof createMockContainer> | null,
}));

vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => testState.container ?? createMockContainer()),
}));

function createLifecycleApp(mockKV: ReturnType<typeof createMockKV>, bucketName = 'test-bucket') {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

  app.onError((err, c) => {
    if (err instanceof NotFoundError) {
      return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
    }
    return c.json({ error: err.message }, 500);
  });

  app.use('*', async (c, next) => {
    c.env = {
      KV: mockKV as unknown as KVNamespace,
      CONTAINER: {} as DurableObjectNamespace,
    } as unknown as Env;
    c.set('user', { email: 'test@example.com', authenticated: true });
    c.set('bucketName', bucketName);
    return next();
  });

  app.route('/sessions', lifecycleRoutes);
  return app;
}

describe('Session Lifecycle Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    testState.container = createMockContainer();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('POST /:id/stop', () => {
    it('sets session status to stopped in KV', async () => {
      const app = createLifecycleApp(mockKV);
      const session: Session = {
        id: 'sessiontostop12345',
        name: 'To Stop',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
        status: 'running',
      };
      mockKV._set('session:test-bucket:sessiontostop12345', session);

      const res = await app.request('/sessions/sessiontostop12345/stop', {
        method: 'POST',
      });

      expect(res.status).toBe(200);

      const putCalls = mockKV.put.mock.calls;
      const sessionPutCall = putCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('sessiontostop12345')
      );
      expect(sessionPutCall).toBeDefined();
      const storedSession = JSON.parse(sessionPutCall![1] as string) as Session;
      expect(storedSession.status).toBe('stopped');
    });

    it('calls container.destroy()', async () => {
      const app = createLifecycleApp(mockKV);
      const session: Session = {
        id: 'sessiontostop12345',
        name: 'To Stop',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
        status: 'running',
      };
      mockKV._set('session:test-bucket:sessiontostop12345', session);

      await app.request('/sessions/sessiontostop12345/stop', { method: 'POST' });

      expect(testState.container!.destroy).toHaveBeenCalled();
    });

    it('returns success response', async () => {
      const app = createLifecycleApp(mockKV);
      const session: Session = {
        id: 'sessiontostop12345',
        name: 'To Stop',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
        status: 'running',
      };
      mockKV._set('session:test-bucket:sessiontostop12345', session);

      const res = await app.request('/sessions/sessiontostop12345/stop', { method: 'POST' });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; stopped: boolean; id: string };
      expect(body.success).toBe(true);
      expect(body.stopped).toBe(true);
      expect(body.id).toBe('sessiontostop12345');
    });

    it('returns 404 when session not found', async () => {
      const app = createLifecycleApp(mockKV);

      const res = await app.request('/sessions/nonexistent123456/stop', { method: 'POST' });

      expect(res.status).toBe(404);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('NOT_FOUND');
    });

    it('handles container.destroy() failure gracefully', async () => {
      testState.container = createMockContainer();
      testState.container.destroy.mockRejectedValue(new Error('already stopped'));
      const app = createLifecycleApp(mockKV);
      const session: Session = {
        id: 'sessiontostop12345',
        name: 'To Stop',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
        status: 'running',
      };
      mockKV._set('session:test-bucket:sessiontostop12345', session);

      const res = await app.request('/sessions/sessiontostop12345/stop', { method: 'POST' });

      // Should still return 200 since destroy is best-effort
      expect(res.status).toBe(200);
    });
  });

  describe('GET /:id/status', () => {
    it('returns stopped status when session KV status is stopped', async () => {
      const app = createLifecycleApp(mockKV);
      const session: Session = {
        id: 'sessionstatus12345',
        name: 'Stopped Session',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
        status: 'stopped',
      };
      mockKV._set('session:test-bucket:sessionstatus12345', session);

      const res = await app.request('/sessions/sessionstatus12345/status');

      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; ptyActive: boolean; ptyInfo: unknown };
      expect(body.status).toBe('stopped');
      expect(body.ptyActive).toBe(false);
      expect(body.ptyInfo).toBeNull();
    });

    it('skips container probe when KV says stopped', async () => {
      const app = createLifecycleApp(mockKV);
      const session: Session = {
        id: 'sessionstatus12345',
        name: 'Stopped Session',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
        status: 'stopped',
      };
      mockKV._set('session:test-bucket:sessionstatus12345', session);

      await app.request('/sessions/sessionstatus12345/status');

      // Container should NOT be probed when KV says stopped
      expect(testState.container!.fetch).not.toHaveBeenCalled();
    });

    it('probes container when session has no stopped status', async () => {
      const app = createLifecycleApp(mockKV);
      const session: Session = {
        id: 'sessionstatus12345',
        name: 'Running Session',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:sessionstatus12345', session);

      const res = await app.request('/sessions/sessionstatus12345/status');

      expect(res.status).toBe(200);
      // Container should be probed when KV doesn't say stopped
      expect(testState.container!.fetch).toHaveBeenCalled();
    });

    it('strips userId from response session', async () => {
      const app = createLifecycleApp(mockKV);
      const session: Session = {
        id: 'sessionstatus12345',
        name: 'Test Session',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
        status: 'stopped',
      };
      mockKV._set('session:test-bucket:sessionstatus12345', session);

      const res = await app.request('/sessions/sessionstatus12345/status');

      expect(res.status).toBe(200);
      const body = await res.json() as { session: Record<string, unknown> };
      expect(body.session.userId).toBeUndefined();
    });

    it('returns 404 when session not found', async () => {
      const app = createLifecycleApp(mockKV);

      const res = await app.request('/sessions/nonexistent123456/status');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /batch-status', () => {
    it('returns statuses for all user sessions', async () => {
      const app = createLifecycleApp(mockKV);
      const session1: Session = {
        id: 'batchsession1234abc',
        name: 'Session 1',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      const session2: Session = {
        id: 'batchsession5678def',
        name: 'Session 2',
        userId: 'test-bucket',
        createdAt: '2024-01-15T08:00:00.000Z',
        lastAccessedAt: '2024-01-15T10:00:00.000Z',
      };

      mockKV._set('session:test-bucket:batchsession1234abc', session1);
      mockKV._set('session:test-bucket:batchsession5678def', session2);

      const res = await app.request('/sessions/batch-status');
      expect(res.status).toBe(200);

      const body = await res.json() as { statuses: Record<string, { status: string; ptyActive: boolean }> };
      expect(Object.keys(body.statuses)).toHaveLength(2);
      expect(body.statuses['batchsession1234abc']).toEqual(
        expect.objectContaining({ status: expect.any(String), ptyActive: expect.any(Boolean) })
      );
      expect(body.statuses['batchsession5678def']).toEqual(
        expect.objectContaining({ status: expect.any(String), ptyActive: expect.any(Boolean) })
      );
    });

    it('returns empty statuses when no sessions exist', async () => {
      const app = createLifecycleApp(mockKV);

      const res = await app.request('/sessions/batch-status');
      expect(res.status).toBe(200);

      const body = await res.json() as { statuses: Record<string, unknown> };
      expect(body.statuses).toEqual({});
    });

    it('skips container probe for stopped sessions with fresh timestamps', async () => {
      const app = createLifecycleApp(mockKV);
      const session: Session = {
        id: 'stoppedsession12345',
        name: 'Stopped',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
        status: 'stopped',
        lastStatusCheck: Date.now(), // fresh timestamp
      };
      mockKV._set('session:test-bucket:stoppedsession12345', session);

      const res = await app.request('/sessions/batch-status');
      expect(res.status).toBe(200);

      const body = await res.json() as { statuses: Record<string, { status: string }> };
      expect(body.statuses['stoppedsession12345'].status).toBe('stopped');
      // Should NOT have probed container
      expect(testState.container!.fetch).not.toHaveBeenCalled();
    });
  });
});
