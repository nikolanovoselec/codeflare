import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, AccessUser } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

// Mock authenticateRequest — returns configurable { user, bucketName }
const mockAuthResult = {
  user: { email: 'test@example.com', authenticated: true, role: 'user' } as AccessUser,
  bucketName: 'codeflare-test',
};

vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => ({ ...mockAuthResult, user: { ...mockAuthResult.user } })),
}));

// Import AFTER mock is set up
import { requireIdentity, requireActiveUser, requireAdmin } from '../../middleware/auth';
import { authenticateRequest } from '../../lib/access';

const mockedAuth = vi.mocked(authenticateRequest);

describe('Three-tier auth middleware (SaaS mode)', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    // Reset to default user for each test
    mockAuthResult.user = {
      email: 'test@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'standard',
    };
    mockAuthResult.bucketName = 'codeflare-test';
  });

  /**
   * Creates a Hono test app that applies a single auth middleware.
   */
  function createApp(
    middleware: (c: any, next: any) => Promise<any>,
    envOverrides: Partial<Env> = {}
  ) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        ...envOverrides,
      } as Env;
      return next();
    });

    app.use('*', middleware);

    app.get('/test', (c) => {
      const user = c.get('user');
      const bucketName = c.get('bucketName');
      return c.json({ user, bucketName });
    });

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  /**
   * Creates a Hono test app that chains requireIdentity + requireAdmin,
   * matching how existing routes use them (authMiddleware sets user, requireAdmin gates role).
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

    app.use('*', requireIdentity);

    app.get('/test', requireAdmin, (c) => {
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

  // ===========================================================================
  // requireIdentity
  // ===========================================================================
  describe('requireIdentity', () => {
    it('sets user and bucketName on context', async () => {
      const app = createApp(requireIdentity);
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'test@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { user: AccessUser; bucketName: string };
      expect(body.user.email).toBe('test@example.com');
      expect(body.bucketName).toBe('codeflare-test');
    });

    it('allows pending users through (no tier gate)', async () => {
      mockAuthResult.user = {
        email: 'pending@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'pending',
      };

      const app = createApp(requireIdentity);
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'pending@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { user: AccessUser };
      expect(body.user.accessTier).toBe('pending');
    });

    it('throws on unauthenticated request', async () => {
      mockedAuth.mockRejectedValueOnce(new AppError('AUTH_ERROR', 401, 'Not authenticated'));

      const app = createApp(requireIdentity);
      const res = await app.request('/test');

      expect(res.status).toBe(401);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('AUTH_ERROR');
    });
  });

  // ===========================================================================
  // requireActiveUser
  // ===========================================================================
  describe('requireActiveUser', () => {
    it('allows standard tier through when SAAS_MODE=active', async () => {
      mockAuthResult.user = {
        email: 'std@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'standard',
      };

      const app = createApp(requireActiveUser, { SAAS_MODE: 'active' });
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'std@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { user: AccessUser };
      expect(body.user.accessTier).toBe('standard');
    });

    it('allows advanced tier through when SAAS_MODE=active', async () => {
      mockAuthResult.user = {
        email: 'adv@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'advanced',
      };

      const app = createApp(requireActiveUser, { SAAS_MODE: 'active' });
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'adv@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { user: AccessUser };
      expect(body.user.accessTier).toBe('advanced');
    });

    it('returns 403 with code PENDING for pending users on API request (Accept: application/json)', async () => {
      mockAuthResult.user = {
        email: 'pending@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'pending',
      };

      const app = createApp(requireActiveUser, { SAAS_MODE: 'active' });
      const res = await app.request('/test', {
        headers: {
          'cf-access-authenticated-user-email': 'pending@example.com',
          'Accept': 'application/json',
        },
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('PENDING');
      expect(body.error).toBe('Access denied');
    });

    it('returns 403 PENDING for pending users regardless of Accept header', async () => {
      mockAuthResult.user = {
        email: 'pending@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'pending',
      };

      const app = createApp(requireActiveUser, { SAAS_MODE: 'active' });
      const res = await app.request('/test', {
        headers: {
          'cf-access-authenticated-user-email': 'pending@example.com',
          'Accept': 'text/html',
        },
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('PENDING');
    });

    it('returns 403 with code BLOCKED for blocked users', async () => {
      mockAuthResult.user = {
        email: 'blocked@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'blocked',
      };

      const app = createApp(requireActiveUser, { SAAS_MODE: 'active' });
      const res = await app.request('/test', {
        headers: {
          'cf-access-authenticated-user-email': 'blocked@example.com',
          'Accept': 'application/json',
        },
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('BLOCKED');
    });

    it('allows all users through when SAAS_MODE not set (backward compat)', async () => {
      mockAuthResult.user = {
        email: 'pending@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'pending',
      };

      // No SAAS_MODE env var
      const app = createApp(requireActiveUser);
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'pending@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { user: AccessUser };
      expect(body.user.accessTier).toBe('pending');
    });

    it('allows undefined accessTier through (backward compat)', async () => {
      mockAuthResult.user = {
        email: 'legacy@example.com',
        authenticated: true,
        role: 'user',
        // accessTier intentionally omitted
      };

      const app = createApp(requireActiveUser, { SAAS_MODE: 'active' });
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'legacy@example.com' },
      });

      // isActiveUser(undefined) returns true — backward compat
      expect(res.status).toBe(200);
    });
  });

  // ===========================================================================
  // requireAdmin
  // ===========================================================================
  describe('requireAdmin', () => {
    it('allows admin through', async () => {
      mockAuthResult.user = {
        email: 'admin@example.com',
        authenticated: true,
        role: 'admin',
        accessTier: 'advanced',
      };

      const app = createAdminApp();
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'admin@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it('rejects non-admin', async () => {
      mockAuthResult.user = {
        email: 'user@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'standard',
      };

      const app = createAdminApp();
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'user@example.com' },
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('FORBIDDEN');
    });
  });
});
