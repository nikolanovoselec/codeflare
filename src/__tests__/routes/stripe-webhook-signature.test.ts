/**
 * CF-004: Webhook signature verification driven through the REAL verifier.
 *
 * Every other webhook test stubs `verifyWebhookSignature` to `true`, so a
 * regression in the HMAC scheme or the tolerance window would ship green.
 * This file does NOT mock `../../lib/stripe` - it signs the payload with the
 * real `STRIPE_WEBHOOK_SECRET` exactly as `verifyWebhookSignature`
 * (src/lib/stripe.ts) expects: HMAC-SHA256 over `${timestamp}.${rawBody}`,
 * rendered as lowercase hex in a `t=<ts>,v1=<hex>` header.
 *
 * Asserts:
 *   - 200 for a correctly-signed payload
 *   - 400 for a bad signature, a missing signature header,
 *     a stale timestamp, and a future timestamp (both outside the 5-min window)
 *   - missing-`email` checkout is acked (200) but writes no user record
 *   - no-prior-record subscription.deleted is acked (200, no crash)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

// fetchSubscription would hit the network on a successful checkout; stub the
// Stripe customer-lookup fallback by controlling global fetch per test.
// NOTE: ../../lib/stripe is intentionally NOT mocked - the real
// verifyWebhookSignature runs.

// r2-seed / r2-config / email / access-policy are network/side-effect helpers
// invoked after a successful sync. Stub them so the handler logic runs without
// reaching out, while the signature path stays real.
vi.mock('../../lib/r2-seed', () => ({ reconcileAgentConfigs: vi.fn(async () => ({ written: [], skipped: [], deleted: [], warnings: [] })) }));
vi.mock('../../lib/r2-config', () => ({ getR2Config: vi.fn(async () => ({ accountId: 'test-account', endpoint: 'https://r2.test' })) }));
vi.mock('../../lib/email', () => ({ sendSubscriptionAdminNotification: vi.fn(async () => true), sendSubscriptionEmail: vi.fn(async () => true) }));
vi.mock('../../lib/access-policy', () => ({ getAdminEmails: vi.fn(async () => []) }));

import stripeWebhookRoute from '../../routes/stripe-webhook';

const WEBHOOK_SECRET = 'whsec_test_secret_456';

let mockKV: ReturnType<typeof createMockKV>;

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.env = {
      KV: mockKV as unknown as KVNamespace,
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    } as Env;
    return next();
  });
  app.route('/', stripeWebhookRoute);
  return app;
}

/**
 * Produce a Stripe-Signature header using the SAME scheme verifyWebhookSignature
 * checks: HMAC-SHA256 over `${timestamp}.${body}`, lowercase hex.
 * `timestampOverride` lets a test forge a stale/future timestamp while still
 * signing the (timestamp, body) tuple correctly - so only the tolerance check
 * can reject it, not the HMAC.
 */
async function signWebhook(body: string, secret: string, timestampOverride?: number): Promise<string> {
  const timestamp = timestampOverride ?? Math.floor(Date.now() / 1000);
  const payload = `${timestamp}.${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const hex = Array.from(new Uint8Array(sigBytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${hex}`;
}

function buildEvent(type: string, data: Record<string, unknown>, id = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
  return JSON.stringify({ id, type, data: { object: data } });
}

function post(app: ReturnType<typeof createApp>, body: string, signature?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature !== undefined) headers['Stripe-Signature'] = signature;
  return app.request('/webhook', { method: 'POST', headers, body });
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockKV = createMockKV();
  originalFetch = globalThis.fetch;
  // Default: Stripe customer-lookup fallback / subscription fetch return 404 so
  // the handler resolves no email from the API. Tests that need a real sync
  // seed the KV customer mapping and override fetch explicitly.
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 }),
  ) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Stripe webhook signature verification (real HMAC) / CF-004 / REQ-SEC-007', () => {
  it('accepts a correctly-signed payload (200)', async () => {
    const body = buildEvent('customer.created', { id: 'cus_ok' });
    const sig = await signWebhook(body, WEBHOOK_SECRET);

    const res = await post(createApp(), body, sig);

    expect(res.status).toBe(200);
    const json = await res.json() as { received: boolean };
    expect(json.received).toBe(true);
  });

  it('rejects a forged signature with the right structure (400)', async () => {
    const body = buildEvent('customer.created', { id: 'cus_bad' });
    // Valid t= and v1= shape, but the hex is not a real HMAC of the payload.
    const ts = Math.floor(Date.now() / 1000);
    const forged = `t=${ts},v1=${'0'.repeat(64)}`;

    const res = await post(createApp(), body, forged);

    expect(res.status).toBe(400);
  });

  it('rejects a signature computed with the wrong secret (400)', async () => {
    const body = buildEvent('customer.created', { id: 'cus_wrong_secret' });
    const sig = await signWebhook(body, 'whsec_attacker_guess');

    const res = await post(createApp(), body, sig);

    expect(res.status).toBe(400);
  });

  it('rejects a missing Stripe-Signature header (400)', async () => {
    const body = buildEvent('customer.created', { id: 'cus_nosig' });

    const res = await post(createApp(), body); // no signature

    expect(res.status).toBe(400);
  });

  it('rejects a stale timestamp outside the 5-minute tolerance (400)', async () => {
    const body = buildEvent('customer.created', { id: 'cus_stale' });
    // 10 minutes in the past - correctly signed for that timestamp, but stale.
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    const sig = await signWebhook(body, WEBHOOK_SECRET, staleTs);

    const res = await post(createApp(), body, sig);

    expect(res.status).toBe(400);
  });

  it('rejects a future timestamp outside the 5-minute tolerance (400)', async () => {
    const body = buildEvent('customer.created', { id: 'cus_future' });
    // 10 minutes in the future - correctly signed, but ahead of tolerance.
    const futureTs = Math.floor(Date.now() / 1000) + 600;
    const sig = await signWebhook(body, WEBHOOK_SECRET, futureTs);

    const res = await post(createApp(), body, sig);

    expect(res.status).toBe(400);
  });

  it('acks a valid-signature checkout.session.completed with no email but writes no user record', async () => {
    // checkout.session.completed with neither metadata.email nor customer_email:
    // handleCheckoutCompleted logs and returns early; the webhook still acks 200.
    const body = buildEvent('checkout.session.completed', {
      id: 'cs_no_email',
      customer: 'cus_no_email',
      subscription: 'sub_no_email',
      // intentionally no email / customer_email / metadata.email
    });
    const sig = await signWebhook(body, WEBHOOK_SECRET);

    const res = await post(createApp(), body, sig);

    expect(res.status).toBe(200);
    // No user record was written because email could not be resolved.
    const written = Array.from(mockKV._store.keys()).filter((k) => k.startsWith('user:'));
    expect(written).toEqual([]);
  });

  it('acks a valid-signature subscription.deleted with no prior record (200, no crash)', async () => {
    // No stripe-customer mapping and the Stripe API fallback 404s, so the email
    // cannot be resolved. handleSubscriptionDeleted must ack rather than throw.
    const body = buildEvent('customer.subscription.deleted', {
      id: 'sub_orphan',
      customer: 'cus_orphan',
    });
    const sig = await signWebhook(body, WEBHOOK_SECRET);

    const res = await post(createApp(), body, sig);

    expect(res.status).toBe(200);
    const written = Array.from(mockKV._store.keys()).filter((k) => k.startsWith('user:'));
    expect(written).toEqual([]);
  });
});
