import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, requireAdmin, AuthVariables } from '../../middleware/auth';
import { authenticateRequest } from '../../lib/access';
import { AppError, AuthError, ForbiddenError } from '../../lib/error-types';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

describe('Auth Middleware', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
  });

  function createTestApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    // Set up mock env
    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        ...envOverrides,
      } as Env;
      return next();
    });

    // Apply auth middleware
    app.use('*', authMiddleware);

    // Test endpoint that returns the auth variables
    app.get('/test', (c) => {
      const user = c.get('user');
      const bucketName = c.get('bucketName');
      return c.json({ user, bucketName });
    });

    // Error handler to match the global one in index.ts
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  it('passes through and sets user + bucketName when user is in KV allowlist', async () => {
    const testEmail = 'allowed@example.com';
    mockKV._store.set(`user:${testEmail}`, JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01' }));

    const app = createTestApp();
    const res = await app.request('/test', {
      headers: {
        'cf-access-authenticated-user-email': testEmail,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { user: { email: string; authenticated: boolean }; bucketName: string };
    expect(body.user.email).toBe(testEmail);
    expect(body.user.authenticated).toBe(true);
    expect(body.bucketName).toContain('codeflare-');
    // Verify KV was checked for the user entry
    expect(mockKV.get).toHaveBeenCalledWith(`user:${testEmail}`);
  });

  it('returns 403 Forbidden when user is NOT in KV allowlist', async () => {
    const testEmail = 'notallowed@example.com';
    // Do NOT add user to KV store

    const app = createTestApp();
    const res = await app.request('/test', {
      headers: {
        'cf-access-authenticated-user-email': testEmail,
      },
    });

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('FORBIDDEN');
    // Verify KV was checked
    expect(mockKV.get).toHaveBeenCalledWith(`user:${testEmail}`);
  });

  it('returns 401 when unauthenticated (no CF Access headers)', async () => {
    const app = createTestApp();

    const res = await app.request('/test');

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('AUTH_ERROR');
    // KV should NOT have been called since auth failed before allowlist check
    expect(mockKV.get).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Role resolution tests
  // =========================================================================
  describe('Role resolution', () => {
    it('sets role to admin when KV entry has role: admin', async () => {
      const testEmail = 'admin@example.com';
      mockKV._store.set(
        `user:${testEmail}`,
        JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01', role: 'admin' })
      );

      const app = createTestApp();
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': testEmail },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { user: { email: string; role: string } };
      expect(body.user.role).toBe('admin');
    });

    it('defaults to role user when KV entry has no role field (legacy migration)', async () => {
      const testEmail = 'legacy@example.com';
      // Simulate a legacy KV entry without the role field
      mockKV._store.set(
        `user:${testEmail}`,
        JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01' })
      );

      const app = createTestApp();
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': testEmail },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { user: { email: string; role: string } };
      expect(body.user.role).toBe('user');
    });

  });

  // =========================================================================
  // authenticateRequest() direct tests
  // =========================================================================
  describe('authenticateRequest()', () => {
    function makeEnv(overrides: Partial<Env> = {}): Env {
      return {
        KV: mockKV as unknown as KVNamespace,
        ...overrides,
      } as Env;
    }

    it('returns user and bucketName on successful authentication', async () => {
      const testEmail = 'success@example.com';
      mockKV._store.set(
        `user:${testEmail}`,
        JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01', role: 'user' })
      );

      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': testEmail },
      });

      const result = await authenticateRequest(request, makeEnv());

      expect(result.user.email).toBe(testEmail);
      expect(result.user.authenticated).toBe(true);
      expect(result.user.role).toBe('user');
      expect(result.bucketName).toContain('codeflare-');
    });

    it('throws AuthError when not authenticated', async () => {
      const request = new Request('http://localhost/test');

      await expect(
        authenticateRequest(request, makeEnv())
      ).rejects.toThrow(AuthError);
    });

    it('throws ForbiddenError when user not in allowlist', async () => {
      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': 'unknown@example.com' },
      });

      await expect(
        authenticateRequest(request, makeEnv())
      ).rejects.toThrow(ForbiddenError);
    });

  });

  // =========================================================================
  // requireAdmin middleware (CF-011)
  // =========================================================================
  describe('requireAdmin', () => {
    /**
     * Creates a Hono app with auth + requireAdmin middleware.
     * authMiddleware sets user/bucketName, then requireAdmin checks the role.
     */
    function createAdminApp(envOverrides: Partial<Env> = {}) {
      const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

      app.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          ...envOverrides,
        } as Env;
        return next();
      });

      app.use('*', authMiddleware);

      // Protected route requiring admin
      app.get('/admin', requireAdmin, (c) => {
        return c.json({ ok: true });
      });

      app.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });

      return app;
    }

    it('returns 403 for non-admin user', async () => {
      const testEmail = 'regular@example.com';
      mockKV._store.set(
        `user:${testEmail}`,
        JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01', role: 'user' })
      );

      const app = createAdminApp();
      const res = await app.request('/admin', {
        headers: { 'cf-access-authenticated-user-email': testEmail },
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('FORBIDDEN');
    });

    it('calls next() and returns 200 for admin user', async () => {
      const testEmail = 'admin@example.com';
      mockKV._store.set(
        `user:${testEmail}`,
        JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01', role: 'admin' })
      );

      const app = createAdminApp();
      const res = await app.request('/admin', {
        headers: { 'cf-access-authenticated-user-email': testEmail },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it('returns 401 when user context is missing (no auth header)', async () => {
      const app = createAdminApp();
      const res = await app.request('/admin');

      // authMiddleware throws AuthError before requireAdmin runs
      expect(res.status).toBe(401);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('AUTH_ERROR');
    });

    it('returns 403 when user has no role (legacy KV entry)', async () => {
      const testEmail = 'norole@example.com';
      // Legacy entry without role field — authenticateRequest defaults to 'user'
      mockKV._store.set(
        `user:${testEmail}`,
        JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01' })
      );

      const app = createAdminApp();
      const res = await app.request('/admin', {
        headers: { 'cf-access-authenticated-user-email': testEmail },
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('FORBIDDEN');
    });

    it('returns 403 for unexpected role casing (Admin vs admin)', async () => {
      const testEmail = 'badcase@example.com';
      // Force an unexpected casing by storing 'Admin' (capital A)
      mockKV._store.set(
        `user:${testEmail}`,
        JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01', role: 'Admin' })
      );

      const app = createAdminApp();
      const res = await app.request('/admin', {
        headers: { 'cf-access-authenticated-user-email': testEmail },
      });

      // requireAdmin checks strict equality: user.role !== 'admin'
      // 'Admin' !== 'admin' so it should be 403
      expect(res.status).toBe(403);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('FORBIDDEN');
    });
  });
});
