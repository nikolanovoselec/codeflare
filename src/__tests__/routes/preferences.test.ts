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

// Mock r2-seed and r2-config for preseed reconciliation tests
const { mockReconcileAgentConfigs } = vi.hoisted(() => ({
  mockReconcileAgentConfigs: vi.fn(async () => ({ written: [], skipped: [], deleted: [], warnings: [] })),
}));
vi.mock('../../lib/r2-seed', () => ({ reconcileAgentConfigs: mockReconcileAgentConfigs }));
vi.mock('../../lib/r2-config', () => ({ getR2Config: vi.fn(async () => ({ accountId: 'test-account', endpoint: 'https://r2.test' })) }));

describe('Preferences Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    mockReconcileAgentConfigs.mockClear();
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

  // ---------------------------------------------------------------------------
  // Preseed reconciliation on sessionMode change
  // ---------------------------------------------------------------------------
  describe('preseed reconciliation on sessionMode change', () => {
    it('calls reconcileAgentConfigs when sessionMode changes from default to advanced', async () => {
      const app = createTestApp();
      const prefsKey = 'user-prefs:codeflare-test-user';
      await mockKV.put(prefsKey, JSON.stringify({ sessionMode: 'default' }));

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(200);
      expect(mockReconcileAgentConfigs).toHaveBeenCalledWith(
        expect.anything(),
        'codeflare-test-user',
        'https://r2.test',
        'advanced',
        { overwrite: true, cleanup: true, contextModeEnabled: false },
      );
    });

    it('calls reconcileAgentConfigs when sessionMode changes from advanced to default', async () => {
      const app = createTestApp();
      const prefsKey = 'user-prefs:codeflare-test-user';
      await mockKV.put(prefsKey, JSON.stringify({ sessionMode: 'advanced' }));

      // Mock auth to simulate a user who paid for Pro (so the guard at line 64 passes)
      const { authMiddleware } = await import('../../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce(async (c: any, next: any) => {
        c.set('user', { email: 'test@example.com', authenticated: true, role: 'user', subscribedMode: 'advanced' });
        c.set('bucketName', 'codeflare-test-user');
        return next();
      });

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'default' }),
      });

      expect(res.status).toBe(200);
      expect(mockReconcileAgentConfigs).toHaveBeenCalledWith(
        expect.anything(),
        'codeflare-test-user',
        'https://r2.test',
        'default',
        { overwrite: true, cleanup: true, contextModeEnabled: false },
      );
    });

    it('does NOT call reconcileAgentConfigs when sessionMode stays the same', async () => {
      const app = createTestApp();
      const prefsKey = 'user-prefs:codeflare-test-user';
      await mockKV.put(prefsKey, JSON.stringify({ sessionMode: 'advanced' }));

      const { authMiddleware } = await import('../../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce(async (c: any, next: any) => {
        c.set('user', { email: 'test@example.com', authenticated: true, role: 'user', subscribedMode: 'advanced' });
        c.set('bucketName', 'codeflare-test-user');
        return next();
      });

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(200);
      expect(mockReconcileAgentConfigs).not.toHaveBeenCalled();
    });

    it('does NOT call reconcileAgentConfigs when PATCH has no sessionMode field', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceSyncEnabled: true }),
      });

      expect(res.status).toBe(200);
      expect(mockReconcileAgentConfigs).not.toHaveBeenCalled();
    });

    it('reconcileAgentConfigs failure does not break the preferences response', async () => {
      const app = createTestApp();
      const prefsKey = 'user-prefs:codeflare-test-user';
      await mockKV.put(prefsKey, JSON.stringify({ sessionMode: 'default' }));
      mockReconcileAgentConfigs.mockRejectedValueOnce(new Error('R2 timeout'));

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { sessionMode?: string };
      expect(body.sessionMode).toBe('advanced');
    });
  });

  describe('userTimezone (REQ-MEM-001 AC3)', () => {
    it('accepts a valid IANA timezone and persists it', async () => {
      const app = createTestApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userTimezone: 'Europe/Zurich' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { userTimezone?: string };
      expect(body.userTimezone).toBe('Europe/Zurich');
    });

    it('accepts UTC as a special-case valid timezone', async () => {
      const app = createTestApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userTimezone: 'UTC' }),
      });
      expect(res.status).toBe(200);
    });

    it('rejects a syntactically valid but non-existent IANA tz', async () => {
      const app = createTestApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userTimezone: 'Mars/Olympus' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects an empty string timezone', async () => {
      const app = createTestApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userTimezone: '' }),
      });
      expect(res.status).toBe(400);
    });
  });
});

