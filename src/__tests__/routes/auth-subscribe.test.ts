import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, AccessUser } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

// Configurable mock auth result
const mockAuthResult = {
  user: { email: 'pending@example.com', authenticated: true, role: 'user', accessTier: 'pending', subscriptionTier: 'pending' } as AccessUser,
  bucketName: 'codeflare-pending',
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

describe('POST /auth/subscribe', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
    mockAuthShouldReject = false;
    mockAuthResult.user = {
      email: 'pending@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'pending',
      subscriptionTier: 'pending',
    };
    mockAuthResult.bucketName = 'codeflare-pending';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        TURNSTILE_SECRET_KEY: 'turnstile-secret',
        ...envOverrides,
      } as Env;
      return next();
    });

    app.route('/auth', authRoutes);

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  /** Mock a successful Turnstile verification */
  function mockTurnstileSuccess() {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (requestUrl.includes('/turnstile/v0/siteverify')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof globalThis.fetch;
  }

  /** Mock a failed Turnstile verification */
  function mockTurnstileFailure() {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (requestUrl.includes('/turnstile/v0/siteverify')) {
        return new Response(
          JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }),
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof globalThis.fetch;
  }

  /** Helper to POST /auth/subscribe with a body */
  function postSubscribe(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
    return app.request('/auth/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ---------------------------------------------------------------------------
  // Turnstile validation
  // ---------------------------------------------------------------------------

  // CF-001: When turnstile secret is configured, token is required
  it('returns 403 when turnstileToken is missing and turnstile secret is configured', async () => {
    const app = createApp();
    const res = await postSubscribe(app, { tier: 'free' });

    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('accepts subscribe without turnstileToken when turnstile secret is NOT configured', async () => {
    const app = createApp({ TURNSTILE_SECRET_KEY: undefined } as unknown as Partial<Env>);
    const res = await postSubscribe(app, { tier: 'free' });

    expect(res.status).toBe(200);
  });

  it('returns 403 when Turnstile token is invalid', async () => {
    mockTurnstileFailure();

    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'bad-token', tier: 'free' });

    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  // ---------------------------------------------------------------------------
  // Tier validation — only free, standard, max, unlimited accepted
  // ---------------------------------------------------------------------------

  it('accepts tier=free', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'free' });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; tier: string };
    expect(body.success).toBe(true);
    expect(body.tier).toBe('free');
  });

  it('accepts tier=standard', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'standard' });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; tier: string };
    expect(body.success).toBe(true);
    expect(body.tier).toBe('standard');
  });

  it('accepts tier=max', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'max' });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; tier: string };
    expect(body.success).toBe(true);
    expect(body.tier).toBe('max');
  });

  it('accepts tier=unlimited', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'unlimited' });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; tier: string };
    expect(body.success).toBe(true);
    expect(body.tier).toBe('unlimited');
  });

  it('rejects tier=blocked', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'blocked' });

    expect(res.status).toBe(400);
  });

  it('rejects tier=pending', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'pending' });

    expect(res.status).toBe(400);
  });

  it('accepts tier=advanced (now a subscribable tier)', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'advanced' });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; tier: string };
    expect(body.success).toBe(true);
    expect(body.tier).toBe('advanced');
  });

  it('rejects tier=trial (not directly subscribable)', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'trial' });

    expect(res.status).toBe(400);
  });

  it('rejects an unknown tier value', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'super-mega' });

    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // KV record updates
  // ---------------------------------------------------------------------------

  it('sets subscriptionTier on user KV record', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'standard' });

    const userData = await mockKV.get('user:pending@example.com', 'json') as Record<string, unknown>;
    expect(userData.subscriptionTier).toBe('standard');
  });

  it('sets subscribedAt timestamp on user KV record', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'free' });

    const userData = await mockKV.get('user:pending@example.com', 'json') as Record<string, unknown>;
    expect(userData.subscribedAt).toBeDefined();
    expect(typeof userData.subscribedAt).toBe('string');
    // Should be a valid ISO timestamp
    expect(new Date(userData.subscribedAt as string).toISOString()).toBe(userData.subscribedAt);
  });

  // ---------------------------------------------------------------------------
  // subscribedMode / mode parameter
  // ---------------------------------------------------------------------------

  it('subscribedMode is written to user KV record after subscribe', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'standard', mode: 'advanced' });

    const userData = await mockKV.get('user:pending@example.com', 'json') as Record<string, unknown>;
    expect(userData.subscribedMode).toBe('advanced');
  });

  it('mode parameter is accepted in subscribe request body', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'max', mode: 'default' });

    expect(res.status).toBe(200);
    const userData = await mockKV.get('user:pending@example.com', 'json') as Record<string, unknown>;
    expect(userData.subscribedMode).toBe('default');
  });

  // ---------------------------------------------------------------------------
  // Trial model: quota-based trials, no subscriptionExpiresAt
  // ---------------------------------------------------------------------------

  it('does not write trialBillingTriggered (removed — Stripe manages billing cycle)', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'standard' });

    expect(res.status).toBe(200);
    const userData = await mockKV.get('user:pending@example.com', 'json') as Record<string, unknown>;
    expect(userData.trialBillingTriggered).toBeUndefined();
    expect(userData.subscriptionExpiresAt).toBeUndefined();
  });

  it('does NOT set subscriptionExpiresAt for any tier', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'free' });

    expect(res.status).toBe(200);
    const body = await res.json() as { trialQuotaHours: number };
    expect(body.trialQuotaHours).toBe(0);

    const userData = await mockKV.get('user:pending@example.com', 'json') as Record<string, unknown>;
    expect(userData.subscriptionExpiresAt).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Response shape
  // ---------------------------------------------------------------------------

  it('returns { success, tier, trialQuotaHours, onboardingComplete } on success', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'standard' });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('success', true);
    expect(body).toHaveProperty('tier', 'standard');
    expect(body).toHaveProperty('trialQuotaHours');
    expect(typeof body.trialQuotaHours).toBe('number');
    expect(body).toHaveProperty('onboardingComplete');
  });

  // ---------------------------------------------------------------------------
  // Authentication requirement
  // ---------------------------------------------------------------------------

  it('returns 401 for unauthenticated request', async () => {
    mockAuthShouldReject = true;

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'free' });

    expect(res.status).toBe(401);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('AUTH_ERROR');
  });

  // ---------------------------------------------------------------------------
  // Stripe gate: paid tiers rejected when STRIPE_SECRET_KEY is set
  // ---------------------------------------------------------------------------

  it('rejects paid tier when STRIPE_SECRET_KEY is set', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp({ STRIPE_SECRET_KEY: 'sk_test_123' } as Partial<Env>);
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'standard' });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Paid subscriptions require checkout');
  });

  it('allows free tier even when STRIPE_SECRET_KEY is set', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp({ STRIPE_SECRET_KEY: 'sk_test_123' } as Partial<Env>);
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'free' });

    expect(res.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Idempotency: already subscribed
  // ---------------------------------------------------------------------------

  it('returns success idempotently when user is already subscribed', async () => {
    mockAuthResult.user = {
      email: 'subscribed@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'standard',
      subscriptionTier: 'standard',
    };
    mockAuthResult.bucketName = 'codeflare-subscribed';

    mockKV._set('user:subscribed@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'standard',
      subscriptionTier: 'standard',
      subscribedAt: '2025-01-02T00:00:00Z',
    });

    // fetch should NOT be called (no Turnstile verify needed)
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'standard' });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    // No Turnstile verification call made for idempotent case
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Pending users are allowed to call subscribe
  // ---------------------------------------------------------------------------

  it('allows pending users to subscribe (no active-user gate)', async () => {
    mockTurnstileSuccess();
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await postSubscribe(app, { turnstileToken: 'valid-token', tier: 'free' });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; tier: string };
    expect(body.success).toBe(true);
    expect(body.tier).toBe('free');
  });
});
