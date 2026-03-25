/**
 * Billing routes — authenticated endpoints for Stripe checkout and status.
 *
 * POST /billing/checkout — create a Stripe Checkout Session for a paid tier
 * GET  /billing/status   — return billing fields for the current user
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { requireIdentity, type AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { ValidationError } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import {
  isStripeConfigured,
  getStripePriceId,
  createCheckoutSession,
  createPortalSession,
} from '../lib/stripe';

const logger = createLogger('billing');

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Rate limit checkout creation: 5 per minute per user
const checkoutRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 5,
  keyPrefix: 'billing-checkout',
});

const CheckoutSchema = z.object({
  tier: z.string().min(1, 'Tier is required'),
  mode: z.enum(['default', 'advanced']).optional().default('default'),
});

// POST /billing/checkout
app.post('/checkout', requireIdentity, checkoutRateLimiter, async (c) => {
  if (!isStripeConfigured(c.env)) {
    throw new ValidationError('Stripe is not configured.');
  }

  const user = c.get('user');

  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new ValidationError('Invalid JSON body'); }

  const parsed = CheckoutSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

  const { tier, mode } = parsed.data;

  // Free tier doesn't go through Stripe
  if (tier === 'free') {
    throw new ValidationError('Free tier does not require payment.');
  }

  const priceId = getStripePriceId(tier, mode);
  if (!priceId) {
    throw new ValidationError(`No Stripe price found for tier "${tier}" mode "${mode}".`);
  }

  // Build success/cancel URLs using custom domain or request origin
  const customDomain = await c.env.KV.get('setup:custom_domain');
  const baseUrl = customDomain ? `https://${customDomain}` : new URL(c.req.url).origin;
  const successUrl = `${baseUrl}/app/subscribe?checkout=success`;
  const cancelUrl = `${baseUrl}/app/subscribe?checkout=canceled`;

  const session = await createCheckoutSession({
    priceId,
    customerEmail: user.email,
    successUrl,
    cancelUrl,
    secretKey: c.env.STRIPE_SECRET_KEY!,
    metadata: { tier, mode, email: user.email },
  });

  // Store checkoutSessionId on user KV (non-fatal)
  try {
    const existing = await c.env.KV.get(`user:${user.email}`, 'json') as Record<string, unknown> | null;
    const updated = { ...existing, checkoutSessionId: session.id };
    await c.env.KV.put(`user:${user.email}`, JSON.stringify(updated));
  } catch (err) {
    logger.error('Failed to store checkoutSessionId', err instanceof Error ? err : new Error(String(err)));
  }

  logger.info('Checkout session created', { email: user.email, tier, mode, sessionId: session.id });
  return c.json({ checkoutUrl: session.url });
});

// GET /billing/status
app.get('/status', requireIdentity, async (c) => {
  const user = c.get('user');
  const userData = await c.env.KV.get(`user:${user.email}`, 'json') as Record<string, unknown> | null;

  return c.json({
    stripeCustomerId: userData?.stripeCustomerId ?? null,
    stripeSubscriptionId: userData?.stripeSubscriptionId ?? null,
    stripePriceId: userData?.stripePriceId ?? null,
    billingPeriodEnd: userData?.billingPeriodEnd ?? null,
    checkoutSessionId: userData?.checkoutSessionId ?? null,
    billingStatus: userData?.billingStatus ?? null,
  });
});

// Rate limit portal creation: 5 per minute per user
const portalRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 5,
  keyPrefix: 'billing-portal',
});

// POST /billing/portal — create a Stripe Customer Portal session
app.post('/portal', requireIdentity, portalRateLimiter, async (c) => {
  if (!isStripeConfigured(c.env)) {
    throw new ValidationError('Stripe is not configured.');
  }

  const user = c.get('user');
  const userData = await c.env.KV.get(`user:${user.email}`, 'json') as Record<string, unknown> | null;
  const customerId = userData?.stripeCustomerId as string | undefined;

  if (!customerId) {
    throw new ValidationError('No active Stripe subscription found.');
  }

  const customDomain = await c.env.KV.get('setup:custom_domain');
  const baseUrl = customDomain ? `https://${customDomain}` : new URL(c.req.url).origin;
  const returnUrl = `${baseUrl}/app/subscribe`;

  const session = await createPortalSession({
    customerId,
    returnUrl,
    secretKey: c.env.STRIPE_SECRET_KEY!,
  });

  logger.info('Portal session created', { email: user.email, sessionId: session.id });
  return c.json({ portalUrl: session.url });
});

export default app;
