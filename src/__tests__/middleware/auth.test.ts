import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, AuthVariables } from '../../middleware/auth';
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
        DEV_MODE: 'false',
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

  it('bypasses KV allowlist check when DEV_MODE=true', async () => {
    const app = createTestApp({ DEV_MODE: 'true' } as Partial<Env>);

    // In DEV_MODE, getUserFromRequest returns a test user even without headers
    const res = await app.request('/test');

    expect(res.status).toBe(200);
    const body = await res.json() as { user: { email: string; authenticated: boolean }; bucketName: string };
    expect(body.user.authenticated).toBe(true);
    expect(body.bucketName).toContain('codeflare-');
    // KV should NOT have been called for user lookup
    expect(mockKV.get).not.toHaveBeenCalledWith(expect.stringMatching(/^user:/));
  });

  it('returns 401 when unauthenticated (no CF Access headers, DEV_MODE=false)', async () => {
    const app = createTestApp({ DEV_MODE: 'false' } as Partial<Env>);

    // No CF Access headers, DEV_MODE is false
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

    it('grants admin role in DEV_MODE', async () => {
      const app = createTestApp({ DEV_MODE: 'true' } as Partial<Env>);

      const res = await app.request('/test');

      expect(res.status).toBe(200);
      const body = await res.json() as { user: { email: string; role: string } };
      expect(body.user.role).toBe('admin');
    });
  });

  // =========================================================================
  // authenticateRequest() direct tests
  // =========================================================================
  describe('authenticateRequest()', () => {
    function makeEnv(overrides: Partial<Env> = {}): Env {
      return {
        KV: mockKV as unknown as KVNamespace,
        DEV_MODE: 'false',
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

    it('bypasses allowlist and grants admin in DEV_MODE', async () => {
      const request = new Request('http://localhost/test');

      const result = await authenticateRequest(request, makeEnv({ DEV_MODE: 'true' } as Partial<Env>));

      expect(result.user.authenticated).toBe(true);
      expect(result.user.role).toBe('admin');
      expect(result.bucketName).toContain('codeflare-');
    });
  });
});
