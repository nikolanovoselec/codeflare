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

describe('Three-tier auth middleware (SaaS mode) / REQ-AUTH-005 (requireIdentity + requireActiveUser + requireAdmin layered stack)', () => {
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
      subscriptionTier: 'standard',
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
  describe('requireIdentity / REQ-AUTH-005 AC1 (resolves user + auto-provisions pending in SaaS + sets c.user)', () => {
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
        subscriptionTier: 'pending',
      };

      const app = createApp(requireIdentity);
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'pending@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { user: AccessUser };
      expect(body.user.subscriptionTier).toBe('pending');
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
  describe('requireActiveUser / REQ-AUTH-005 AC2 (active-tier check, 403 PENDING/BLOCKED, no-op outside SaaS) / REQ-AUTH-005 AC4 (also exported as authMiddleware for backcompat)', () => {
    it('allows standard tier through when SAAS_MODE=active', async () => {
      mockAuthResult.user = {
        email: 'std@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'standard',
        subscriptionTier: 'standard',
      };

      const app = createApp(requireActiveUser, { SAAS_MODE: 'active' });
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'std@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { user: AccessUser };
      expect(body.user.subscriptionTier).toBe('standard');
    });

    it('allows advanced tier through when SAAS_MODE=active', async () => {
      mockAuthResult.user = {
        email: 'adv@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'advanced',
        subscriptionTier: 'advanced',
      };

      const app = createApp(requireActiveUser, { SAAS_MODE: 'active' });
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'adv@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { user: AccessUser };
      expect(body.user.subscriptionTier).toBe('advanced');
    });

    it('returns 403 with code PENDING for pending users on API request (Accept: application/json)', async () => {
      mockAuthResult.user = {
        email: 'pending@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'pending',
        subscriptionTier: 'pending',
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
        subscriptionTier: 'pending',
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
        subscriptionTier: 'blocked',
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
        subscriptionTier: 'pending',
      };

      // No SAAS_MODE env var
      const app = createApp(requireActiveUser);
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'pending@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { user: AccessUser };
      expect(body.user.subscriptionTier).toBe('pending');
    });

    // CF-005: undefined tiers now resolve to 'pending' (blocked) instead of 'advanced' (allowed).
    // This prevents free compute for users with corrupted/missing KV records.
    it('blocks undefined accessTier as pending (CF-005)', async () => {
      mockAuthResult.user = {
        email: 'legacy@example.com',
        authenticated: true,
        role: 'user',
        // accessTier intentionally omitted — resolves to 'pending' via getEffectiveTier
      };

      const app = createApp(requireActiveUser, { SAAS_MODE: 'active' });
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'legacy@example.com' },
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('PENDING');
    });

    // REQ-AUTH-020: the tier gate also applies in onboarding mode (SAAS inactive),
    // so /app stays approved-users-only — an approved (active) user passes, a
    // pending onboarding visitor with a session cookie is still blocked.
    it('REQ-AUTH-020: allows active tier through in onboarding mode (SAAS inactive)', async () => {
      mockAuthResult.user = {
        email: 'approved@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'advanced',
        subscriptionTier: 'advanced',
      };

      const app = createApp(requireActiveUser, { ONBOARDING_LANDING_PAGE: 'active', SAAS_MODE: 'inactive' });
      const res = await app.request('/test', {
        headers: { 'cf-access-authenticated-user-email': 'approved@example.com' },
      });

      expect(res.status).toBe(200);
    });

    it('REQ-AUTH-020: blocks pending users with 403 PENDING in onboarding mode (SAAS inactive)', async () => {
      mockAuthResult.user = {
        email: 'pending@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'pending',
        subscriptionTier: 'pending',
      };

      const app = createApp(requireActiveUser, { ONBOARDING_LANDING_PAGE: 'active', SAAS_MODE: 'inactive' });
      const res = await app.request('/test', {
        headers: {
          'cf-access-authenticated-user-email': 'pending@example.com',
          'Accept': 'application/json',
        },
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('PENDING');
    });
  });

  // ===========================================================================
  // requireAdmin
  // ===========================================================================
  describe('requireAdmin / REQ-AUTH-005 AC3 (role === admin, composed after requireIdentity)', () => {
    it('allows admin through', async () => {
      mockAuthResult.user = {
        email: 'admin@example.com',
        authenticated: true,
        role: 'admin',
        accessTier: 'advanced',
        subscriptionTier: 'unlimited',
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
        subscriptionTier: 'standard',
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
