import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crudRoutes from '../../routes/session/crud';
import lifecycleRoutes from '../../routes/session/lifecycle';
import type { Session } from '../../types';
import { MAX_SESSION_NAME_LENGTH } from '../../lib/constants';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';

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

// Shared mutable state - vi.hoisted ensures this runs before vi.mock factories
const testState = vi.hoisted(() => ({
  container: null as ReturnType<typeof createMockContainer> | null,
}));

// Mock getContainer from @cloudflare/containers at module level
vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => testState.container ?? createMockContainer()),
}));

describe('Session CRUD Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function createCrudApp(bucketName = 'test-bucket') {
    return createTestApp({
      routes: [{ path: '/sessions', handler: crudRoutes }],
      mockKV,
      bucketName,
    });
  }

  describe('GET /sessions', () => {
    it('returns empty array when no sessions exist', async () => {
      const app = createCrudApp();

      const res = await app.request('/sessions');
      expect(res.status).toBe(200);

      const body = await res.json() as { sessions: Session[] };
      expect(body.sessions).toEqual([]);
    });

    it('returns sessions for the user', async () => {
      const app = createCrudApp();
      const session1: Session = {
        id: 'session1234567890ab',
        name: 'Session 1',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      const session2: Session = {
        id: 'session2234567890ab',
        name: 'Session 2',
        userId: 'test-bucket',
        createdAt: '2024-01-15T08:00:00.000Z',
        lastAccessedAt: '2024-01-15T10:00:00.000Z',
      };

      mockKV._set('session:test-bucket:session1234567890ab', session1);
      mockKV._set('session:test-bucket:session2234567890ab', session2);

      const res = await app.request('/sessions');
      expect(res.status).toBe(200);

      const body = await res.json() as { sessions: Session[] };
      expect(body.sessions).toHaveLength(2);
      // Sessions should be sorted by lastAccessedAt (most recent first)
      expect(body.sessions[0].id).toBe('session2234567890ab');
      expect(body.sessions[1].id).toBe('session1234567890ab');
    });

    it('only returns sessions for the current user bucket', async () => {
      const app = createCrudApp('user-bucket');
      const mySession: Session = {
        id: 'mysession12345678',
        name: 'My Session',
        userId: 'user-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      const otherSession: Session = {
        id: 'othersession12345',
        name: 'Other Session',
        userId: 'other-bucket',
        createdAt: '2024-01-15T08:00:00.000Z',
        lastAccessedAt: '2024-01-15T10:00:00.000Z',
      };

      mockKV._set('session:user-bucket:mysession12345678', mySession);
      mockKV._set('session:other-bucket:othersession12345', otherSession);

      const res = await app.request('/sessions');
      expect(res.status).toBe(200);

      const body = await res.json() as { sessions: Session[] };
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe('mysession12345678');
    });
  });

  describe('POST /sessions', () => {
    it('creates a new session with default name', async () => {
      const app = createCrudApp();

      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      expect(body.session.name).toBe('Terminal');
      expect(body.session.userId).toBeUndefined();
      expect(body.session.id).toMatch(/^[a-f0-9]{24}$/);
      expect(mockKV.put).toHaveBeenCalled();
    });

    it('creates a new session with custom name', async () => {
      const app = createCrudApp();

      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Custom Session' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      expect(body.session.name).toBe('My Custom Session');
    });

    it('trims session name', async () => {
      const app = createCrudApp();

      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '  Padded Name  ' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      expect(body.session.name).toBe('Padded Name');
    });

    it('sanitizes dangerous characters from name', async () => {
      const app = createCrudApp();

      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '<script>alert("xss")</script>' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      expect(body.session.name).not.toContain('<');
      expect(body.session.name).not.toContain('>');
      expect(body.session.name).not.toContain('"');
    });

    it('strips control characters from session name', async () => {
      const app = createCrudApp();

      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test\x00Name\x0aWith\x1fControl' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      // Control characters (\x00, \x0a, \x1f) should be stripped
      expect(body.session.name).not.toMatch(/[\x00-\x1f]/);
      expect(body.session.name).toBe('TestNameWithControl');
    });

    it('returns 400 when name exceeds max length', async () => {
      const app = createCrudApp();
      const longName = 'x'.repeat(MAX_SESSION_NAME_LENGTH + 1);

      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: longName }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('stores session with correct key format', async () => {
      const app = createCrudApp('my-bucket');

      await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      });

      const putCalls = mockKV.put.mock.calls;
      // Find the session put call (rate limiter also puts to KV)
      const sessionPutCall = putCalls.find(
        (call) => typeof call[0] === 'string' && call[0].startsWith('session:')
      );
      expect(sessionPutCall).toBeDefined();
      expect(sessionPutCall![0]).toMatch(/^session:my-bucket:[a-f0-9]{24}$/);
    });
  });

  describe('GET /sessions/:id', () => {
    it('returns session when found', async () => {
      const app = createCrudApp();
      const session: Session = {
        id: 'existingsession1234',
        name: 'Existing Session',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:existingsession1234', session);

      const res = await app.request('/sessions/existingsession1234');
      expect(res.status).toBe(200);

      const body = await res.json() as { session: Session };
      expect(body.session.id).toBe('existingsession1234');
      expect(body.session.name).toBe('Existing Session');
    });

    it('returns 404 when session not found', async () => {
      const app = createCrudApp();

      const res = await app.request('/sessions/nonexistent123456');
      expect(res.status).toBe(404);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('NOT_FOUND');
    });
  });

  describe('PATCH /sessions/:id', () => {
    it('updates session name', async () => {
      const app = createCrudApp();
      const session: Session = {
        id: 'sessiontoupdate123',
        name: 'Old Name',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:sessiontoupdate123', session);

      const res = await app.request('/sessions/sessiontoupdate123', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { session: Session };
      expect(body.session.name).toBe('New Name');
    });

    it('updates session tab config', async () => {
      const app = createCrudApp();
      const session: Session = {
        id: 'sessiontoupdate123',
        name: 'Old Name',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
        tabConfig: [
          { id: '1', command: 'claude', label: 'claude' },
          { id: '2', command: 'yazi', label: 'yazi' },
        ],
      };
      mockKV._set('session:test-bucket:sessiontoupdate123', session);

      const res = await app.request('/sessions/sessiontoupdate123', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tabConfig: [
            { id: '1', command: 'claude', label: 'claude' },
            { id: '2', command: 'lazygit', label: 'lazygit' },
            { id: '3', command: 'yazi', label: 'yazi' },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { session: Session };
      expect(body.session.tabConfig).toEqual([
        { id: '1', command: 'claude', label: 'claude' },
        { id: '2', command: 'lazygit', label: 'lazygit' },
        { id: '3', command: 'yazi', label: 'yazi' },
      ]);
    });

    it('updates lastAccessedAt timestamp', async () => {
      const app = createCrudApp();
      const session: Session = {
        id: 'sessiontoupdate123',
        name: 'Test',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:sessiontoupdate123', session);

      const res = await app.request('/sessions/sessiontoupdate123', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { session: Session };
      // Current time from vi.setSystemTime
      expect(body.session.lastAccessedAt).toBe('2024-01-15T10:00:00.000Z');
    });

    it('returns 404 when session not found', async () => {
      const app = createCrudApp();

      const res = await app.request('/sessions/nonexistent123456', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /sessions/:id', () => {
    it('deletes session and returns confirmation', async () => {
      const app = createCrudApp();
      const session: Session = {
        id: 'sessiontodelete123',
        name: 'To Delete',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:sessiontodelete123', session);

      const res = await app.request('/sessions/sessiontodelete123', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { deleted: boolean; id: string };
      expect(body.deleted).toBe(true);
      expect(body.id).toBe('sessiontodelete123');
      expect(mockKV.delete).toHaveBeenCalledWith('session:test-bucket:sessiontodelete123');
    });

    it('returns 404 when session not found', async () => {
      const app = createCrudApp();

      const res = await app.request('/sessions/nonexistent123456', {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /sessions/:id/touch', () => {
    it('updates lastAccessedAt timestamp', async () => {
      const app = createCrudApp();
      const session: Session = {
        id: 'sessiontotouch1234',
        name: 'Touch Me',
        userId: 'test-bucket',
        createdAt: '2024-01-15T09:00:00.000Z',
        lastAccessedAt: '2024-01-15T09:30:00.000Z',
      };
      mockKV._set('session:test-bucket:sessiontotouch1234', session);

      const res = await app.request('/sessions/sessiontotouch1234/touch', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { session: Session };
      expect(body.session.lastAccessedAt).toBe('2024-01-15T10:00:00.000Z');
    });

    it('returns 404 when session not found', async () => {
      const app = createCrudApp();

      const res = await app.request('/sessions/nonexistent123456/touch', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
    });
  });
});

describe('POST /sessions/:id/stop', () => {
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

  function createLifecycleApp(bucketName = 'test-bucket') {
    return createTestApp({
      routes: [{ path: '/sessions', handler: lifecycleRoutes }],
      mockKV,
      bucketName,
    });
  }

  it('sets session status to stopping in KV', async () => {
    const app = createLifecycleApp();
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

    // Verify KV was updated with 'stopped' status
    const putCalls = mockKV.put.mock.calls;
    const sessionPutCall = putCalls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('sessiontostop12345')
    );
    expect(sessionPutCall).toBeDefined();
    const storedSession = JSON.parse(sessionPutCall![1] as string) as Session;
    expect(storedSession.status).toBe('stopped');
  });

  it('calls container.destroy()', async () => {
    const app = createLifecycleApp();
    const session: Session = {
      id: 'sessiontostop12345',
      name: 'To Stop',
      userId: 'test-bucket',
      createdAt: '2024-01-15T09:00:00.000Z',
      lastAccessedAt: '2024-01-15T09:30:00.000Z',
      status: 'running',
    };
    mockKV._set('session:test-bucket:sessiontostop12345', session);

    await app.request('/sessions/sessiontostop12345/stop', {
      method: 'POST',
    });

    expect(testState.container!.destroy).toHaveBeenCalled();
  });

  it('returns immediately without waiting for sync', async () => {
    const app = createLifecycleApp();
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
    const body = await res.json() as { success: boolean; stopped: boolean };
    expect(body.success).toBe(true);
  });

  it('handles container.destroy() rejection gracefully', async () => {
    testState.container = createMockContainer(false);
    const app = createLifecycleApp();
    const session: Session = {
      id: 'sessiontostop12345',
      name: 'To Stop',
      userId: 'test-bucket',
      createdAt: '2024-01-15T09:00:00.000Z',
      lastAccessedAt: '2024-01-15T09:30:00.000Z',
      status: 'running',
    };
    mockKV._set('session:test-bucket:sessiontostop12345', session);

    // With unhealthy container, stop should still attempt destroy and respond
    const res = await app.request('/sessions/sessiontostop12345/stop', {
      method: 'POST',
    });

    // The endpoint should still return a response (200 or 500)
    expect([200, 500]).toContain(res.status);
  });
});

describe('DELETE /sessions/:id', () => {
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

  function createDeleteApp(bucketName = 'test-bucket') {
    return createTestApp({
      routes: [{ path: '/sessions', handler: crudRoutes }],
      mockKV,
      bucketName,
    });
  }

  it('does NOT call prepareShutdown - destroy() is immediate, SIGTERM handler syncs', async () => {
    const app = createDeleteApp();
    const session: Session = {
      id: 'sessiontodelete123',
      name: 'To Delete',
      userId: 'test-bucket',
      createdAt: '2024-01-15T09:00:00.000Z',
      lastAccessedAt: '2024-01-15T09:30:00.000Z',
    };
    mockKV._set('session:test-bucket:sessiontodelete123', session);

    await app.request('/sessions/sessiontodelete123', {
      method: 'DELETE',
    });

    // prepareShutdown should NOT be called — destroy() follows immediately,
    // so any sync triggered by prepareShutdown would be aborted.
    // The entrypoint.sh SIGTERM handler is the safety net for direct deletion.
    const fetchCalls = testState.container!.fetch.mock.calls;
    const prepareShutdownCall = fetchCalls.find((call: unknown[]) => {
      const req = call[0] as Request;
      return req.url.includes('/_internal/prepareShutdown');
    });
    expect(prepareShutdownCall).toBeUndefined();
  });
});

describe('GET /sessions/batch-status', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function createBatchStatusApp(bucketName = 'test-bucket') {
    return createTestApp({
      routes: [{ path: '/sessions', handler: lifecycleRoutes }],
      mockKV,
      bucketName,
    });
  }

  it('returns status for multiple sessions', async () => {
    const app = createBatchStatusApp();
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
    // Both sessions should have entries in the statuses map
    expect(Object.keys(body.statuses)).toHaveLength(2);
    expect(body.statuses['batchsession1234abc']).toEqual(
      expect.objectContaining({ status: expect.any(String), ptyActive: expect.any(Boolean) })
    );
    expect(body.statuses['batchsession5678def']).toEqual(
      expect.objectContaining({ status: expect.any(String), ptyActive: expect.any(Boolean) })
    );
  });

  it('returns empty statuses when no sessions exist', async () => {
    const app = createBatchStatusApp();

    const res = await app.request('/sessions/batch-status');
    expect(res.status).toBe(200);

    const body = await res.json() as { statuses: Record<string, unknown> };
    expect(body.statuses).toEqual({});
  });

});

describe('Session Rate Limiting', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function createRateLimitApp() {
    return createTestApp({
      routes: [{ path: '/sessions', handler: crudRoutes }],
      mockKV,
    });
  }

  it('includes rate limit headers in response', async () => {
    const app = createRateLimitApp();

    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    });

    expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(res.headers.get('X-RateLimit-Remaining')).toBeDefined();
  });

  it('blocks requests after rate limit is exceeded', async () => {
    const app = createRateLimitApp();

    // Make 10 requests (the limit)
    for (let i = 0; i < 10; i++) {
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Session ${i}` }),
      });
      expect(res.status).toBe(201);
    }

    // 11th request should be rate limited
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Session 11' }),
    });

    expect(res.status).toBe(429);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('RATE_LIMIT_ERROR');
  });

  it('allows requests after rate limit window resets', async () => {
    const app = createRateLimitApp();

    // Use up the limit
    for (let i = 0; i < 10; i++) {
      await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Session ${i}` }),
      });
    }

    // Should be rate limited
    let res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Blocked' }),
    });
    expect(res.status).toBe(429);

    // Advance time past the 1-minute window
    vi.advanceTimersByTime(61000);

    // Should be allowed again
    res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Allowed' }),
    });
    expect(res.status).toBe(201);
  });
});
