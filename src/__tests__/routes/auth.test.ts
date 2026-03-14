import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, AccessUser } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

// Configurable mock auth result
const mockAuthResult = {
  user: { email: 'test@example.com', authenticated: true, role: 'user', accessTier: 'standard' } as AccessUser,
  bucketName: 'codeflare-test',
};
let mockAuthShouldReject = false;

vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => {
    if (mockAuthShouldReject) {
      throw new AppError('AUTH_ERROR', 401, 'Not authenticated');
    }
    return { ...mockAuthResult, user: { ...mockAuthResult.user } };
  }),
}));

// Import after mock
import authRoutes from '../../routes/auth';

describe('Auth routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    mockAuthShouldReject = false;
    mockAuthResult.user = {
      email: 'test@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'standard',
    };
    mockAuthResult.bucketName = 'codeflare-test';
  });

  function createApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        ...envOverrides,
      } as Env;
      return next();
    });

    app.route('/auth', authRoutes);

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  // ===========================================================================
  // GET /auth/providers
  // ===========================================================================
  describe('GET /providers', () => {
    it('returns empty providers when KV has no idp_list', async () => {
      const app = createApp();
      const res = await app.request('/auth/providers');

      expect(res.status).toBe(200);
      const body = await res.json() as { providers: unknown[] };
      expect(body.providers).toEqual([]);
    });

    it('returns providers from KV when configured', async () => {
      const providers = [
        { id: 'github-123', type: 'github', name: 'GitHub' },
        { id: 'google-456', type: 'google', name: 'Google' },
      ];
      mockKV._set('setup:idp_list', providers);

      const app = createApp();
      const res = await app.request('/auth/providers');

      expect(res.status).toBe(200);
      const body = await res.json() as { providers: typeof providers };
      expect(body.providers).toEqual(providers);
      expect(body.providers).toHaveLength(2);
      expect(body.providers[0].type).toBe('github');
    });

    it('response shape includes providers array', async () => {
      const app = createApp();
      const res = await app.request('/auth/providers');

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('providers');
      expect(Array.isArray(body.providers)).toBe(true);
    });
  });

  // ===========================================================================
  // GET /auth/status
  // ===========================================================================
  describe('GET /status', () => {
    it('returns email, accessTier, role for authenticated user', async () => {
      mockAuthResult.user = {
        email: 'user@example.com',
        authenticated: true,
        role: 'admin',
        accessTier: 'advanced',
      };

      const app = createApp();
      const res = await app.request('/auth/status', {
        headers: { 'cf-access-authenticated-user-email': 'user@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { email: string; accessTier: string; role: string };
      expect(body.email).toBe('user@example.com');
      expect(body.accessTier).toBe('advanced');
      expect(body.role).toBe('admin');
    });

    it('returns 401 for unauthenticated request', async () => {
      mockAuthShouldReject = true;

      const app = createApp();
      const res = await app.request('/auth/status');

      expect(res.status).toBe(401);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('AUTH_ERROR');
    });

    it('defaults accessTier to advanced when undefined', async () => {
      mockAuthResult.user = {
        email: 'legacy@example.com',
        authenticated: true,
        role: 'user',
        // accessTier intentionally omitted
      };

      const app = createApp();
      const res = await app.request('/auth/status', {
        headers: { 'cf-access-authenticated-user-email': 'legacy@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { accessTier: string; role: string };
      expect(body.accessTier).toBe('advanced');
      expect(body.role).toBe('user');
    });
  });
});
