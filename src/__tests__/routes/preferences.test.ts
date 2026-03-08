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

  describe('fastStartEnabled preference', () => {
    it('GET returns stored fastStartEnabled', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'codex',
        fastStartEnabled: true,
      });
      const app = createTestApp();

      const res = await app.request('/preferences');

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string; fastStartEnabled?: boolean };
      expect(body.lastAgentType).toBe('codex');
      expect(body.fastStartEnabled).toBe(true);
    });

    it('PATCH updates fastStartEnabled and preserves other fields', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'gemini',
        workspaceSyncEnabled: true,
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fastStartEnabled: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string; workspaceSyncEnabled?: boolean; fastStartEnabled?: boolean };
      expect(body.lastAgentType).toBe('gemini');
      expect(body.workspaceSyncEnabled).toBe(true);
      expect(body.fastStartEnabled).toBe(true);
    });

    it('PATCH accepts fastStartEnabled: false', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fastStartEnabled: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { fastStartEnabled?: boolean };
      expect(body.fastStartEnabled).toBe(false);
    });

    it('returns 400 for invalid fastStartEnabled type', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fastStartEnabled: 'yes' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('sessionMode preference', () => {
    it('GET returns stored sessionMode', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'codex',
        sessionMode: 'advanced',
      });
      const app = createTestApp();

      const res = await app.request('/preferences');

      expect(res.status).toBe(200);
      const body = await res.json() as { sessionMode?: string };
      expect(body.sessionMode).toBe('advanced');
    });

    it('PATCH updates sessionMode to "default" and preserves other fields', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'gemini',
        sessionMode: 'advanced',
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'default' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string; sessionMode?: string };
      expect(body.lastAgentType).toBe('gemini');
      expect(body.sessionMode).toBe('default');
    });

    it('PATCH updates sessionMode to "advanced"', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { sessionMode?: string };
      expect(body.sessionMode).toBe('advanced');
    });

    it('returns 400 for invalid sessionMode "expert"', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'expert' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid sessionMode 123', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 123 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for sessionMode null', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: null }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('malformed JSON and unknown fields', () => {
    it('PATCH with malformed JSON body returns 400', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('PATCH with empty {} is a 200 no-op merge', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'gemini',
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string };
      expect(body.lastAgentType).toBe('gemini');
    });

    it('PATCH with unknown fields returns 400 (strict schema)', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unknownField: true }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });
});

