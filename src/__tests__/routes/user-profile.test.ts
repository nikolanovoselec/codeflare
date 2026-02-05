import { describe, it, expect, vi, beforeEach } from 'vitest';
import userProfileRoutes from '../../routes/user-profile';
import type { Env } from '../../types';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError, AuthError } from '../../lib/error-types';
import { AuthVariables } from '../../middleware/auth';
import { createMockKV } from '../helpers/mock-kv';

// Mock authenticateRequest to control auth behavior
const mockAuthenticateRequest = vi.hoisted(() => vi.fn());

vi.mock('../../lib/access', () => ({
  authenticateRequest: mockAuthenticateRequest,
}));

describe('User Profile Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
  });

  function createApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: err.message }, 500);
    });

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        DEV_MODE: 'false',
        ...envOverrides,
      } as unknown as Env;
      return next();
    });

    app.route('/user', userProfileRoutes);
    return app;
  }

  describe('GET /user', () => {
    it('returns authenticated user info', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: { email: 'test@example.com', authenticated: true, role: 'user' },
        bucketName: 'codeflare-abc123',
      });

      const app = createApp();

      const res = await app.request('/user');

      expect(res.status).toBe(200);
      const body = await res.json() as {
        email: string;
        authenticated: boolean;
        role: string;
        bucketName: string;
        workerName: string;
        onboardingActive: boolean;
      };
      expect(body.email).toBe('test@example.com');
      expect(body.authenticated).toBe(true);
      expect(body.role).toBe('user');
      expect(body.bucketName).toBe('codeflare-abc123');
      expect(body.workerName).toBe('codeflare'); // default
      expect(body.onboardingActive).toBe(false);
    });

    it('returns custom workerName from env', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: { email: 'test@example.com', authenticated: true, role: 'admin' },
        bucketName: 'codeflare-abc123',
      });

      const app = createApp({ CLOUDFLARE_WORKER_NAME: 'my-app' } as Partial<Env>);

      const res = await app.request('/user');

      expect(res.status).toBe(200);
      const body = await res.json() as { workerName: string };
      expect(body.workerName).toBe('my-app');
    });

    it('returns onboardingActive true when ONBOARDING_LANDING_PAGE is active', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: { email: 'test@example.com', authenticated: true, role: 'user' },
        bucketName: 'codeflare-abc123',
      });

      const app = createApp({ ONBOARDING_LANDING_PAGE: 'active' } as Partial<Env>);

      const res = await app.request('/user');

      expect(res.status).toBe(200);
      const body = await res.json() as { onboardingActive: boolean };
      expect(body.onboardingActive).toBe(true);
    });

    it('returns 401 when not authenticated', async () => {
      mockAuthenticateRequest.mockRejectedValue(new AuthError('Not authenticated'));

      const app = createApp();

      const res = await app.request('/user');

      expect(res.status).toBe(401);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('AUTH_ERROR');
    });
  });
});
