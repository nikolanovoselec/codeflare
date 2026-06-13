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
const mockGetOrCreateScopedR2Token = vi.hoisted(() => vi.fn());

vi.mock('../../lib/access', () => ({
  authenticateRequest: mockAuthenticateRequest,
}));

vi.mock('../../lib/r2-admin', () => ({
  getOrCreateScopedR2Token: mockGetOrCreateScopedR2Token,
}));

// REQ-AUTH-019: User identity and account-status API
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
      // Onboarding mode now applies the active-tier gate (REQ-AUTH-020), so the
      // mock user must be active for GET /user to return 200; a tier-less user is
      // correctly 403'd here, the same as a pending onboarding visitor.
      mockAuthenticateRequest.mockResolvedValue({
        user: {
          email: 'test@example.com',
          authenticated: true,
          role: 'user',
          accessTier: 'advanced',
          subscriptionTier: 'advanced',
        },
        bucketName: 'codeflare-abc123',
      });

      const app = createApp({ ONBOARDING_LANDING_PAGE: 'active' } as Partial<Env>);

      const res = await app.request('/user');

      expect(res.status).toBe(200);
      const body = await res.json() as { onboardingActive: boolean };
      expect(body.onboardingActive).toBe(true);
    });

    it('returns the full account-status payload (all AC1 fields)', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: {
          email: 'test@example.com',
          authenticated: true,
          role: 'user',
          accessTier: 'pro',
          subscriptionTier: 'pro',
        },
        bucketName: 'codeflare-abc123',
      });
      mockKV._set('user:test@example.com', { onboardingComplete: true, subscribedMode: 'advanced' });

      const app = createApp();
      const res = await app.request('/user');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        email: 'test@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'pro',
        subscriptionTier: 'pro',
        bucketName: 'codeflare-abc123',
        workerName: 'codeflare',
        onboardingActive: false,
        saasMode: false,
        onboardingComplete: true,
        hasSubscribed: true,
        subscribedMode: 'advanced',
        enterpriseMode: false,
      });
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

  // =========================================================================
  // Auth required on every endpoint - REQ-AUTH-019 AC5
  // =========================================================================
  describe('authentication required across all endpoints', () => {
    it.each([
      ['GET', '/user'],
      ['POST', '/user/onboarding-complete'],
      ['GET', '/user/r2-status'],
      ['POST', '/user/ensure-r2-token'],
    ])('rejects unauthenticated %s %s with 401', async (method, path) => {
      mockAuthenticateRequest.mockRejectedValue(new AuthError('Not authenticated'));

      const app = createApp();
      const res = await app.request(path, { method });

      expect(res.status).toBe(401);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('AUTH_ERROR');
    });
  });

  // =========================================================================
  // POST /user/onboarding-complete - REQ-AUTH-019 AC2
  // =========================================================================
  describe('POST /user/onboarding-complete', () => {
    it('marks the stored user record onboarding-complete and preserves existing fields', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: { email: 'test@example.com', authenticated: true, role: 'user' },
        bucketName: 'codeflare-abc123',
      });
      mockKV._set('user:test@example.com', { subscribedMode: 'advanced' });

      const app = createApp();
      const res = await app.request('/user/onboarding-complete', { method: 'POST' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      const stored = await mockKV.get('user:test@example.com', 'json') as {
        onboardingComplete?: boolean;
        subscribedMode?: string;
      };
      expect(stored.onboardingComplete).toBe(true);
      expect(stored.subscribedMode).toBe('advanced');
    });

    it('is a no-op when the user has no stored record yet', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: { email: 'new@example.com', authenticated: true, role: 'user' },
        bucketName: 'codeflare-xyz',
      });

      const app = createApp();
      const res = await app.request('/user/onboarding-complete', { method: 'POST' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(await mockKV.get('user:new@example.com')).toBeNull();
    });
  });

  // =========================================================================
  // GET /user/r2-status - R2 scoped token readiness
  // =========================================================================
  describe('GET /user/r2-status', () => {
    it('should return { ready: true } when r2token:{email} exists in KV', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: { email: 'test@example.com', authenticated: true, role: 'user' },
        bucketName: 'codeflare-abc123',
      });

      // Populate r2token KV entry
      mockKV._set('r2token:test@example.com', {
        accessKeyId: 'ak-123',
        secretAccessKey: 'sk-456',
        tokenId: 'tok-789',
        bucketName: 'codeflare-abc123',
        createdAt: '2024-01-01T00:00:00Z',
      });

      const app = createApp();
      const res = await app.request('/user/r2-status');

      expect(res.status).toBe(200);
      const body = await res.json() as { ready: boolean };
      expect(body.ready).toBe(true);
    });

    it('should return { ready: false } when no r2token:{email} in KV', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: { email: 'test@example.com', authenticated: true, role: 'user' },
        bucketName: 'codeflare-abc123',
      });

      // No r2token entry in KV

      const app = createApp();
      const res = await app.request('/user/r2-status');

      expect(res.status).toBe(200);
      const body = await res.json() as { ready: boolean };
      expect(body.ready).toBe(false);
    });
  });

  // =========================================================================
  // POST /user/ensure-r2-token - Eagerly create scoped R2 token
  // =========================================================================
  describe('POST /user/ensure-r2-token', () => {
    it('should return { ready: true } when token is created successfully', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: { email: 'test@example.com', authenticated: true, role: 'user' },
        bucketName: 'codeflare-abc123',
      });
      mockKV._store.set('setup:account_id', 'test-account-id');
      mockGetOrCreateScopedR2Token.mockResolvedValue({
        accessKeyId: 'ak-123',
        secretAccessKey: 'sk-456',
        tokenId: 'tok-789',
      });

      const app = createApp({ CLOUDFLARE_API_TOKEN: 'test-token' } as Partial<Env>);
      const res = await app.request('/user/ensure-r2-token', { method: 'POST' });

      expect(res.status).toBe(200);
      const body = await res.json() as { ready: boolean };
      expect(body.ready).toBe(true);
      expect(mockGetOrCreateScopedR2Token).toHaveBeenCalledWith(
        'test@example.com',
        'test-account-id',
        'test-token',
        'codeflare-abc123',
        expect.anything(), // KV namespace
        null, // cryptoKey (no ENCRYPTION_KEY set)
      );
    });

    it('should return 503 when setup is incomplete (no account_id)', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: { email: 'test@example.com', authenticated: true, role: 'user' },
        bucketName: 'codeflare-abc123',
      });
      // No setup:account_id in KV

      const app = createApp({ CLOUDFLARE_API_TOKEN: 'test-token' } as Partial<Env>);
      const res = await app.request('/user/ensure-r2-token', { method: 'POST' });

      expect(res.status).toBe(503);
      const body = await res.json() as { ready: boolean; error: string };
      expect(body.ready).toBe(false);
      expect(body.error).toBe('Setup incomplete');
    });

    it('should return 503 when CLOUDFLARE_API_TOKEN is missing', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: { email: 'test@example.com', authenticated: true, role: 'user' },
        bucketName: 'codeflare-abc123',
      });
      mockKV._store.set('setup:account_id', 'test-account-id');

      const app = createApp({ CLOUDFLARE_API_TOKEN: '' } as Partial<Env>);
      const res = await app.request('/user/ensure-r2-token', { method: 'POST' });

      expect(res.status).toBe(503);
    });

    it('should return 500 with error message when token creation fails', async () => {
      mockAuthenticateRequest.mockResolvedValue({
        user: { email: 'test@example.com', authenticated: true, role: 'user' },
        bucketName: 'codeflare-abc123',
      });
      mockKV._store.set('setup:account_id', 'test-account-id');
      mockGetOrCreateScopedR2Token.mockRejectedValue(new Error('CF API returned 403'));

      const app = createApp({ CLOUDFLARE_API_TOKEN: 'test-token' } as Partial<Env>);
      const res = await app.request('/user/ensure-r2-token', { method: 'POST' });

      expect(res.status).toBe(500);
      const body = await res.json() as { ready: boolean; error: string };
      expect(body.ready).toBe(false);
      expect(body.error).toContain('403');
    });
  });

});
