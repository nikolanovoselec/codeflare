import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, AccessUser } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

// Configurable mock auth result
const mockAuthResult = {
  user: { email: 'test@example.com', authenticated: true, role: 'user', accessTier: 'standard', subscriptionTier: 'standard' } as AccessUser,
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

const { mockGetStripePrices } = vi.hoisted(() => ({
  mockGetStripePrices: vi.fn(async () => new Map()),
}));
vi.mock('../../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stripe')>();
  return {
    ...actual,
    getStripePrices: mockGetStripePrices,
  };
});

// Import after mock
import authRoutes from '../../routes/auth';

describe('Auth routes / REQ-SEC-015 (auth-bypass prevention on public endpoints)', () => {
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
      subscriptionTier: 'standard',
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
    it('returns email, accessTier, subscriptionTier, role for authenticated user', async () => {
      mockAuthResult.user = {
        email: 'user@example.com',
        authenticated: true,
        role: 'admin',
        accessTier: 'advanced',
        subscriptionTier: 'advanced',
      };

      const app = createApp();
      const res = await app.request('/auth/status', {
        headers: { 'cf-access-authenticated-user-email': 'user@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { email: string; accessTier: string; subscriptionTier: string; role: string };
      expect(body.email).toBe('user@example.com');
      expect(body.accessTier).toBe('advanced');
      expect(body.subscriptionTier).toBe('advanced');
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

    it('returns subscribedMode from user KV record', async () => {
      mockAuthResult.user = {
        email: 'pro@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'advanced',
        subscriptionTier: 'max',
      };

      mockKV._set('user:pro@example.com', {
        addedBy: 'jit',
        addedAt: '2025-01-01T00:00:00Z',
        role: 'user',
        accessTier: 'advanced',
        subscriptionTier: 'max',
        subscribedMode: 'advanced',
      });

      const app = createApp();
      const res = await app.request('/auth/status', {
        headers: { 'cf-access-authenticated-user-email': 'pro@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { subscribedMode: string };
      expect(body.subscribedMode).toBe('advanced');
    });

    it('defaults accessTier and subscriptionTier to advanced when undefined', async () => {
      mockAuthResult.user = {
        email: 'legacy@example.com',
        authenticated: true,
        role: 'user',
        // accessTier and subscriptionTier intentionally omitted
      };

      const app = createApp();
      const res = await app.request('/auth/status', {
        headers: { 'cf-access-authenticated-user-email': 'legacy@example.com' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { accessTier: string; subscriptionTier: string; role: string };
      expect(body.accessTier).toBe('advanced');
      expect(body.subscriptionTier).toBe('advanced');
      expect(body.role).toBe('user');
    });
  });

  // REQ-SUB-020: Multi-currency pricing
  describe('GET /tiers currency detection', () => {
    it('passes detected EUR currency to getStripePrices for German visitor', async () => {
      // Seed tier config with Stripe price IDs
      const { getDefaultTiers, resetTierConfigCache } = await import('../../lib/subscription');
      resetTierConfigCache();
      const tiersWithPrices = getDefaultTiers().map((t) => {
        if (t.id === 'standard') return { ...t, stripePriceId: 'price_std' };
        return t;
      });
      mockKV._set('tiers:config', tiersWithPrices);

      mockGetStripePrices.mockResolvedValue(
        new Map([['price_std', { amount: 2400, currency: 'EUR' }]]),
      );

      const app = createApp({ STRIPE_SECRET_KEY: 'sk_test_123' });
      await app.request('/auth/tiers', {
        headers: { 'CF-IPCountry': 'DE' },
      });

      expect(mockGetStripePrices).toHaveBeenCalledWith(
        expect.any(Array),
        'sk_test_123',
        'eur',
      );
    });

    it('passes USD currency when CF-IPCountry is absent', async () => {
      const { getDefaultTiers, resetTierConfigCache } = await import('../../lib/subscription');
      resetTierConfigCache();
      const tiersWithPrices = getDefaultTiers().map((t) => {
        if (t.id === 'standard') return { ...t, stripePriceId: 'price_std' };
        return t;
      });
      mockKV._set('tiers:config', tiersWithPrices);

      mockGetStripePrices.mockResolvedValue(
        new Map([['price_std', { amount: 2400, currency: 'USD' }]]),
      );

      const app = createApp({ STRIPE_SECRET_KEY: 'sk_test_123' });
      await app.request('/auth/tiers');

      expect(mockGetStripePrices).toHaveBeenCalledWith(
        expect.any(Array),
        'sk_test_123',
        'usd',
      );
    });
  });
});
