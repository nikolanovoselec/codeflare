import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../../types';
import type { AuthVariables } from '../../../middleware/auth';
import { AuthError, ContainerError } from '../../../lib/error-types';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

// Mock container-helpers to provide a controllable container context
const mockContainer = {
  fetch: vi.fn(),
  getState: vi.fn(),
};

vi.mock('../../../lib/container-helpers', () => ({
  getContainerContext: vi.fn(() => ({
    bucketName: 'test-bucket',
    sessionId: 'testsession123',
    containerId: 'test-bucket-testsession123',
    container: mockContainer,
  })),
}));

vi.mock('../../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

// Mock circuit breakers to pass through
vi.mock('../../../lib/circuit-breakers', () => ({
  containerHealthCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
  containerInternalCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
  containerSessionsCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
}));

vi.mock('../../../routes/container/shared', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    containerLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnValue({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    },
    getStoredBucketName: vi.fn().mockResolvedValue('test-bucket'),
    containerHealthCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
    containerInternalCB: { execute: vi.fn((fn: () => Promise<any>) => fn()) },
  };
});

import debugRoutes from '../../../routes/container/debug';

describe('Container Debug Routes', () => {
  function createTestApp(devMode = 'true') {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables & { requestId: string } }>();

    app.onError((err, c) => {
      if (err instanceof AuthError) {
        return c.json({ error: err.message, code: err.code }, err.statusCode as ContentfulStatusCode);
      }
      if (err instanceof ContainerError) {
        return c.json({ error: err.message }, 500);
      }
      return c.json({ error: err.message }, 500);
    });

    app.use('*', async (c, next) => {
      c.env = { DEV_MODE: devMode } as unknown as Env;
      c.set('requestId', 'test-req-id');
      c.set('bucketName', 'test-bucket');
      return next();
    });

    app.route('/debug', debugRoutes);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockContainer.fetch.mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    );
    mockContainer.getState.mockResolvedValue({ status: 'running' });
  });

  describe('DEV_MODE gate', () => {
    it('returns 401 when DEV_MODE is false', async () => {
      const app = createTestApp('false');
      const res = await app.request('/debug/debug?sessionId=testsession123');
      expect(res.status).toBe(401);
    });

    it('returns 401 when DEV_MODE is undefined', async () => {
      const app = createTestApp('');
      const res = await app.request('/debug/debug?sessionId=testsession123');
      expect(res.status).toBe(401);
    });

    it('allows access when DEV_MODE is true', async () => {
      const app = createTestApp('true');
      const res = await app.request('/debug/debug?sessionId=testsession123');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /debug', () => {
    it('returns debug info with container state', async () => {
      const app = createTestApp();
      const res = await app.request('/debug/debug?sessionId=testsession123');
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.containerId).toBe('test-bucket-testsession123');
      expect(body.expectedBucketName).toBe('test-bucket');
    });
  });

  describe('GET /state', () => {
    it('returns container state', async () => {
      const app = createTestApp();
      const res = await app.request('/debug/state?sessionId=testsession123');
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.state).toEqual({ status: 'running' });
    });
  });
});
