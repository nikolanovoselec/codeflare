/**
 * Stripe webhook handler tests — CF-021 findings.
 *
 * Tests the five security/correctness findings:
 *   1. handleInvoicePaid updates KV with billingStatus active and billingPeriodEnd
 *   2. handleSubscriptionDeleted resets subscriptionTier and accessTier to free (CF-004)
 *   3. handlePaymentFailed resets subscriptionTier and accessTier to free (CF-004)
 *   4. handleCheckoutCompleted prefers metadata.email over customer_email (CF-011)
 *   5. handleCheckoutCompleted cross-checks metadata.tier against price (CF-003)
 *
 * Stripe verification is mocked so tests focus on handler logic only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

// ---------------------------------------------------------------------------
// Mock stripe lib — verification and parsing stubbed out so tests are not
// coupled to HMAC timing or real price-map data unless the test needs it.
// ---------------------------------------------------------------------------
vi.mock('../../lib/stripe', () => ({
  verifyWebhookSignature: vi.fn(async () => true),
  parseStripeEvent: vi.fn((body: string) => JSON.parse(body)),
  resolveTierFromPriceId: vi.fn(() => null),
  isStripeConfigured: vi.fn(() => true),
}));

// Import mocked functions after vi.mock declaration so we can override per-test
import {
  verifyWebhookSignature,
  parseStripeEvent,
  resolveTierFromPriceId,
  isStripeConfigured,
} from '../../lib/stripe';

// Import route under test after mocks are registered
import stripeWebhookRoute from '../../routes/stripe-webhook';

// ---------------------------------------------------------------------------
// Shared state — reset in beforeEach
// ---------------------------------------------------------------------------
let mockKV: ReturnType<typeof createMockKV>;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.env = {
      KV: mockKV as unknown as KVNamespace,
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_123',
    } as Env;
    return next();
  });
  app.route('/', stripeWebhookRoute);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildEvent(type: string, data: Record<string, unknown>) {
  return JSON.stringify({ id: `evt_${Date.now()}`, type, data: { object: data } });
}

function postWebhook(app: ReturnType<typeof createApp>, body: string) {
  return app.request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=123,v1=abc' },
    body,
  });
}

/** Seed a customer → email mapping and an initial user record in KV. */
function seedCustomer(customerId: string, email: string, extraFields: Record<string, unknown> = {}) {
  mockKV._store.set(`stripe-customer:${customerId}`, email);
  mockKV._set(`user:${email}`, {
    subscriptionTier: 'standard',
    accessTier: 'standard',
    stripeCustomerId: customerId,
    billingStatus: 'active',
    ...extraFields,
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  mockKV = createMockKV();

  // Restore default mock behaviour for every test
  vi.mocked(verifyWebhookSignature).mockResolvedValue(true);
  vi.mocked(parseStripeEvent).mockImplementation((body: string) => JSON.parse(body));
  vi.mocked(resolveTierFromPriceId).mockReturnValue(null);
  vi.mocked(isStripeConfigured).mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// CF-021 finding 1: invoice.paid updates billingStatus to active + billingPeriodEnd
// ---------------------------------------------------------------------------
describe('handleInvoicePaid — CF-021 finding 1', () => {
  it('sets billingStatus to active and writes billingPeriodEnd from invoice line period', async () => {
    seedCustomer('cus_inv_1', 'inv@example.com');

    const periodEnd = Math.floor(Date.now() / 1000) + 2_592_000; // +30 days
    const body = buildEvent('invoice.paid', {
      customer: 'cus_inv_1',
      subscription: 'sub_inv_1',
      lines: {
        data: [{ period: { end: periodEnd } }],
      },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);
    const json = await res.json() as { received: boolean };
    expect(json.received).toBe(true);

    const user = await mockKV.get('user:inv@example.com', 'json') as Record<string, unknown>;
    expect(user.billingStatus).toBe('active');
    expect(user.billingPeriodEnd).toBeDefined();
    // billingPeriodEnd should be an ISO string representing the period end timestamp
    expect(new Date(user.billingPeriodEnd as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('sets billingStatus to active even when invoice has no line period', async () => {
    seedCustomer('cus_inv_2', 'inv2@example.com');

    const body = buildEvent('invoice.paid', {
      customer: 'cus_inv_2',
      subscription: 'sub_inv_2',
      // no lines field
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:inv2@example.com', 'json') as Record<string, unknown>;
    expect(user.billingStatus).toBe('active');
    // No period end provided — field should not be set (or remain as-is from seed)
    expect(user.billingPeriodEnd).toBeUndefined();
  });

  it('updates stripeSubscriptionId when invoice carries a subscription ID', async () => {
    seedCustomer('cus_inv_3', 'inv3@example.com');

    const body = buildEvent('invoice.paid', {
      customer: 'cus_inv_3',
      subscription: 'sub_new_456',
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:inv3@example.com', 'json') as Record<string, unknown>;
    expect(user.stripeSubscriptionId).toBe('sub_new_456');
    expect(user.billingStatus).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// CF-021 finding 2: customer.subscription.deleted resets tiers to free (CF-004)
// ---------------------------------------------------------------------------
describe('handleSubscriptionDeleted — CF-021 finding 2 (CF-004)', () => {
  it('resets subscriptionTier and accessTier to free and sets billingStatus to canceled', async () => {
    seedCustomer('cus_del_1', 'del@example.com', { subscriptionTier: 'advanced', accessTier: 'advanced' });

    const body = buildEvent('customer.subscription.deleted', {
      id: 'sub_del_1',
      customer: 'cus_del_1',
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:del@example.com', 'json') as Record<string, unknown>;
    expect(user.subscriptionTier).toBe('free');
    expect(user.accessTier).toBe('free');
    expect(user.billingStatus).toBe('canceled');
  });

  it('resets a max-tier user to free on subscription deletion', async () => {
    seedCustomer('cus_del_2', 'max_del@example.com', { subscriptionTier: 'max', accessTier: 'max' });

    const body = buildEvent('customer.subscription.deleted', {
      id: 'sub_del_2',
      customer: 'cus_del_2',
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:max_del@example.com', 'json') as Record<string, unknown>;
    expect(user.subscriptionTier).toBe('free');
    expect(user.accessTier).toBe('free');
  });

  it('returns 200 without error when customer mapping is absent', async () => {
    // No KV mapping and the Stripe API fallback will also fail (no real network)
    // We stub fetch to simulate no customer found
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'No such customer' } }), { status: 404 }),
    ) as typeof globalThis.fetch;

    const body = buildEvent('customer.subscription.deleted', {
      id: 'sub_del_nomatch',
      customer: 'cus_unknown_del',
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    globalThis.fetch = originalFetch;
  });
});

// ---------------------------------------------------------------------------
// CF-021 finding 3: invoice.payment_failed resets tiers to free (CF-004)
// ---------------------------------------------------------------------------
describe('handlePaymentFailed — CF-021 finding 3 (CF-004)', () => {
  it('resets subscriptionTier and accessTier to free and sets billingStatus to past_due', async () => {
    seedCustomer('cus_pf_1', 'pf@example.com', { subscriptionTier: 'standard', accessTier: 'standard' });

    const body = buildEvent('invoice.payment_failed', {
      customer: 'cus_pf_1',
      subscription: 'sub_pf_1',
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:pf@example.com', 'json') as Record<string, unknown>;
    expect(user.subscriptionTier).toBe('free');
    expect(user.accessTier).toBe('free');
    expect(user.billingStatus).toBe('past_due');
  });

  it('resets an advanced-tier user to free on payment failure', async () => {
    seedCustomer('cus_pf_2', 'pf_adv@example.com', { subscriptionTier: 'advanced', accessTier: 'advanced' });

    const body = buildEvent('invoice.payment_failed', {
      customer: 'cus_pf_2',
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:pf_adv@example.com', 'json') as Record<string, unknown>;
    expect(user.subscriptionTier).toBe('free');
    expect(user.accessTier).toBe('free');
    expect(user.billingStatus).toBe('past_due');
  });

  it('returns 200 without error when customer mapping is absent', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'No such customer' } }), { status: 404 }),
    ) as typeof globalThis.fetch;

    const body = buildEvent('invoice.payment_failed', {
      customer: 'cus_unknown_pf',
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    globalThis.fetch = originalFetch;
  });
});

// ---------------------------------------------------------------------------
// CF-021 finding 4: handleCheckoutCompleted prefers metadata.email (CF-011)
// ---------------------------------------------------------------------------
describe('handleCheckoutCompleted — CF-021 finding 4 (CF-011)', () => {
  it('uses metadata.email when both metadata.email and customer_email are present', async () => {
    const body = buildEvent('checkout.session.completed', {
      id: 'cs_meta_email',
      customer: 'cus_meta_1',
      subscription: 'sub_meta_1',
      // customer_email is what the Stripe form shows — untrusted
      customer_email: 'form@example.com',
      metadata: {
        // metadata.email comes from CF Access — trusted
        email: 'verified@example.com',
        tier: 'standard',
        mode: 'default',
      },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    // User record should be keyed on the metadata email, not the form email
    const verifiedUser = await mockKV.get('user:verified@example.com', 'json') as Record<string, unknown> | null;
    const formUser = await mockKV.get('user:form@example.com', 'json') as Record<string, unknown> | null;

    expect(verifiedUser).not.toBeNull();
    expect(verifiedUser?.subscriptionTier).toBe('standard');
    expect(verifiedUser?.billingStatus).toBe('active');

    // The form email must not have received the subscription update
    expect(formUser).toBeNull();
  });

  it('falls back to customer_email when metadata.email is absent', async () => {
    const body = buildEvent('checkout.session.completed', {
      id: 'cs_fallback_email',
      customer: 'cus_fallback',
      subscription: 'sub_fallback',
      customer_email: 'fallback@example.com',
      metadata: {
        // No email key — missing
        tier: 'standard',
        mode: 'default',
      },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:fallback@example.com', 'json') as Record<string, unknown> | null;
    expect(user).not.toBeNull();
    expect(user?.subscriptionTier).toBe('standard');
  });

  it('stores customer mapping under the metadata.email address', async () => {
    const body = buildEvent('checkout.session.completed', {
      id: 'cs_customer_map',
      customer: 'cus_map_1',
      subscription: 'sub_map_1',
      customer_email: 'form2@example.com',
      metadata: {
        email: 'real@example.com',
        tier: 'standard',
        mode: 'default',
      },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    // Customer mapping should point to the metadata email
    const mappedEmail = await mockKV.get('stripe-customer:cus_map_1');
    expect(mappedEmail).toBe('real@example.com');
  });
});

// ---------------------------------------------------------------------------
// CF-021 finding 5: handleCheckoutCompleted cross-checks metadata.tier vs price (CF-003)
// ---------------------------------------------------------------------------
describe('handleCheckoutCompleted — CF-021 finding 5 (CF-003)', () => {
  it('uses metadata.tier when it matches the resolved price tier', async () => {
    // resolveTierFromPriceId returns 'standard' for the given price — matches metadata
    vi.mocked(resolveTierFromPriceId).mockReturnValue({ tier: 'standard', mode: 'default' });

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_match_1',
      customer: 'cus_match_1',
      subscription: 'sub_match_1',
      customer_email: 'match@example.com',
      metadata: { email: 'match@example.com', tier: 'standard', mode: 'default' },
      line_items: {
        data: [{ price: { id: 'price_standard_default' } }],
      },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:match@example.com', 'json') as Record<string, unknown>;
    expect(user.subscriptionTier).toBe('standard');
    expect(user.billingStatus).toBe('active');
  });

  it('price tier wins when metadata.tier diverges from the resolved price tier (CF-003)', async () => {
    // Customer paid for 'standard' but metadata claimed 'advanced'
    vi.mocked(resolveTierFromPriceId).mockReturnValue({ tier: 'standard', mode: 'default' });

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_mismatch_1',
      customer: 'cus_mismatch_1',
      subscription: 'sub_mismatch_1',
      customer_email: 'mismatch@example.com',
      metadata: {
        email: 'mismatch@example.com',
        // metadata says advanced — but the price resolves to standard
        tier: 'advanced',
        mode: 'default',
      },
      line_items: {
        data: [{ price: { id: 'price_standard_default' } }],
      },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:mismatch@example.com', 'json') as Record<string, unknown>;
    // Price wins — user must be granted standard, not the inflated advanced tier
    expect(user.subscriptionTier).toBe('standard');
    expect(user.billingStatus).toBe('active');
  });

  it('resolves tier from price when metadata.tier is missing and line_items carries a known price', async () => {
    // No metadata tier — fall back to price resolution
    vi.mocked(resolveTierFromPriceId).mockReturnValue({ tier: 'max', mode: 'default' });

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_notier_1',
      customer: 'cus_notier_1',
      subscription: 'sub_notier_1',
      customer_email: 'notier@example.com',
      metadata: {
        email: 'notier@example.com',
        // tier is intentionally absent
        mode: 'default',
      },
      line_items: {
        data: [{ price: { id: 'price_max_default' } }],
      },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:notier@example.com', 'json') as Record<string, unknown>;
    expect(user.subscriptionTier).toBe('max');
  });

  it('returns 200 and skips KV write when tier cannot be resolved from metadata or price', async () => {
    // metadata.tier is absent and price resolution also fails
    vi.mocked(resolveTierFromPriceId).mockReturnValue(null);

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_noresolution_1',
      customer: 'cus_noresolution_1',
      subscription: 'sub_noresolution_1',
      customer_email: 'noresolution@example.com',
      metadata: {
        email: 'noresolution@example.com',
        // no tier, no resolvable price
      },
      line_items: {
        data: [{ price: { id: 'price_unknown_xyz' } }],
      },
    });

    const res = await postWebhook(createApp(), body);
    // Handler returns early — webhook still acks 200 to prevent Stripe retries
    expect(res.status).toBe(200);

    // No user record should have been written
    const user = await mockKV.get('user:noresolution@example.com', 'json');
    expect(user).toBeNull();
  });
});
