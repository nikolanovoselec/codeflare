/**
 * Stripe integration library for Codeflare.
 *
 * Handles checkout session creation, webhook signature verification,
 * price-to-tier mapping, and low-level Stripe API communication.
 *
 * All functions are pure or async — no global state is mutated.
 */
import { z } from 'zod';
import type { Env, SubscriptionTierConfig } from '../types';
import { AppError } from './error-types';
import { firstZodError } from './request-helpers';

// ---------------------------------------------------------------------------
// CF-022: Runtime Zod schemas for Stripe API responses
//
// Each schema validates only the fields actually consumed. safeParse failures
// throw a typed AppError instead of silently trusting an `as` cast. .passthrough()
// preserves unknown fields (e.g. `error`) so existing error-handling paths that
// read `data.error.message` keep working.
// ---------------------------------------------------------------------------

/** Stripe price response (getStripePrices). */
const StripePriceResponseSchema = z.object({
  unit_amount: z.number().optional(),
  currency: z.string().optional(),
  currency_options: z.record(z.string(), z.object({ unit_amount: z.number() })).optional(),
}).passthrough();

/** Generic Stripe response carrying an optional error object (stripeRequest). */
const StripeResponseSchema = z.object({
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();

/** Checkout / portal session result. */
const StripeSessionSchema = z.object({
  id: z.string(),
  url: z.string(),
}).passthrough();

/** Subscription response (fetchSubscription). */
const StripeSubscriptionSchema = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  cancel_at_period_end: z.boolean().optional(),
  current_period_end: z.number().nullable().optional(),
  items: z.object({
    data: z.array(z.object({
      id: z.string().optional(),
      price: z.object({
        id: z.string().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
      }).passthrough().optional(),
    }).passthrough()).optional(),
  }).passthrough().optional(),
}).passthrough();

/** Parse external Stripe JSON with a Zod schema, throwing a typed AppError on failure. */
function parseStripeOrThrow<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('STRIPE_VALIDATION_ERROR', 502, `${context}: ${firstZodError(result.error)}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Get the Stripe price ID for a given tier and mode.
 * Looks up stripePriceId / stripeAdvancedPriceId from tier config (KV-sourced).
 */
export function getStripePriceId(tier: string, mode: string, tiers: SubscriptionTierConfig[]): string | null {
  const tierConfig = tiers.find((t) => t.id === tier);
  if (tierConfig) {
    const priceId = mode === 'advanced' ? tierConfig.stripeAdvancedPriceId : tierConfig.stripePriceId;
    if (priceId) return priceId;
  }
  return null;
}

/**
 * Reverse-lookup: resolve tier + mode from a Stripe price ID.
 * Searches tier config for matching stripePriceId or stripeAdvancedPriceId.
 */
export function resolveTierFromPriceId(priceId: string, tiers: SubscriptionTierConfig[]): { tier: string; mode: string } | null {
  for (const t of tiers) {
    if (t.stripePriceId === priceId) return { tier: t.id as string, mode: 'default' };
    if (t.stripeAdvancedPriceId === priceId) return { tier: t.id as string, mode: 'advanced' };
  }
  return null;
}

/** Whether Stripe is configured (STRIPE_SECRET_KEY present and non-empty). */
export function isStripeConfigured(env: Pick<Env, 'STRIPE_SECRET_KEY'>): boolean {
  return typeof env.STRIPE_SECRET_KEY === 'string' && env.STRIPE_SECRET_KEY.length > 0;
}

// ---------------------------------------------------------------------------
// Stripe Price fetching — for displaying prices on subscribe page
// ---------------------------------------------------------------------------


/** Cached Stripe price data (1-hour TTL) — stores base + currency_options */
interface CachedPrice {
  amount: number;
  currency: string;
  currencyOptions?: Record<string, { unit_amount: number }>;
  cachedAt: number;
}
const priceCache = new Map<string, CachedPrice>();
const PRICE_CACHE_TTL_MS = 3_600_000; // 1 hour

/**
 * Fetch price amount + currency from Stripe API for multiple price IDs.
 * When `currency` is provided, returns the amount from currency_options if available.
 */
export async function getStripePrices(
  priceIds: string[],
  secretKey: string,
  currency?: string,
): Promise<Map<string, { amount: number; currency: string }>> {
  const result = new Map<string, { amount: number; currency: string }>();
  const now = Date.now();
  const toFetch: string[] = [];

  // Check cache first
  for (const id of priceIds) {
    const cached = priceCache.get(id);
    if (cached && now - cached.cachedAt < PRICE_CACHE_TTL_MS) {
      result.set(id, selectCurrency(cached, currency));
    } else {
      toFetch.push(id);
    }
  }

  // Fetch uncached prices in parallel (expand currency_options for multi-currency)
  if (toFetch.length > 0) {
    const fetches = toFetch.map(async (id) => {
      try {
        const response = await fetch(
          `https://api.stripe.com/v1/prices/${id}?expand[]=currency_options`,
          {
            headers: { 'Authorization': `Bearer ${secretKey}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (response.ok) {
          const data = parseStripeOrThrow(StripePriceResponseSchema, await response.json(), 'Invalid Stripe price response');
          if (data.unit_amount != null && data.currency) {
            const cached: CachedPrice = {
              amount: data.unit_amount,
              currency: data.currency.toUpperCase(),
              currencyOptions: data.currency_options,
              cachedAt: now,
            };
            priceCache.set(id, cached);
            result.set(id, selectCurrency(cached, currency));
          }
        }
      } catch { /* non-fatal — price just won't be displayed */ }
    });
    await Promise.all(fetches);
  }

  return result;
}

/** Pick the right amount/currency from cached price data. */
function selectCurrency(
  cached: CachedPrice,
  currency?: string,
): { amount: number; currency: string } {
  if (currency) {
    const key = currency.toLowerCase();
    if (key === cached.currency.toLowerCase()) {
      return { amount: cached.amount, currency: cached.currency };
    }
    const opt = cached.currencyOptions?.[key];
    if (opt) {
      return { amount: opt.unit_amount, currency: key.toUpperCase() };
    }
  }
  return { amount: cached.amount, currency: cached.currency };
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

  const data = parseStripeOrThrow(StripeResponseSchema, await response.json(), 'Invalid Stripe API response');

  if (!response.ok) {
    const errMsg = data.error?.message ?? `Stripe API error ${response.status}`;
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
  /** Pass trial_period_days on the subscription. Omit for immediate billing. */
  trialDays?: number;
  /** Trial compute quota in hours — shown in checkout custom text. */
  trialQuotaHours?: number;
  /** ISO 4217 currency code (lowercase). Selects from Price's currency_options. */
  currency?: string;
  /** Unix timestamp (seconds) for subscription billing_cycle_anchor. */
  billingCycleAnchor?: number;
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

  if (opts.currency) {
    params['currency'] = opts.currency;
  }

  if (opts.metadata) {
    for (const [key, value] of Object.entries(opts.metadata)) {
      params[`metadata[${key}]`] = value;
    }
  }

  if (opts.trialDays != null && opts.trialDays > 0) {
    params['subscription_data[trial_period_days]'] = String(opts.trialDays);
    params['custom_text[submit][message]'] = `Your trial includes ${opts.trialQuotaHours ?? 4} hours of compute. Full billing begins after usage or ${opts.trialDays} days, whichever comes first.`;
  }

  if (opts.billingCycleAnchor != null) {
    params['subscription_data[billing_cycle_anchor]'] = String(opts.billingCycleAnchor);
  }

  // CF-030: Derive idempotency key to prevent duplicate checkout sessions on retry
  const idempotencyInput = `${opts.customerEmail}:${opts.priceId}:${opts.currency ?? ''}:${Math.floor(Date.now() / 60000)}`;
  const idempotencyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(idempotencyInput));
  const idempotencyKey = Array.from(new Uint8Array(idempotencyBytes)).map(b => b.toString(16).padStart(2, '0')).join('');

  const session = parseStripeOrThrow(
    StripeSessionSchema,
    await stripeRequest<unknown>(
      '/v1/checkout/sessions',
      params,
      opts.secretKey,
      'POST',
      idempotencyKey,
    ),
    'Invalid Stripe checkout session response',
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

  const session = parseStripeOrThrow(
    StripeSessionSchema,
    await stripeRequest<unknown>(
      '/v1/billing_portal/sessions',
      params,
      opts.secretKey,
    ),
    'Invalid Stripe portal session response',
  );

  return { id: session.id, url: session.url };
}

/**
 * Create a portal session that deep-links to subscription update confirmation.
 * Uses flow_data[type]=subscription_update_confirm to skip the portal's plan
 * selection page and go directly to the proration/confirmation step.
 *
 * Requires subscriptionItemId (si_xxx) — the first item's ID from the subscription.
 */
export async function createSwitchPortalSession(opts: {
  customerId: string;
  subscriptionId: string;
  subscriptionItemId: string;
  newPriceId: string;
  returnUrl: string;
  secretKey: string;
}): Promise<{ id: string; url: string }> {
  const params: Record<string, string> = {
    customer: opts.customerId,
    'flow_data[type]': 'subscription_update_confirm',
    'flow_data[subscription_update_confirm][subscription]': opts.subscriptionId,
    'flow_data[subscription_update_confirm][items][0][id]': opts.subscriptionItemId,
    'flow_data[subscription_update_confirm][items][0][price]': opts.newPriceId,
    'flow_data[subscription_update_confirm][items][0][quantity]': '1',
    'flow_data[after_completion][type]': 'redirect',
    'flow_data[after_completion][redirect][return_url]': opts.returnUrl,
  };

  const session = parseStripeOrThrow(
    StripeSessionSchema,
    await stripeRequest<unknown>(
      '/v1/billing_portal/sessions',
      params,
      opts.secretKey,
    ),
    'Invalid Stripe portal session response',
  );

  return { id: session.id, url: session.url };
}

// ---------------------------------------------------------------------------
// Trial management
// ---------------------------------------------------------------------------

/**
 * End a Stripe subscription trial immediately — triggers first charge.
 * Called when Timekeeper detects trial compute quota (e.g., 4h) is consumed.
 */
export async function endTrialNow(subscriptionId: string, secretKey: string): Promise<void> {
  await stripeRequest(
    `/v1/subscriptions/${subscriptionId}`,
    { trial_end: 'now' },
    secretKey,
  );
}

// ---------------------------------------------------------------------------
// Subscription fetching — Signal and Sync pattern
// ---------------------------------------------------------------------------

export interface StripeSubscriptionSnapshot {
  subscriptionId: string;
  subscriptionItemId: string | null; // si_xxx — needed for portal subscription_update_confirm flow
  customerId: string;
  status: string;
  tier: string | null;       // from price.metadata.tier
  mode: string | null;       // from price.metadata.mode
  priceId: string | null;
  billingPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Fetch subscription state directly from Stripe API.
 * Expands price items to extract tier/mode from price metadata.
 * Returns null on 404, throws on other errors.
 */
export async function fetchSubscription(
  subscriptionId: string,
  secretKey: string,
): Promise<StripeSubscriptionSnapshot | null> {
  const url = `https://api.stripe.com/v1/subscriptions/${subscriptionId}?expand[]=items.data.price`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 404) return null;

  // Read the body once; on error use the generic schema to extract error.message.
  const json = await response.json();

  if (!response.ok) {
    const errData = parseStripeOrThrow(StripeResponseSchema, json, 'Invalid Stripe API response');
    const errMsg = errData.error?.message ?? `Stripe API error ${response.status}`;
    throw new Error(String(errMsg));
  }

  const data = parseStripeOrThrow(StripeSubscriptionSchema, json, 'Invalid Stripe subscription response');

  // Extract first subscription item and its price
  const firstItem = data.items?.data?.[0];
  const firstPrice = firstItem?.price;
  const subscriptionItemId = firstItem?.id || null;

  const tier = firstPrice?.metadata?.tier || null;
  const mode = firstPrice?.metadata?.mode || null;
  const priceId = firstPrice?.id || null;

  const periodEnd = typeof data.current_period_end === 'number'
    ? new Date(data.current_period_end * 1000).toISOString()
    : null;

  return {
    subscriptionId: data.id,
    subscriptionItemId,
    customerId: data.customer,
    status: data.status,
    tier,
    mode,
    priceId,
    billingPeriodEnd: periodEnd,
    cancelAtPeriodEnd: data.cancel_at_period_end === true,
  };
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
