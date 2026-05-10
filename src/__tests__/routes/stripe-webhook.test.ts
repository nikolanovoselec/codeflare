/**
 * Stripe webhook handler tests — Signal and Sync pattern.
 *
 * Tests the three webhook handlers:
 *   1. checkout.session.completed — maps email→customer, writes checkout fields, calls syncSubscriptionState
 *   2. customer.subscription.updated — delegates to syncSubscriptionState
 *   3. customer.subscription.deleted — writes canceled/free directly (CF-004)
 *
 * Also tests: syncSubscriptionState integration through webhook handlers.
 *
 * Stripe verification and fetchSubscription are mocked so tests focus on handler logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

// ---------------------------------------------------------------------------
// Mock stripe lib
// ---------------------------------------------------------------------------
vi.mock('../../lib/stripe', () => ({
  verifyWebhookSignature: vi.fn(async () => true),
  parseStripeEvent: vi.fn((body: string) => JSON.parse(body)),
  isStripeConfigured: vi.fn(() => true),
  fetchSubscription: vi.fn(async () => null),
}));

// Mock r2-seed, r2-config, email, access-policy for auto-recreate + admin notification
const { mockReconcileAgentConfigs, mockSendAdminNotification, mockSendSubscriptionEmail } = vi.hoisted(() => ({
  mockReconcileAgentConfigs: vi.fn(async () => ({ written: [], skipped: [], deleted: [], warnings: [] })),
  mockSendAdminNotification: vi.fn(async () => true),
  mockSendSubscriptionEmail: vi.fn(async () => true),
}));
vi.mock('../../lib/r2-seed', () => ({ reconcileAgentConfigs: mockReconcileAgentConfigs }));
vi.mock('../../lib/r2-config', () => ({ getR2Config: vi.fn(async () => ({ accountId: 'test-account', endpoint: 'https://r2.test' })) }));
vi.mock('../../lib/email', () => ({ sendSubscriptionAdminNotification: mockSendAdminNotification, sendSubscriptionEmail: mockSendSubscriptionEmail }));
vi.mock('../../lib/access-policy', () => ({ getAdminEmails: vi.fn(async () => ['admin@example.com']) }));
vi.mock('../../lib/kv-keys', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/kv-keys')>()), getBaseUrl: vi.fn(async () => 'https://test.codeflare.ch') }));

import {
  verifyWebhookSignature,
  parseStripeEvent,
  isStripeConfigured,
  fetchSubscription,
} from '../../lib/stripe';

import stripeWebhookRoute from '../../routes/stripe-webhook';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
let mockKV: ReturnType<typeof createMockKV>;

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

/** Create a mock fetchSubscription return value */
function mockSubscriptionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionId: 'sub_sync_1',
    subscriptionItemId: 'si_sync_1',
    customerId: 'cus_sync_1',
    status: 'active',
    tier: 'standard',
    mode: 'default',
    priceId: 'price_std_default',
    billingPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  mockKV = createMockKV();

  vi.mocked(verifyWebhookSignature).mockResolvedValue(true);
  vi.mocked(parseStripeEvent).mockImplementation((body: string) => JSON.parse(body));
  vi.mocked(isStripeConfigured).mockReturnValue(true);
  vi.mocked(fetchSubscription).mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// checkout.session.completed — CF-011: email preference, CF-023: existing sub check
// ---------------------------------------------------------------------------
describe('handleCheckoutCompleted', () => {
  it('uses metadata.email when both metadata.email and customer_email are present', async () => {
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_meta_1', subscriptionId: 'sub_meta_1',
    }));

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_meta_email',
      customer: 'cus_meta_1',
      subscription: 'sub_meta_1',
      customer_email: 'form@example.com',
      metadata: { email: 'verified@example.com', tier: 'standard', mode: 'default' },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    // User record should be keyed on the metadata email, not the form email
    const verifiedUser = await mockKV.get('user:verified@example.com', 'json') as Record<string, unknown> | null;
    const formUser = await mockKV.get('user:form@example.com', 'json') as Record<string, unknown> | null;

    expect(verifiedUser).not.toBeNull();
    expect(verifiedUser?.billingStatus).toBe('active');
    expect(formUser).toBeNull();
  });

  it('falls back to customer_email when metadata.email is absent', async () => {
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_fallback', subscriptionId: 'sub_fallback',
    }));

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_fallback_email',
      customer: 'cus_fallback',
      subscription: 'sub_fallback',
      customer_email: 'fallback@example.com',
      metadata: { tier: 'standard', mode: 'default' },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:fallback@example.com', 'json') as Record<string, unknown> | null;
    expect(user).not.toBeNull();
    expect(user?.billingStatus).toBe('active');
  });

  it('stores customer mapping under the metadata.email address', async () => {
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_map_1', subscriptionId: 'sub_map_1',
    }));

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_customer_map',
      customer: 'cus_map_1',
      subscription: 'sub_map_1',
      customer_email: 'form2@example.com',
      metadata: { email: 'real@example.com', tier: 'standard', mode: 'default' },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const mappedEmail = await mockKV.get('stripe-customer:cus_map_1');
    expect(mappedEmail).toBe('real@example.com');
  });

  it('writes subscribedAt, checkoutSessionId, and stripeCustomerId', async () => {
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_checkout_1', subscriptionId: 'sub_checkout_1',
    }));

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_checkout_fields',
      customer: 'cus_checkout_1',
      subscription: 'sub_checkout_1',
      customer_email: 'checkout@example.com',
      metadata: { email: 'checkout@example.com', tier: 'standard', mode: 'default' },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:checkout@example.com', 'json') as Record<string, unknown>;
    expect(user.subscribedAt).toBeDefined();
    expect(user.checkoutSessionId).toBe('cs_checkout_fields');
    expect(user.stripeCustomerId).toBe('cus_checkout_1');
    expect(user.stripeSubscriptionId).toBe('sub_checkout_1');
  });

  it('calls syncSubscriptionState which updates tier from Stripe API', async () => {
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_sync_check', subscriptionId: 'sub_sync_check',
      tier: 'advanced', mode: 'advanced',
    }));

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_sync_check',
      customer: 'cus_sync_check',
      subscription: 'sub_sync_check',
      customer_email: 'sync_check@example.com',
      metadata: { email: 'sync_check@example.com' },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    // fetchSubscription should have been called
    expect(fetchSubscription).toHaveBeenCalledWith('sub_sync_check', 'sk_test_123');

    const user = await mockKV.get('user:sync_check@example.com', 'json') as Record<string, unknown>;
    expect(user.subscriptionTier).toBe('advanced');
    expect(user.accessTier).toBe('advanced');
    expect(user.subscribedMode).toBe('advanced');
  });

  it('returns 200 and writes checkout fields even when fetchSubscription returns null', async () => {
    vi.mocked(fetchSubscription).mockResolvedValue(null);

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_no_fetch',
      customer: 'cus_no_fetch',
      subscription: 'sub_no_fetch',
      customer_email: 'nofetch@example.com',
      metadata: { email: 'nofetch@example.com' },
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:nofetch@example.com', 'json') as Record<string, unknown>;
    // Checkout-specific fields still written
    expect(user.subscribedAt).toBeDefined();
    expect(user.checkoutSessionId).toBe('cs_no_fetch');
    // But no tier/billing from sync (will be set on next subscription.updated)
  });
});

// ---------------------------------------------------------------------------
// customer.subscription.updated — delegates to syncSubscriptionState
// ---------------------------------------------------------------------------
describe('handleSubscriptionUpdated', () => {
  it('syncs subscription state from Stripe API', async () => {
    seedCustomer('cus_upd_1', 'upd@example.com');
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_upd_1', subscriptionId: 'sub_upd_1',
      tier: 'max', mode: 'default', status: 'active',
    }));

    const body = buildEvent('customer.subscription.updated', {
      id: 'sub_upd_1',
      customer: 'cus_upd_1',
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    expect(fetchSubscription).toHaveBeenCalledWith('sub_upd_1', 'sk_test_123');

    const user = await mockKV.get('user:upd@example.com', 'json') as Record<string, unknown>;
    expect(user.subscriptionTier).toBe('max');
    expect(user.accessTier).toBe('max');
    expect(user.billingStatus).toBe('active');
    expect(user.lastSyncedAt).toBeDefined();
  });

  it('handles plan downgrade via subscription.updated', async () => {
    seedCustomer('cus_downgrade', 'downgrade@example.com', {
      subscriptionTier: 'max', accessTier: 'max',
    });
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_downgrade', subscriptionId: 'sub_downgrade',
      tier: 'standard', mode: 'default',
    }));

    const body = buildEvent('customer.subscription.updated', {
      id: 'sub_downgrade',
      customer: 'cus_downgrade',
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:downgrade@example.com', 'json') as Record<string, unknown>;
    expect(user.subscriptionTier).toBe('standard');
  });

  it('handles past_due status from Stripe via subscription.updated', async () => {
    seedCustomer('cus_past_due', 'pastdue@example.com');
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_past_due', subscriptionId: 'sub_past_due',
      status: 'past_due',
    }));

    const body = buildEvent('customer.subscription.updated', {
      id: 'sub_past_due',
      customer: 'cus_past_due',
    });

    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);

    const user = await mockKV.get('user:pastdue@example.com', 'json') as Record<string, unknown>;
    expect(user.billingStatus).toBe('past_due');
  });

  it('returns 200 when customer mapping is absent', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'No such customer' } }), { status: 404 }),
    ) as typeof globalThis.fetch;

    try {
      const body = buildEvent('customer.subscription.updated', {
        id: 'sub_unknown',
        customer: 'cus_unknown',
      });

      const res = await postWebhook(createApp(), body);
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// customer.subscription.deleted — direct write (CF-004)
// ---------------------------------------------------------------------------
describe('handleSubscriptionDeleted', () => {
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
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'No such customer' } }), { status: 404 }),
    ) as typeof globalThis.fetch;

    try {
      const body = buildEvent('customer.subscription.deleted', {
        id: 'sub_del_nomatch',
        customer: 'cus_unknown_del',
      });

      const res = await postWebhook(createApp(), body);
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Unhandled event types — should return 200 (ack to Stripe)
// ---------------------------------------------------------------------------
describe('unhandled event types', () => {
  it('returns 200 for unknown event types', async () => {
    const body = buildEvent('customer.created', { id: 'cus_new' });
    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);
  });

  it('returns 200 for old event types that are no longer handled', async () => {
    // These were previously handled but now hit the default branch
    for (const type of ['customer.subscription.created', 'invoice.paid', 'invoice.payment_failed']) {
      const body = buildEvent(type, { customer: 'cus_old', subscription: 'sub_old' });
      const res = await postWebhook(createApp(), body);
      expect(res.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Auto-recreate on downgrade (advanced → default)
// ---------------------------------------------------------------------------
describe('auto-recreate on downgrade', () => {
  it('calls reconcileAgentConfigs when mode changes from advanced to default', async () => {
    seedCustomer('cus_down_1', 'pro@example.com', { subscribedMode: 'advanced' });
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_down_1', tier: 'standard', mode: 'default',
    }));

    const body = buildEvent('customer.subscription.updated', {
      id: 'sub_down_1', customer: 'cus_down_1',
    });
    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);
    expect(mockReconcileAgentConfigs).toHaveBeenCalledWith(
      expect.anything(), // env
      expect.stringContaining('pro-example-com'), // bucketName
      'https://r2.test',
      'default',
      { overwrite: true, cleanup: true, contextModeEnabled: false },
    );
  });

  it('does NOT call reconcileAgentConfigs when mode stays the same', async () => {
    seedCustomer('cus_same_1', 'same@example.com', { subscribedMode: 'default' });
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_same_1', tier: 'standard', mode: 'default',
    }));

    const body = buildEvent('customer.subscription.updated', {
      id: 'sub_same_1', customer: 'cus_same_1',
    });
    await postWebhook(createApp(), body);
    expect(mockReconcileAgentConfigs).not.toHaveBeenCalled();
  });

  it('calls reconcileAgentConfigs on upgrade (default → advanced)', async () => {
    seedCustomer('cus_up_1', 'upgrade@example.com', { subscribedMode: 'default' });
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_up_1', tier: 'advanced', mode: 'advanced',
    }));

    const body = buildEvent('customer.subscription.updated', {
      id: 'sub_up_1', customer: 'cus_up_1',
    });
    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);
    expect(mockReconcileAgentConfigs).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('upgrade-example-com'),
      'https://r2.test',
      'advanced',
      { overwrite: true, cleanup: true, contextModeEnabled: false },
    );
  });

  it('reconcileAgentConfigs failure on downgrade does not break the webhook', async () => {
    seedCustomer('cus_fail_1', 'fail@example.com', { subscribedMode: 'advanced' });
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_fail_1', tier: 'standard', mode: 'default',
    }));
    mockReconcileAgentConfigs.mockRejectedValueOnce(new Error('R2 timeout'));

    const body = buildEvent('customer.subscription.updated', {
      id: 'sub_fail_1', customer: 'cus_fail_1',
    });
    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);
  });

  it('reconcileAgentConfigs failure on upgrade does not break the webhook', async () => {
    seedCustomer('cus_fail_2', 'fail-up@example.com', { subscribedMode: 'default' });
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_fail_2', tier: 'advanced', mode: 'advanced',
    }));
    mockReconcileAgentConfigs.mockRejectedValueOnce(new Error('R2 timeout'));

    const body = buildEvent('customer.subscription.updated', {
      id: 'sub_fail_2', customer: 'cus_fail_2',
    });
    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Auto-reconcile on subscription.deleted
// ---------------------------------------------------------------------------
describe('auto-reconcile on subscription.deleted', () => {
  it('calls reconcileAgentConfigs with default mode on subscription deletion', async () => {
    seedCustomer('cus_del_1', 'deleted@example.com', { subscribedMode: 'advanced' });

    const body = buildEvent('customer.subscription.deleted', {
      id: 'sub_del_1', customer: 'cus_del_1',
    });
    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);
    expect(mockReconcileAgentConfigs).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('deleted-example-com'),
      'https://r2.test',
      'default',
      { overwrite: true, cleanup: true, contextModeEnabled: false },
    );
  });

  it('sets sessionMode to default in preferences KV on deletion', async () => {
    seedCustomer('cus_del_2', 'del-prefs@example.com', { subscribedMode: 'advanced' });
    const prefsKey = `user-prefs:codeflare-del-prefs-example-com`;
    await mockKV.put(prefsKey, JSON.stringify({ sessionMode: 'advanced' }));

    const body = buildEvent('customer.subscription.deleted', {
      id: 'sub_del_2', customer: 'cus_del_2',
    });
    await postWebhook(createApp(), body);

    const prefsRaw = await mockKV.get(prefsKey) as string | null;
    const prefs = JSON.parse(prefsRaw || '{}');
    expect(prefs.sessionMode).toBe('default');
  });

  it('reconcileAgentConfigs failure on deletion does not break the webhook', async () => {
    seedCustomer('cus_del_3', 'del-fail@example.com', { subscribedMode: 'advanced' });
    mockReconcileAgentConfigs.mockRejectedValueOnce(new Error('R2 down'));

    const body = buildEvent('customer.subscription.deleted', {
      id: 'sub_del_3', customer: 'cus_del_3',
    });
    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Admin notification on checkout
// ---------------------------------------------------------------------------
describe('admin notification on checkout', () => {
  it('sends admin email after checkout completes', async () => {
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_notify_1', subscriptionId: 'sub_notify_1', tier: 'standard', mode: 'default',
    }));

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_notify_1',
      customer: 'cus_notify_1',
      subscription: 'sub_notify_1',
      metadata: { email: 'newuser@example.com', tier: 'standard', mode: 'default' },
    });
    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);
    expect(mockSendAdminNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userEmail: 'newuser@example.com',
        adminEmails: ['admin@example.com'],
      }),
    );
  });

  it('admin notification failure does not break the webhook', async () => {
    vi.mocked(fetchSubscription).mockResolvedValue(mockSubscriptionSnapshot({
      customerId: 'cus_nfail_1', subscriptionId: 'sub_nfail_1',
    }));
    mockSendAdminNotification.mockRejectedValueOnce(new Error('Resend down'));

    const body = buildEvent('checkout.session.completed', {
      id: 'cs_nfail_1',
      customer: 'cus_nfail_1',
      subscription: 'sub_nfail_1',
      metadata: { email: 'nfail@example.com' },
    });
    const res = await postWebhook(createApp(), body);
    expect(res.status).toBe(200);
  });
});
