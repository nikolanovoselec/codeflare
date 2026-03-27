/**
 * syncSubscriptionState tests — Signal and Sync pattern.
 *
 * Tests the centralized sync function that fetches subscription state from
 * Stripe API and writes a complete snapshot to KV.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

// ---------------------------------------------------------------------------
// Mocks — fetchSubscription and resolveEmailFromCustomer are the two
// external calls made by syncSubscriptionState.
// ---------------------------------------------------------------------------
vi.mock('../../lib/stripe', () => ({
  fetchSubscription: vi.fn(),
  verifyWebhookSignature: vi.fn(async () => true),
  parseStripeEvent: vi.fn((body: string) => JSON.parse(body)),
  isStripeConfigured: vi.fn(() => true),
}));

import { fetchSubscription } from '../../lib/stripe';
import type { StripeSubscriptionSnapshot } from '../../lib/stripe';

// We need to import the sync function after mocks are set up.
// syncSubscriptionState also calls resolveEmailFromCustomer internally,
// but since it's in the same module, we test it via integration
// (seeding the KV with customer mappings or mocking fetch for API fallback).

// Import the route module which exports syncSubscriptionState
import { syncSubscriptionState } from '../../routes/stripe-webhook';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
let mockKV: ReturnType<typeof createMockKV>;
let env: Env;

function makeSnapshot(overrides: Partial<StripeSubscriptionSnapshot> = {}): StripeSubscriptionSnapshot {
  return {
    subscriptionId: 'sub_sync_1',
    subscriptionItemId: 'si_sync_1',
    customerId: 'cus_sync_1',
    status: 'active',
    tier: 'advanced',
    mode: 'default',
    priceId: 'price_adv_default',
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
  env = {
    KV: mockKV as unknown as KVNamespace,
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_123',
  } as Env;
});

describe('syncSubscriptionState', () => {
  it('writes complete state to KV from Stripe snapshot', async () => {
    // Seed customer → email mapping
    mockKV._store.set('stripe-customer:cus_sync_1', 'sync@example.com');
    mockKV._set('user:sync@example.com', {
      addedBy: 'self',
      accessTier: 'pending',
      subscriptionTier: 'pending',
      onboardingComplete: true,
    });

    vi.mocked(fetchSubscription).mockResolvedValue(makeSnapshot());

    await syncSubscriptionState('cus_sync_1', 'sub_sync_1', env);

    const user = JSON.parse(mockKV._store.get('user:sync@example.com')!);
    expect(user.subscriptionTier).toBe('advanced');
    expect(user.accessTier).toBe('advanced');
    expect(user.subscribedMode).toBe('default');
    expect(user.billingStatus).toBe('active');
    expect(user.stripeSubscriptionId).toBe('sub_sync_1');
    expect(user.stripePriceId).toBe('price_adv_default');
    expect(user.billingPeriodEnd).toBeDefined();
    expect(user.lastSyncedAt).toBeDefined();
    // Preserved fields
    expect(user.addedBy).toBe('self');
    expect(user.onboardingComplete).toBe(true);
  });

  it('skips write when KV lastSyncedAt is newer than current timestamp', async () => {
    const futureSync = new Date(Date.now() + 60_000).toISOString();
    mockKV._store.set('stripe-customer:cus_sync_1', 'sync@example.com');
    mockKV._set('user:sync@example.com', {
      subscriptionTier: 'standard',
      accessTier: 'standard',
      billingStatus: 'active',
      lastSyncedAt: futureSync,
    });

    vi.mocked(fetchSubscription).mockResolvedValue(makeSnapshot({ tier: 'max' }));

    await syncSubscriptionState('cus_sync_1', 'sub_sync_1', env);

    // Should NOT have been overwritten — still standard
    const user = JSON.parse(mockKV._store.get('user:sync@example.com')!);
    expect(user.subscriptionTier).toBe('standard');
  });

  it('overwrites when no lastSyncedAt in KV', async () => {
    mockKV._store.set('stripe-customer:cus_sync_1', 'sync@example.com');
    mockKV._set('user:sync@example.com', {
      subscriptionTier: 'standard',
      accessTier: 'standard',
      billingStatus: 'active',
      // no lastSyncedAt
    });

    vi.mocked(fetchSubscription).mockResolvedValue(makeSnapshot({ tier: 'max', mode: 'advanced' }));

    await syncSubscriptionState('cus_sync_1', 'sub_sync_1', env);

    const user = JSON.parse(mockKV._store.get('user:sync@example.com')!);
    expect(user.subscriptionTier).toBe('max');
    expect(user.subscribedMode).toBe('advanced');
  });

  it('returns early when email cannot be resolved', async () => {
    // No customer mapping, and we need to mock the Stripe customer API fallback to also fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'No such customer' } }), { status: 404 }),
    ) as typeof globalThis.fetch;

    vi.mocked(fetchSubscription).mockResolvedValue(makeSnapshot());

    try {
      await syncSubscriptionState('cus_unknown', 'sub_sync_1', env);

      // fetchSubscription should not have been called — email resolution fails first
      expect(fetchSubscription).not.toHaveBeenCalled();
      // No user record should exist
      expect(mockKV._store.has('user:undefined')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns early when subscription not found (fetchSubscription returns null)', async () => {
    mockKV._store.set('stripe-customer:cus_sync_1', 'sync@example.com');
    mockKV._set('user:sync@example.com', {
      subscriptionTier: 'standard',
      billingStatus: 'active',
    });

    vi.mocked(fetchSubscription).mockResolvedValue(null);

    await syncSubscriptionState('cus_sync_1', 'sub_sync_1', env);

    // Should not have been modified
    const user = JSON.parse(mockKV._store.get('user:sync@example.com')!);
    expect(user.subscriptionTier).toBe('standard');
    expect(user.lastSyncedAt).toBeUndefined();
  });

  it('preserves existing KV fields (addedBy, onboardingComplete, etc.)', async () => {
    mockKV._store.set('stripe-customer:cus_sync_1', 'sync@example.com');
    mockKV._set('user:sync@example.com', {
      addedBy: 'admin',
      addedAt: '2026-01-01T00:00:00Z',
      role: 'user',
      onboardingComplete: true,
      trialUsed: true,
      checkoutSessionId: 'cs_old_123',
      subscriptionTier: 'standard',
      accessTier: 'standard',
    });

    vi.mocked(fetchSubscription).mockResolvedValue(makeSnapshot());

    await syncSubscriptionState('cus_sync_1', 'sub_sync_1', env);

    const user = JSON.parse(mockKV._store.get('user:sync@example.com')!);
    expect(user.addedBy).toBe('admin');
    expect(user.addedAt).toBe('2026-01-01T00:00:00Z');
    expect(user.role).toBe('user');
    expect(user.onboardingComplete).toBe(true);
    expect(user.trialUsed).toBe(true);
    expect(user.checkoutSessionId).toBe('cs_old_123');
    // Updated fields
    expect(user.subscriptionTier).toBe('advanced');
    expect(user.billingStatus).toBe('active');
  });

  it('preserves tier when metadata is null (does not blank it)', async () => {
    mockKV._store.set('stripe-customer:cus_sync_1', 'sync@example.com');
    mockKV._set('user:sync@example.com', {
      subscriptionTier: 'max',
      accessTier: 'max',
      subscribedMode: 'advanced',
      billingStatus: 'active',
    });

    // Snapshot with null tier/mode (price metadata not set yet)
    vi.mocked(fetchSubscription).mockResolvedValue(makeSnapshot({
      tier: null,
      mode: null,
    }));

    await syncSubscriptionState('cus_sync_1', 'sub_sync_1', env);

    const user = JSON.parse(mockKV._store.get('user:sync@example.com')!);
    // Tier should be preserved — not blanked
    expect(user.subscriptionTier).toBe('max');
    expect(user.accessTier).toBe('max');
    expect(user.subscribedMode).toBe('advanced');
    // Other fields from snapshot should still update
    expect(user.billingStatus).toBe('active');
    expect(user.lastSyncedAt).toBeDefined();
  });

  it('updates billingStatus from snapshot (e.g. past_due)', async () => {
    mockKV._store.set('stripe-customer:cus_sync_1', 'sync@example.com');
    mockKV._set('user:sync@example.com', {
      subscriptionTier: 'advanced',
      accessTier: 'advanced',
      billingStatus: 'active',
    });

    vi.mocked(fetchSubscription).mockResolvedValue(makeSnapshot({
      status: 'past_due',
    }));

    await syncSubscriptionState('cus_sync_1', 'sub_sync_1', env);

    const user = JSON.parse(mockKV._store.get('user:sync@example.com')!);
    expect(user.billingStatus).toBe('past_due');
  });

  it('writes cancelAtPeriodEnd status from snapshot', async () => {
    mockKV._store.set('stripe-customer:cus_sync_1', 'sync@example.com');
    mockKV._set('user:sync@example.com', {
      subscriptionTier: 'advanced',
      billingStatus: 'active',
    });

    vi.mocked(fetchSubscription).mockResolvedValue(makeSnapshot({
      cancelAtPeriodEnd: true,
    }));

    await syncSubscriptionState('cus_sync_1', 'sub_sync_1', env);

    const user = JSON.parse(mockKV._store.get('user:sync@example.com')!);
    expect(user.cancelAtPeriodEnd).toBe(true);
  });
});
