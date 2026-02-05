import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import preferencesRoutes from '../../routes/preferences';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { email: 'test@example.com', authenticated: true, role: 'user' });
    c.set('bucketName', 'codeflare-test-user');
    return next();
  }),
}));

describe('Preferences Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  function createTestApp() {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
      } as Env;
      return next();
    });

    app.route('/preferences', preferencesRoutes);

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  describe('GET /preferences', () => {
    it('returns empty object when no preferences are stored', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences');

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toEqual({});
    });

    it('returns stored preferences including workspaceSyncEnabled', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'codex',
        workspaceSyncEnabled: true,
      });
      const app = createTestApp();

      const res = await app.request('/preferences');

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string; workspaceSyncEnabled?: boolean };
      expect(body.lastAgentType).toBe('codex');
      expect(body.workspaceSyncEnabled).toBe(true);
    });
  });

  describe('PATCH /preferences', () => {
    it('updates workspaceSyncEnabled and keeps existing fields', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'gemini',
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceSyncEnabled: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string; workspaceSyncEnabled?: boolean };
      expect(body.lastAgentType).toBe('gemini');
      expect(body.workspaceSyncEnabled).toBe(true);
    });

    it('accepts workspaceSyncEnabled false', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceSyncEnabled: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { workspaceSyncEnabled?: boolean };
      expect(body.workspaceSyncEnabled).toBe(false);
    });

    it('returns 400 for invalid workspaceSyncEnabled type', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceSyncEnabled: 'yes' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });
});

