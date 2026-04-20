import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getStripePriceId,
  resolveTierFromPriceId,
  isStripeConfigured,
  verifyWebhookSignature,
  createCheckoutSession,
  createPortalSession,
  endTrialNow,
  parseStripeEvent,
  fetchSubscription,
} from '../../lib/stripe';
import type { SubscriptionTierConfig } from '../../types';

/** Helper: build a minimal tier config with Stripe price IDs for testing */
function makeTiers(): SubscriptionTierConfig[] {
  return [
    { id: 'free', displayName: 'Free', monthlySeconds: 14400, maxSessions: 1, sessionModes: ['default'], canLogin: true, order: 2, isDefault: false, priceMonthly: 0, trialQuotaHours: 0, description: '' },
    { id: 'standard', displayName: 'Starter', monthlySeconds: 144000, maxSessions: 1, sessionModes: ['default', 'advanced'], canLogin: true, order: 4, isDefault: true, priceMonthly: null, trialQuotaHours: 40, description: '', stripePriceId: 'price_std_default', stripeAdvancedPriceId: 'price_std_advanced' },
    { id: 'advanced', displayName: 'Advanced', monthlySeconds: 288000, maxSessions: 2, sessionModes: ['default', 'advanced'], canLogin: true, order: 5, isDefault: false, priceMonthly: null, trialQuotaHours: 80, description: '', stripePriceId: 'price_adv_default', stripeAdvancedPriceId: 'price_adv_advanced' },
    { id: 'max', displayName: 'Max', monthlySeconds: 576000, maxSessions: 3, sessionModes: ['default', 'advanced'], canLogin: true, order: 6, isDefault: false, priceMonthly: null, trialQuotaHours: 160, description: '', stripePriceId: 'price_max_default', stripeAdvancedPriceId: 'price_max_advanced' },
  ];
}

describe('getStripePriceId', () => {
  const tiers = makeTiers();

  it('returns correct price ID for standard/default', () => {
    expect(getStripePriceId('standard', 'default', tiers)).toBe('price_std_default');
  });

  it('returns correct price ID for standard/advanced', () => {
    expect(getStripePriceId('standard', 'advanced', tiers)).toBe('price_std_advanced');
  });

  it('returns correct price ID for advanced/default', () => {
    expect(getStripePriceId('advanced', 'default', tiers)).toBe('price_adv_default');
  });

  it('returns correct price ID for max/advanced', () => {
    expect(getStripePriceId('max', 'advanced', tiers)).toBe('price_max_advanced');
  });

  it('returns null for free tier (no stripePriceId)', () => {
    expect(getStripePriceId('free', 'default', tiers)).toBeNull();
  });

  it('returns null for unknown tier', () => {
    expect(getStripePriceId('super-mega', 'default', tiers)).toBeNull();
  });

  it('returns null for unknown mode when tier has no advanced price', () => {
    expect(getStripePriceId('free', 'advanced', tiers)).toBeNull();
  });
});

describe('resolveTierFromPriceId', () => {
  const tiers = makeTiers();

  it('resolves standard/default from price ID', () => {
    expect(resolveTierFromPriceId('price_std_default', tiers)).toEqual({ tier: 'standard', mode: 'default' });
  });

  it('resolves max/advanced from price ID', () => {
    expect(resolveTierFromPriceId('price_max_advanced', tiers)).toEqual({ tier: 'max', mode: 'advanced' });
  });

  it('returns null for unknown price ID', () => {
    expect(resolveTierFromPriceId('price_unknown_123', tiers)).toBeNull();
  });

  it('resolves advanced/advanced from price ID', () => {
    expect(resolveTierFromPriceId('price_adv_advanced', tiers)).toEqual({ tier: 'advanced', mode: 'advanced' });
  });
});

describe('isStripeConfigured', () => {
  it('returns true when STRIPE_SECRET_KEY is set', () => {
    expect(isStripeConfigured({ STRIPE_SECRET_KEY: 'sk_test_123' })).toBe(true);
  });

  it('returns false when STRIPE_SECRET_KEY is undefined', () => {
    expect(isStripeConfigured({ STRIPE_SECRET_KEY: undefined })).toBe(false);
  });

  it('returns false when STRIPE_SECRET_KEY is empty string', () => {
    expect(isStripeConfigured({ STRIPE_SECRET_KEY: '' })).toBe(false);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test_secret';

  async function generateSignature(body: string, timestampOverride?: number): Promise<string> {
    const timestamp = timestampOverride ?? Math.floor(Date.now() / 1000);
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

  it('accepts valid signature', async () => {
    const body = '{"test":"data"}';
    const sig = await generateSignature(body);
    const result = await verifyWebhookSignature(body, sig, secret);
    expect(result).toBe(true);
  });

  it('rejects invalid signature', async () => {
    const body = '{"test":"data"}';
    const sig = `t=${Math.floor(Date.now() / 1000)},v1=invalidsignaturehex`;
    const result = await verifyWebhookSignature(body, sig, secret);
    expect(result).toBe(false);
  });

  it('rejects expired timestamp', async () => {
    const body = '{"test":"data"}';
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const sig = await generateSignature(body, oldTimestamp);
    const result = await verifyWebhookSignature(body, sig, secret);
    expect(result).toBe(false);
  });

  it('rejects missing timestamp', async () => {
    const result = await verifyWebhookSignature('body', 'v1=abc', secret);
    expect(result).toBe(false);
  });

  it('rejects missing v1 signature', async () => {
    const result = await verifyWebhookSignature('body', `t=${Math.floor(Date.now() / 1000)}`, secret);
    expect(result).toBe(false);
  });
});

describe('createCheckoutSession', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends correct Stripe API call and returns id + url', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'cs_test_123', url: 'https://checkout.stripe.com/test' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const result = await createCheckoutSession({
      priceId: 'price_test_123',
      customerEmail: 'user@example.com',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      secretKey: 'sk_test_key',
    });

    expect(result).toEqual({ id: 'cs_test_123', url: 'https://checkout.stripe.com/test' });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(fetchCall[1].method).toBe('POST');
    expect(fetchCall[1].headers['Authorization']).toBe('Bearer sk_test_key');
  });

  it('throws on Stripe API error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid price' } }), { status: 400 }),
    ) as typeof globalThis.fetch;

    await expect(createCheckoutSession({
      priceId: 'price_invalid',
      customerEmail: 'user@example.com',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      secretKey: 'sk_test_key',
    })).rejects.toThrow('Invalid price');
  });
});

describe('parseStripeEvent', () => {
  it('parses valid event', () => {
    const raw = JSON.stringify({
      id: 'evt_123',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_123' } },
    });
    const event = parseStripeEvent(raw);
    expect(event.id).toBe('evt_123');
    expect(event.type).toBe('checkout.session.completed');
    expect(event.data.object.customer).toBe('cus_123');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseStripeEvent('not json')).toThrow();
  });

  it('throws on missing required fields', () => {
    expect(() => parseStripeEvent(JSON.stringify({ id: 'evt_123' }))).toThrow('Invalid Stripe event payload');
  });
});

describe('createPortalSession', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends correct Stripe API call and returns id + url', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'bps_test_123', url: 'https://billing.stripe.com/session/test' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const result = await createPortalSession({
      customerId: 'cus_test_456',
      returnUrl: 'https://example.com/subscribe',
      secretKey: 'sk_test_key',
    });

    expect(result).toEqual({ id: 'bps_test_123', url: 'https://billing.stripe.com/session/test' });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(fetchCall[1].headers['Authorization']).toBe('Bearer sk_test_key');
  });

  it('throws on Stripe API error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'No such customer' } }), { status: 400 }),
    ) as typeof globalThis.fetch;

    await expect(createPortalSession({
      customerId: 'cus_invalid',
      returnUrl: 'https://example.com/subscribe',
      secretKey: 'sk_test_key',
    })).rejects.toThrow('No such customer');
  });
});

describe('endTrialNow', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls Stripe API to end trial immediately', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'sub_123', status: 'active', trial_end: null }), { status: 200 }),
    ) as typeof globalThis.fetch;

    await endTrialNow('sub_123', 'sk_test_key');

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.stripe.com/v1/subscriptions/sub_123');
    expect(fetchCall[1].method).toBe('POST');
    expect(fetchCall[1].body).toContain('trial_end=now');
  });

  it('throws on Stripe API error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'No such subscription' } }), { status: 404 }),
    ) as typeof globalThis.fetch;

    await expect(endTrialNow('sub_invalid', 'sk_test_key')).rejects.toThrow('No such subscription');
  });
});

describe('createCheckoutSession with trial', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('includes trial_period_days when trialDays is set', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'cs_trial', url: 'https://checkout.stripe.com/trial' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    await createCheckoutSession({
      priceId: 'price_test',
      customerEmail: 'trial@example.com',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      secretKey: 'sk_test_key',
      trialDays: 30,
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;
    expect(body).toContain('subscription_data%5Btrial_period_days%5D=30');
  });

  it('does NOT include trial_period_days when trialDays is undefined', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'cs_notrial', url: 'https://checkout.stripe.com/notrial' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    await createCheckoutSession({
      priceId: 'price_test',
      customerEmail: 'notrial@example.com',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      secretKey: 'sk_test_key',
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;
    expect(body).not.toContain('trial_period_days');
  });
});

describe('createCheckoutSession with billing_cycle_anchor', () => {
  // Implements REQ-SUB-021
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('includes billing_cycle_anchor when billingCycleAnchor is set', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'cs_anchor', url: 'https://checkout.stripe.com/anchor' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    await createCheckoutSession({
      priceId: 'price_test',
      customerEmail: 'anchor@example.com',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      secretKey: 'sk_test_key',
      billingCycleAnchor: 1777593600,
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;
    expect(body).toContain('subscription_data%5Bbilling_cycle_anchor%5D=1777593600');
  });

  it('does NOT include billing_cycle_anchor when omitted', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'cs_noanchor', url: 'https://checkout.stripe.com/noanchor' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    await createCheckoutSession({
      priceId: 'price_test',
      customerEmail: 'noanchor@example.com',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      secretKey: 'sk_test_key',
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;
    expect(body).not.toContain('billing_cycle_anchor');
  });
});

// ---------------------------------------------------------------------------
// fetchSubscription — Signal and Sync: fetch subscription snapshot from Stripe API
// ---------------------------------------------------------------------------
describe('fetchSubscription', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns subscription snapshot with tier/mode from price.metadata', async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 2_592_000; // +30 days
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        id: 'sub_123',
        customer: 'cus_456',
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: periodEnd,
        items: {
          data: [{
            id: 'si_item_1',
            price: {
              id: 'price_abc',
              metadata: { tier: 'advanced', mode: 'default' },
            },
          }],
        },
      }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const snapshot = await fetchSubscription('sub_123', 'sk_test_key');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.subscriptionId).toBe('sub_123');
    expect(snapshot!.subscriptionItemId).toBe('si_item_1');
    expect(snapshot!.customerId).toBe('cus_456');
    expect(snapshot!.status).toBe('active');
    expect(snapshot!.tier).toBe('advanced');
    expect(snapshot!.mode).toBe('default');
    expect(snapshot!.priceId).toBe('price_abc');
    expect(snapshot!.cancelAtPeriodEnd).toBe(false);
    expect(snapshot!.billingPeriodEnd).toBe(new Date(periodEnd * 1000).toISOString());

    // Verify correct API URL with expand param
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toContain('/v1/subscriptions/sub_123');
    expect(fetchCall[0]).toContain('expand');
  });

  it('returns null on 404 (subscription not found)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'No such subscription' } }), { status: 404 }),
    ) as typeof globalThis.fetch;

    const snapshot = await fetchSubscription('sub_gone', 'sk_test_key');
    expect(snapshot).toBeNull();
  });

  it('throws on network error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Network timeout');
    }) as typeof globalThis.fetch;

    await expect(fetchSubscription('sub_err', 'sk_test_key')).rejects.toThrow('Network timeout');
  });

  it('throws on non-404 API error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Rate limited' } }), { status: 429 }),
    ) as typeof globalThis.fetch;

    await expect(fetchSubscription('sub_rate', 'sk_test_key')).rejects.toThrow('Rate limited');
  });

  it('handles missing price metadata (tier/mode = null)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        id: 'sub_no_meta',
        customer: 'cus_789',
        status: 'active',
        cancel_at_period_end: true,
        current_period_end: 1700000000,
        items: {
          data: [{
            id: 'si_no_meta',
            price: {
              id: 'price_no_meta',
              metadata: {},
            },
          }],
        },
      }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const snapshot = await fetchSubscription('sub_no_meta', 'sk_test_key');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.tier).toBeNull();
    expect(snapshot!.mode).toBeNull();
    expect(snapshot!.priceId).toBe('price_no_meta');
    expect(snapshot!.cancelAtPeriodEnd).toBe(true);
  });

  it('extracts billingPeriodEnd from current_period_end', async () => {
    const periodEnd = 1700000000;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        id: 'sub_period',
        customer: 'cus_period',
        status: 'trialing',
        cancel_at_period_end: false,
        current_period_end: periodEnd,
        items: {
          data: [{
            id: 'si_period',
            price: {
              id: 'price_period',
              metadata: { tier: 'standard', mode: 'advanced' },
            },
          }],
        },
      }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const snapshot = await fetchSubscription('sub_period', 'sk_test_key');
    expect(snapshot!.billingPeriodEnd).toBe(new Date(periodEnd * 1000).toISOString());
    expect(snapshot!.status).toBe('trialing');
  });

  it('handles subscription with no items gracefully', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        id: 'sub_empty',
        customer: 'cus_empty',
        status: 'canceled',
        cancel_at_period_end: false,
        current_period_end: null,
        items: { data: [] },
      }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const snapshot = await fetchSubscription('sub_empty', 'sk_test_key');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.tier).toBeNull();
    expect(snapshot!.mode).toBeNull();
    expect(snapshot!.priceId).toBeNull();
    expect(snapshot!.billingPeriodEnd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REQ-SUB-020: Multi-currency pricing
// ---------------------------------------------------------------------------

describe('createCheckoutSession with currency', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('passes currency as top-level param when provided', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'cs_eur', url: 'https://checkout.stripe.com/eur' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    await createCheckoutSession({
      priceId: 'price_test_123',
      customerEmail: 'user@example.com',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      secretKey: 'sk_test_key',
      currency: 'eur',
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;
    expect(body).toContain('currency=eur');
  });

  it('does NOT include currency param when not provided', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'cs_default', url: 'https://checkout.stripe.com/default' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    await createCheckoutSession({
      priceId: 'price_test_123',
      customerEmail: 'user@example.com',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      secretKey: 'sk_test_key',
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;
    expect(body).not.toContain('currency=');
  });
});

describe('getStripePrices with currency', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Clear the module-level price cache between tests
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('expands currency_options when fetching prices', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        unit_amount: 2400,
        currency: 'chf',
        currency_options: {
          usd: { unit_amount: 2400 },
          eur: { unit_amount: 2400 },
          gbp: { unit_amount: 2400 },
        },
      }), { status: 200 }),
    ) as typeof globalThis.fetch;

    // Re-import to get fresh cache
    const { getStripePrices } = await import('../../lib/stripe');
    await getStripePrices(['price_test'], 'sk_test_key');

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toContain('expand');
    expect(fetchCall[0]).toContain('currency_options');
  });

  it('returns base currency amount when no currency specified', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        unit_amount: 2400,
        currency: 'chf',
        currency_options: {
          usd: { unit_amount: 2400 },
          eur: { unit_amount: 2400 },
        },
      }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const { getStripePrices } = await import('../../lib/stripe');
    const result = await getStripePrices(['price_test'], 'sk_test_key');

    const price = result.get('price_test');
    expect(price).toBeDefined();
    expect(price!.currency).toBe('CHF');
    expect(price!.amount).toBe(2400);
  });

  it('returns currency_options amount when currency is specified', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        unit_amount: 2400,
        currency: 'chf',
        currency_options: {
          usd: { unit_amount: 2400 },
          eur: { unit_amount: 2400 },
          gbp: { unit_amount: 2400 },
        },
      }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const { getStripePrices } = await import('../../lib/stripe');
    const result = await getStripePrices(['price_test'], 'sk_test_key', 'eur');

    const price = result.get('price_test');
    expect(price).toBeDefined();
    expect(price!.currency).toBe('EUR');
    expect(price!.amount).toBe(2400);
  });

  it('falls back to base currency when requested currency not in options', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        unit_amount: 2400,
        currency: 'chf',
        currency_options: {
          usd: { unit_amount: 2400 },
        },
      }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const { getStripePrices } = await import('../../lib/stripe');
    const result = await getStripePrices(['price_test'], 'sk_test_key', 'jpy');

    const price = result.get('price_test');
    expect(price).toBeDefined();
    expect(price!.currency).toBe('CHF');
    expect(price!.amount).toBe(2400);
  });
});
