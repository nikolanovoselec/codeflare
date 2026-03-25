/**
 * Stripe integration library for Codeflare.
 *
 * Handles checkout session creation, webhook signature verification,
 * price-to-tier mapping, and low-level Stripe API communication.
 *
 * All functions are pure or async — no global state is mutated.
 */
import type { Env } from '../types';

// ---------------------------------------------------------------------------
// Price Map (Stripe sandbox)
// ---------------------------------------------------------------------------

interface PriceEntry {
  readonly tier: string;
  readonly mode: string;
  readonly priceId: string;
}

/**
 * Stripe price IDs mapped to tier + mode combinations.
 * Each paid tier has a default and advanced price.
 */
const PRICE_MAP: readonly PriceEntry[] = [
  { tier: 'standard', mode: 'default',  priceId: 'price_1TEd7TLQzoadEf8HOKThTum9' },
  { tier: 'standard', mode: 'advanced', priceId: 'price_1TEd7TLQzoadEf8HgRwmmrpo' },
  { tier: 'advanced', mode: 'default',  priceId: 'price_1TEd7ULQzoadEf8H2yUwbrky' },
  { tier: 'advanced', mode: 'advanced', priceId: 'price_1TEd7ULQzoadEf8HekI1KGon' },
  { tier: 'max',      mode: 'default',  priceId: 'price_1TEd7ULQzoadEf8H3eCbNgfR' },
  { tier: 'max',      mode: 'advanced', priceId: 'price_1TEd7VLQzoadEf8H8ZUi7m4t' },
] as const;

/** Reverse lookup index: priceId → { tier, mode } */
const PRICE_ID_TO_TIER = new Map<string, { tier: string; mode: string }>(
  PRICE_MAP.map((entry) => [entry.priceId, { tier: entry.tier, mode: entry.mode }]),
);

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Get the Stripe price ID for a given tier and mode, or null if not a paid tier. */
export function getStripePriceId(tier: string, mode: string): string | null {
  const entry = PRICE_MAP.find((e) => e.tier === tier && e.mode === mode);
  return entry?.priceId ?? null;
}

/** Reverse-lookup: resolve tier + mode from a Stripe price ID, or null if unknown. */
export function resolveTierFromPriceId(priceId: string): { tier: string; mode: string } | null {
  return PRICE_ID_TO_TIER.get(priceId) ?? null;
}

/** Whether Stripe is configured (STRIPE_SECRET_KEY present and non-empty). */
export function isStripeConfigured(env: Pick<Env, 'STRIPE_SECRET_KEY'>): boolean {
  return typeof env.STRIPE_SECRET_KEY === 'string' && env.STRIPE_SECRET_KEY.length > 0;
}

// ---------------------------------------------------------------------------
// Stripe API communication
// ---------------------------------------------------------------------------

/** Low-level Stripe API request. Uses URL-encoded form body and Bearer auth. */
async function stripeRequest<T>(
  path: string,
  params: Record<string, string>,
  secretKey: string,
  method: string = 'POST',
  idempotencyKey?: string,
): Promise<T> {
  const url = `https://api.stripe.com${path}`;
  const body = new URLSearchParams(params).toString();

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: method !== 'GET' ? body : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const errMsg = (data.error as Record<string, unknown>)?.message ?? `Stripe API error ${response.status}`;
    throw new Error(String(errMsg));
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Checkout session
// ---------------------------------------------------------------------------

interface CheckoutSessionOptions {
  priceId: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  secretKey: string;
  metadata?: Record<string, string>;
}

interface CheckoutSessionResult {
  id: string;
  url: string;
}

/** Create a Stripe Checkout Session for a subscription. */
export async function createCheckoutSession(opts: CheckoutSessionOptions): Promise<CheckoutSessionResult> {
  const params: Record<string, string> = {
    'mode': 'subscription',
    'line_items[0][price]': opts.priceId,
    'line_items[0][quantity]': '1',
    'success_url': opts.successUrl,
    'cancel_url': opts.cancelUrl,
    'customer_email': opts.customerEmail,
  };

  if (opts.metadata) {
    for (const [key, value] of Object.entries(opts.metadata)) {
      params[`metadata[${key}]`] = value;
    }
  }

  // CF-030: Derive idempotency key to prevent duplicate checkout sessions on retry
  const idempotencyInput = `${opts.customerEmail}:${opts.priceId}:${Math.floor(Date.now() / 60000)}`;
  const idempotencyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(idempotencyInput));
  const idempotencyKey = Array.from(new Uint8Array(idempotencyBytes)).map(b => b.toString(16).padStart(2, '0')).join('');

  const session = await stripeRequest<{ id: string; url: string }>(
    '/v1/checkout/sessions',
    params,
    opts.secretKey,
    'POST',
    idempotencyKey,
  );

  return { id: session.id, url: session.url };
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

const WEBHOOK_TOLERANCE_SECONDS = 300; // 5 minutes

/**
 * Verify a Stripe webhook signature (v1 scheme, HMAC-SHA256).
 * Uses crypto.subtle for Workers-compatible constant-time comparison.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  // Parse t= and v1= from signature header
  const parts = signatureHeader.split(',');
  let timestamp = '';
  let signature = '';

  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (key === 't') timestamp = value;
    if (key === 'v1' && !signature) signature = value;
  }

  if (!timestamp || !signature) return false;

  // Check timestamp tolerance
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;

  // Compute expected signature
  const payload = `${timestamp}.${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expectedHex = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  const expected = encoder.encode(expectedHex);
  const actual = encoder.encode(signature);
  if (expected.byteLength !== actual.byteLength) return false;
  return crypto.subtle.timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Customer Portal
// ---------------------------------------------------------------------------

/** Create a Stripe Billing Portal session for subscription management. */
export async function createPortalSession(opts: {
  customerId: string;
  returnUrl: string;
  secretKey: string;
}): Promise<{ id: string; url: string }> {
  const params: Record<string, string> = {
    customer: opts.customerId,
    return_url: opts.returnUrl,
  };

  const session = await stripeRequest<{ id: string; url: string }>(
    '/v1/billing_portal/sessions',
    params,
    opts.secretKey,
  );

  return { id: session.id, url: session.url };
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

/** Parse a raw webhook body into a typed StripeEvent. */
export function parseStripeEvent(rawBody: string): StripeEvent {
  const parsed = JSON.parse(rawBody) as StripeEvent;
  if (!parsed.id || !parsed.type || !parsed.data?.object) {
    throw new Error('Invalid Stripe event payload');
  }
  return parsed;
}
