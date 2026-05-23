import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, AccessUser } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import { getDefaultTiers, resetTierConfigCache } from '../../lib/subscription';

// ---------------------------------------------------------------------------
// Auth mock
// ---------------------------------------------------------------------------
const mockAuthResult = {
  user: { email: 'user@example.com', authenticated: true, role: 'user', accessTier: 'pending', subscriptionTier: 'pending' } as AccessUser,
  bucketName: 'codeflare-user',
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

// ---------------------------------------------------------------------------
// Stripe mock
// ---------------------------------------------------------------------------
vi.mock('../../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stripe')>();
  return {
    ...actual,
    createCheckoutSession: vi.fn(async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/test' })),
    createPortalSession: vi.fn(async () => ({ id: 'bps_test_123', url: 'https://billing.stripe.com/test' })),
    createSwitchPortalSession: vi.fn(async () => ({ id: 'bps_switch_123', url: 'https://billing.stripe.com/switch' })),
    fetchSubscription: vi.fn(async () => null),
  };
});

// Import after mocks
import billingRoutes from '../../routes/billing';
import stripeWebhookRoute from '../../routes/stripe-webhook';
import { createCheckoutSession, createPortalSession, createSwitchPortalSession, fetchSubscription } from '../../lib/stripe';

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function createApp(envOverrides: Partial<Env> = {}) {
  resetTierConfigCache(); // Ensure fresh tier config from this test's KV
  const mockKV = createMockKV();
  // Seed tier config with Stripe price IDs (required since DEV_PRICE_MAP was removed)
  const tiersWithPrices = getDefaultTiers().map((t) => {
    if (t.id === 'standard') return { ...t, stripePriceId: 'price_std_default', stripeAdvancedPriceId: 'price_std_advanced' };
    if (t.id === 'advanced') return { ...t, stripePriceId: 'price_adv_default', stripeAdvancedPriceId: 'price_adv_advanced' };
    if (t.id === 'max') return { ...t, stripePriceId: 'price_max_default', stripeAdvancedPriceId: 'price_max_advanced' };
    return t;
  });
  mockKV._set('tiers:config', tiersWithPrices);
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

  app.use('*', async (c, next) => {
    c.env = {
      KV: mockKV as unknown as KVNamespace,
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_123',
      ...envOverrides,
    } as Env;
    return next();
  });

  app.route('/billing', billingRoutes);
  app.route('/public/stripe', stripeWebhookRoute);

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
    }
    return c.json({ error: 'Unexpected error' }, 500);
  });

  return { app, mockKV };
}

// ---------------------------------------------------------------------------
// POST /billing/checkout
// ---------------------------------------------------------------------------
describe('POST /billing/checkout / REQ-SUB-020 (multi-currency pricing from CF-IPCountry) / REQ-SUB-004 (Stripe checkout session creation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthShouldReject = false;
    mockAuthResult.user = { email: 'user@example.com', authenticated: true, role: 'user', accessTier: 'pending', subscriptionTier: 'pending' };
  });

  it('returns checkoutUrl for paid tier', async () => {
    const { app } = createApp();
    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'standard', mode: 'default' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { checkoutUrl: string };
    expect(body.checkoutUrl).toBe('https://checkout.stripe.com/test');
    expect(createCheckoutSession).toHaveBeenCalled();
  });

  it('passes billingCycleAnchor after trial end when trial is active (REQ-SUB-021)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { app } = createApp();
    await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'standard', mode: 'default' }),
    });

    const mockedFn = createCheckoutSession as ReturnType<typeof vi.fn>;
    expect(mockedFn).toHaveBeenCalled();
    const opts = mockedFn.mock.calls[0][0] as { billingCycleAnchor?: number; trialDays?: number };
    // Trial is active (user has not used trial) — 7 days
    expect(opts.trialDays).toBe(7);
    // Anchor must be strictly after trial end (now + 7 days) to satisfy Stripe
    const trialEnd = before + 7 * 86400;
    expect(opts.billingCycleAnchor!).toBeGreaterThan(trialEnd);
    // Upper bound: trial end + ~31 days (first of next month after trial end)
    expect(opts.billingCycleAnchor!).toBeLessThanOrEqual(trialEnd + 32 * 86400);
  });

  it('passes billingCycleAnchor for next 1st of month when trial already used (REQ-SUB-021)', async () => {
    const { app, mockKV } = createApp();
    mockKV._set('user:user@example.com', { email: 'user@example.com', trialUsed: true });

    const before = Math.floor(Date.now() / 1000);
    await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'standard', mode: 'default' }),
    });

    const mockedFn = createCheckoutSession as ReturnType<typeof vi.fn>;
    const opts = mockedFn.mock.calls[0][0] as { billingCycleAnchor?: number; trialDays?: number };
    expect(opts.trialDays).toBeUndefined();
    // Anchor is 1st of next month from now — within ~31 days
    expect(opts.billingCycleAnchor!).toBeGreaterThan(before);
    expect(opts.billingCycleAnchor!).toBeLessThanOrEqual(before + 32 * 86400);
  });

  it('rejects free tier', async () => {
    const { app } = createApp();
    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'free' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects unknown tier/mode combo', async () => {
    const { app } = createApp();
    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'unknown-tier', mode: 'default' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 401 for unauthenticated request', async () => {
    mockAuthShouldReject = true;
    const { app } = createApp();
    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'standard' }),
    });

    expect(res.status).toBe(401);
  });

  it('rejects when Stripe is not configured', async () => {
    const { app } = createApp({ STRIPE_SECRET_KEY: undefined } as unknown as Partial<Env>);
    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'standard' }),
    });

    expect(res.status).toBe(400);
  });

  // REQ-SUB-020: Multi-currency pricing
  it('passes detected currency from CF-IPCountry to createCheckoutSession', async () => {
    const { app } = createApp();
    await app.request('/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-IPCountry': 'DE',
      },
      body: JSON.stringify({ tier: 'standard', mode: 'default' }),
    });

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'eur' }),
    );
  });

  it('defaults to USD currency when CF-IPCountry is absent', async () => {
    const { app } = createApp();
    await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'standard', mode: 'default' }),
    });

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'usd' }),
    );
  });

  it('passes CHF for Swiss visitors', async () => {
    const { app } = createApp();
    await app.request('/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-IPCountry': 'CH',
      },
      body: JSON.stringify({ tier: 'standard', mode: 'default' }),
    });

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'chf' }),
    );
  });

  it('passes GBP for UK visitors', async () => {
    const { app } = createApp();
    await app.request('/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-IPCountry': 'GB',
      },
      body: JSON.stringify({ tier: 'standard', mode: 'default' }),
    });

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'gbp' }),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /billing/status
// ---------------------------------------------------------------------------
describe('GET /billing/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthShouldReject = false;
    mockAuthResult.user = { email: 'user@example.com', authenticated: true, role: 'user', accessTier: 'standard', subscriptionTier: 'standard' };
  });

  it('returns billing fields from Stripe for subscribed user', async () => {
    vi.mocked(fetchSubscription).mockResolvedValue({
      subscriptionId: 'sub_123',
      subscriptionItemId: 'si_123',
      customerId: 'cus_123',
      status: 'active',
      tier: 'standard',
      mode: 'default',
      priceId: 'price_std_default',
      billingPeriodEnd: '2026-04-27T00:00:00Z',
      cancelAtPeriodEnd: false,
    });

    const { app, mockKV } = createApp();
    mockKV._set('user:user@example.com', {
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      billingStatus: 'active',
    });

    const res = await app.request('/billing/status');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.stripeCustomerId).toBe('cus_123');
    expect(body.billingStatus).toBe('active');
    expect(body.stripeSubscriptionId).toBe('sub_123');
  });

  it('returns nulls and cleans KV when subscription is gone from Stripe', async () => {
    vi.mocked(fetchSubscription).mockResolvedValue(null);

    const { app, mockKV } = createApp();
    mockKV._set('user:user@example.com', {
      stripeCustomerId: 'cus_gone',
      stripeSubscriptionId: 'sub_gone',
      billingStatus: 'active',
    });

    const res = await app.request('/billing/status');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.stripeCustomerId).toBeNull();
    expect(body.billingStatus).toBeNull();
    expect(body.stripeSubscriptionId).toBeNull();
  });

  it('returns nulls for free user', async () => {
    const { app } = createApp();
    const res = await app.request('/billing/status');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.stripeCustomerId).toBeNull();
    expect(body.billingStatus).toBeNull();
  });

  it('returns 401 for unauthenticated request', async () => {
    mockAuthShouldReject = true;
    const { app } = createApp();
    const res = await app.request('/billing/status');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /public/stripe/webhook
// ---------------------------------------------------------------------------
describe('POST /public/stripe/webhook', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    // Default: fetchSubscription returns a standard-tier active subscription
    vi.mocked(fetchSubscription).mockResolvedValue({
      subscriptionId: 'sub_buyer',
      subscriptionItemId: 'si_buyer_1',
      customerId: 'cus_buyer',
      status: 'active',
      tier: 'standard',
      mode: 'default',
      priceId: 'price_std_default',
      billingPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
      cancelAtPeriodEnd: false,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function generateSignature(body: string, secret: string): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = `${timestamp}.${body}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `t=${timestamp},v1=${hex}`;
  }

  it('rejects missing Stripe-Signature header', async () => {
    const { app } = createApp();
    const res = await app.request('/public/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'evt_1', type: 'test', data: { object: {} } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects bad signature', async () => {
    const { app } = createApp();
    const body = JSON.stringify({ id: 'evt_1', type: 'test', data: { object: {} } });
    const res = await app.request('/public/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': 't=123,v1=badsig',
      },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('handles checkout.session.completed', async () => {
    const secret = 'whsec_test_123';
    const event = {
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          customer_email: 'buyer@example.com',
          customer: 'cus_buyer',
          subscription: 'sub_buyer',
          metadata: { tier: 'standard', mode: 'default', email: 'buyer@example.com' },
        },
      },
    };
    const body = JSON.stringify(event);
    const sig = await generateSignature(body, secret);

    const { app, mockKV } = createApp();
    const res = await app.request('/public/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': sig,
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { received: boolean };
    expect(json.received).toBe(true);

    // Verify user KV was updated
    const userData = await mockKV.get('user:buyer@example.com', 'json') as Record<string, unknown>;
    expect(userData.subscriptionTier).toBe('standard');
    expect(userData.stripeCustomerId).toBe('cus_buyer');
    expect(userData.billingStatus).toBe('active');

    // Verify customer mapping
    const customerEmail = await mockKV.get('stripe-customer:cus_buyer');
    expect(customerEmail).toBe('buyer@example.com');
  });

  it('returns 200 for unknown event types', async () => {
    const secret = 'whsec_test_123';
    const event = {
      id: 'evt_unknown_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123' } },
    };
    const body = JSON.stringify(event);
    const sig = await generateSignature(body, secret);

    const { app } = createApp();
    const res = await app.request('/public/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': sig,
      },
      body,
    });

    expect(res.status).toBe(200);
  });

  it('deduplicates events', async () => {
    const secret = 'whsec_test_123';
    const event = {
      id: 'evt_dedupe_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          customer_email: 'dup@example.com',
          customer: 'cus_dup',
          subscription: 'sub_dup',
          metadata: { tier: 'standard', mode: 'default', email: 'dup@example.com' },
        },
      },
    };
    const body = JSON.stringify(event);
    const sig = await generateSignature(body, secret);

    const { app, mockKV } = createApp();

    // First request
    const res1 = await app.request('/public/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
      body,
    });
    expect(res1.status).toBe(200);

    // Second request with same event ID (regenerate sig for fresh timestamp)
    const sig2 = await generateSignature(body, secret);
    const res2 = await app.request('/public/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig2 },
      body,
    });
    expect(res2.status).toBe(200);

    // KV.put should have been called for dedupe key
    expect(mockKV.put).toHaveBeenCalledWith(
      'stripe:event:evt_dedupe_1',
      'processed',
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
  });

  it('does not require CF Access auth', async () => {
    // Webhook endpoint is under /public/*, no auth mock needed
    // This test verifies we don't get a 401 even without auth headers
    const secret = 'whsec_test_123';
    const event = {
      id: 'evt_noauth_1',
      type: 'invoice.paid',
      data: { object: { customer: 'cus_noauth' } },
    };
    const body = JSON.stringify(event);
    const sig = await generateSignature(body, secret);

    const { app } = createApp();
    const res = await app.request('/public/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
      body,
    });

    expect(res.status).toBe(200);
  });

  it('handles customer.subscription.updated with new price ID', async () => {
    // Override fetchSubscription to return advanced tier (simulating an upgrade)
    vi.mocked(fetchSubscription).mockResolvedValue({
      subscriptionId: 'sub_updated',
      subscriptionItemId: 'si_updated_1',
      customerId: 'cus_upgrader',
      status: 'active',
      tier: 'advanced',
      mode: 'default',
      priceId: 'price_adv_default',
      billingPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
      cancelAtPeriodEnd: false,
    });

    const secret = 'whsec_test_123';
    const event = {
      id: 'evt_sub_updated_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_updated',
          customer: 'cus_upgrader',
        },
      },
    };
    const body = JSON.stringify(event);
    const sig = await generateSignature(body, secret);

    const { app, mockKV } = createApp();
    // Pre-populate customer mapping
    mockKV._set('stripe-customer:cus_upgrader', null);
    await mockKV.put('stripe-customer:cus_upgrader', 'upgrader@example.com');
    mockKV._set('user:upgrader@example.com', {
      subscriptionTier: 'standard',
      stripeCustomerId: 'cus_upgrader',
    });

    const res = await app.request('/public/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
      body,
    });

    expect(res.status).toBe(200);

    const userData = await mockKV.get('user:upgrader@example.com', 'json') as Record<string, unknown>;
    expect(userData.subscriptionTier).toBe('advanced');
    expect(userData.subscribedMode).toBe('default');
    expect(userData.billingStatus).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// POST /billing/portal
// ---------------------------------------------------------------------------
describe('POST /billing/portal / REQ-SUB-016 (Stripe customer portal for cancel/payment-method)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthShouldReject = false;
    mockAuthResult.user = { email: 'user@example.com', authenticated: true, role: 'user', accessTier: 'standard', subscriptionTier: 'standard' };
  });

  it('returns portalUrl for user with stripeCustomerId', async () => {
    const { app, mockKV } = createApp();
    mockKV._set('user:user@example.com', { stripeCustomerId: 'cus_123' });

    const res = await app.request('/billing/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { portalUrl: string };
    expect(body.portalUrl).toBe('https://billing.stripe.com/test');
    expect(createPortalSession).toHaveBeenCalled();
  });

  it('rejects user without stripeCustomerId', async () => {
    const { app } = createApp();

    const res = await app.request('/billing/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(400);
  });

  it('returns 401 for unauthenticated request', async () => {
    mockAuthShouldReject = true;
    const { app } = createApp();

    const res = await app.request('/billing/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(401);
  });

  it('rejects when Stripe is not configured', async () => {
    const { app, mockKV } = createApp({ STRIPE_SECRET_KEY: undefined } as unknown as Partial<Env>);
    mockKV._set('user:user@example.com', { stripeCustomerId: 'cus_123' });

    const res = await app.request('/billing/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(400);
  });

  // REQ-SUB-016 AC6: portal endpoint is rate-limited 5/min per user.
  // Exhaust the 5-slot bucket and assert the 6th request 429s.
  it('REQ-SUB-016 AC6: portal endpoint is rate-limited to 5 requests per minute per user', async () => {
    const { app, mockKV } = createApp();
    mockKV._set('user:user@example.com', { stripeCustomerId: 'cus_123' });

    for (let i = 0; i < 5; i++) {
      const ok = await app.request('/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(ok.status, `portal call ${i + 1} should succeed`).toBe(200);
    }

    const blocked = await app.request('/billing/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(blocked.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// POST /billing/switch — deep-link portal for plan changes
// ---------------------------------------------------------------------------
describe('POST /billing/switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthShouldReject = false;
    mockAuthResult.user = { email: 'user@example.com', authenticated: true, role: 'user', accessTier: 'standard', subscriptionTier: 'standard' };
  });

  it('returns portalUrl for active subscriber switching plans', async () => {
    const { app, mockKV } = createApp();
    mockKV._set('user:user@example.com', {
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
      billingStatus: 'active',
    });

    const res = await app.request('/billing/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'advanced', mode: 'default' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { portalUrl: string };
    expect(body.portalUrl).toBe('https://billing.stripe.com/switch');
    expect(createSwitchPortalSession).toHaveBeenCalled();
  });

  it('rejects user without stripeSubscriptionId', async () => {
    const { app, mockKV } = createApp();
    mockKV._set('user:user@example.com', { stripeCustomerId: 'cus_123' });

    const res = await app.request('/billing/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'advanced', mode: 'default' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects without tier', async () => {
    const { app, mockKV } = createApp();
    mockKV._set('user:user@example.com', { stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_123' });

    const res = await app.request('/billing/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('rejects free tier switch', async () => {
    const { app, mockKV } = createApp();
    mockKV._set('user:user@example.com', { stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_123' });

    const res = await app.request('/billing/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'free' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 401 for unauthenticated request', async () => {
    mockAuthShouldReject = true;
    const { app } = createApp();

    const res = await app.request('/billing/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'advanced' }),
    });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// CF-024: Missing webhook handler tests
// ---------------------------------------------------------------------------
describe('Webhook handlers — CF-024', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function generateSignature(body: string, secret: string): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = `${timestamp}.${body}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(signatureBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `t=${timestamp},v1=${hex}`;
  }

  function seedCustomer(mockKV: ReturnType<typeof createMockKV>, customerId: string, email: string) {
    mockKV._set(`stripe-customer:${customerId}`, null);
    mockKV._store.set(`stripe-customer:${customerId}`, email);
    mockKV._set(`user:${email}`, { subscriptionTier: 'standard', stripeCustomerId: customerId, billingStatus: 'active' });
  }

  it('customer.subscription.deleted sets billingStatus to canceled', async () => {
    const secret = 'whsec_test_123';
    const event = {
      id: 'evt_del_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_del', customer: 'cus_del' } },
    };
    const body = JSON.stringify(event);
    const sig = await generateSignature(body, secret);
    const { app, mockKV } = createApp();
    seedCustomer(mockKV, 'cus_del', 'del@example.com');

    const res = await app.request('/public/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
      body,
    });
    expect(res.status).toBe(200);

    const userData = await mockKV.get('user:del@example.com', 'json') as Record<string, unknown>;
    expect(userData.billingStatus).toBe('canceled');
  });

  it('unhandled event types return 200 (ack to Stripe)', async () => {
    const secret = 'whsec_test_123';
    const event = {
      id: 'evt_unhandled_1',
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_unhandled' } },
    };
    const body = JSON.stringify(event);
    const sig = await generateSignature(body, secret);
    const { app } = createApp();

    const res = await app.request('/public/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
      body,
    });
    expect(res.status).toBe(200);
  });
});
