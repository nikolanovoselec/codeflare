/**
 * Billing routes — authenticated endpoints for Stripe checkout and status.
 *
 * POST /billing/checkout — create a Stripe Checkout Session for a paid tier
 * GET  /billing/status   — return billing fields for the current user
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { BILLING_STATUS } from '../types';
import { requireIdentity, type AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { ValidationError, ForbiddenError, toError } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import { parseUserRecord, updateUserRecord } from '../lib/user-record';
import { getTierConfig, countPaidSlots, isEnterpriseMode } from '../lib/subscription';
import { getBaseUrl, getNextUtcMonthStart, SETUP_KEYS } from '../lib/kv-keys';
import { getAllUsers } from '../lib/access-policy';
import {
  getStripePriceId,
  createCheckoutSession,
  createPortalSession,
  createSwitchPortalSession,
  fetchSubscription,
} from '../lib/stripe';
import { getCurrencyForCountry } from '../lib/currency';
import { parseJsonBody } from '../lib/request-helpers';

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
  // REQ-ENTERPRISE-009: no self-serve billing in enterprise mode (no-op when flag unset).
  if (isEnterpriseMode(c.env)) {
    throw new ForbiddenError('Billing is not available in enterprise mode');
  }
  // CF-006: Explicit null check instead of non-null assertion
  const secretKey = c.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new ValidationError('Stripe is not configured.');
  }

  const user = c.get('user');

  // Max users cap — block new checkouts when capacity is reached
  const userData = await c.env.KV.get(`user:${user.email}`, 'json') as Record<string, unknown> | null;
  const isAlreadySubscribed = !!userData?.subscribedAt;
  if (!isAlreadySubscribed) {
    const maxUsers = parseInt(await c.env.KV.get(SETUP_KEYS.MAX_USERS) ?? '0');
    if (maxUsers > 0) {
      const allUsers = await getAllUsers(c.env.KV);
      if (countPaidSlots(allUsers) >= maxUsers) {
        throw new ValidationError('Subscriptions are currently full. Please try again later.');
      }
    }
  }

  const { tier, mode } = await parseJsonBody(c, CheckoutSchema);

  // Free tier doesn't go through Stripe
  if (tier === 'free') {
    throw new ValidationError('Free tier does not require payment.');
  }

  // CF-007: Fetch tiers BEFORE priceId lookup so KV-configured price IDs are used
  const tiers = await getTierConfig(c.env.KV);
  const priceId = getStripePriceId(tier, mode, tiers);
  if (!priceId) {
    throw new ValidationError(`No Stripe price found for tier "${tier}" mode "${mode}".`);
  }

  // Build success/cancel URLs using custom domain or request origin
  const baseUrl = await getBaseUrl(c.env.KV, c.req.url);
  const successUrl = `${baseUrl}/app/subscribe?checkout=success`;
  const cancelUrl = `${baseUrl}/app/subscribe?checkout=canceled`;

  // Check if user has already used their trial — if not, include 7-day trial window
  // (actual compute is capped by trialQuotaHours in tier config; Stripe trial is just the billing window)
  const trialUsed = userData?.trialUsed === true;
  const tierConfig = tiers.find(t => t.id === tier);
  const trialQuotaHours = tierConfig?.trialQuotaHours ?? 4;

  // REQ-SUB-020: detect visitor currency from Cloudflare geo header
  const country = c.req.header('CF-IPCountry') || '';
  const currency = getCurrencyForCountry(country);

  // Stripe requires billing_cycle_anchor >= trial_end, so compute the anchor
  // relative to the end of the trial (or now, if no trial).
  const trialDays = trialUsed ? 0 : 7;
  const anchorRef = new Date(Date.now() + trialDays * 86400_000 + 1000);
  const billingCycleAnchor = getNextUtcMonthStart(anchorRef);

  const session = await createCheckoutSession({
    priceId,
    customerEmail: user.email,
    successUrl,
    cancelUrl,
    secretKey,
    metadata: { tier, mode, email: user.email },
    trialDays: trialUsed ? undefined : 7,
    trialQuotaHours: trialUsed ? undefined : trialQuotaHours,
    currency,
    billingCycleAnchor,
  });

  // Store checkoutSessionId on user KV (non-fatal)
  try {
    await updateUserRecord(c.env.KV, user.email, { checkoutSessionId: session.id });
  } catch (err) {
    logger.error('Failed to store checkoutSessionId', toError(err));
  }

  logger.info('Checkout session created', { email: user.email, tier, mode, sessionId: session.id });
  return c.json({ checkoutUrl: session.url });
});

// GET /billing/status — returns live billing state from Stripe (source of truth)
app.get('/status', requireIdentity, async (c) => {
  // REQ-ENTERPRISE-009: enterprise has no billing — return an empty/disabled state
  // (200, not 403) so any client still polling the endpoint does not error.
  if (isEnterpriseMode(c.env)) {
    return c.json({
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripePriceId: null,
      billingPeriodEnd: null,
      checkoutSessionId: null,
      billingStatus: null,
    });
  }
  const user = c.get('user');
  const raw = await c.env.KV.get(`user:${user.email}`, 'json');
  const userData = parseUserRecord(raw);
  const subscriptionId = userData?.stripeSubscriptionId as string | undefined;
  const secretKey = c.env.STRIPE_SECRET_KEY;

  // If user has a subscription ID and Stripe is configured, verify it still exists
  if (subscriptionId && secretKey) {
    try {
      const snapshot = await fetchSubscription(subscriptionId, secretKey);
      if (!snapshot) {
        // Subscription gone from Stripe — return cleared state
        // Clean up billing fields in KV (non-blocking). Only reset billing
        // fields — never touch identity fields (addedBy, addedAt, role).
        void updateUserRecord(c.env.KV, user.email, {
          subscriptionTier: 'pending',
          accessTier: 'pending',
          billingStatus: BILLING_STATUS.CANCELED,
        });
        return c.json({
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          stripePriceId: null,
          billingPeriodEnd: null,
          checkoutSessionId: userData?.checkoutSessionId ?? null,
          billingStatus: null,
        });
      }
      // Return live Stripe state
      return c.json({
        stripeCustomerId: snapshot.customerId,
        stripeSubscriptionId: snapshot.subscriptionId,
        stripePriceId: snapshot.priceId,
        billingPeriodEnd: snapshot.billingPeriodEnd,
        checkoutSessionId: userData?.checkoutSessionId ?? null,
        billingStatus: snapshot.status,
      });
    } catch (err) {
      logger.warn('Stripe API error in billing status — falling back to KV', { error: String(err) });
    }
  }

  // No subscription or Stripe not configured — return KV data
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
  // REQ-ENTERPRISE-009: no customer portal in enterprise mode (no-op when flag unset).
  if (isEnterpriseMode(c.env)) {
    throw new ForbiddenError('Billing portal is not available in enterprise mode');
  }
  // CF-006: Explicit null check instead of non-null assertion
  const secretKey = c.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new ValidationError('Stripe is not configured.');
  }

  const user = c.get('user');
  const raw = await c.env.KV.get(`user:${user.email}`, 'json');
  const userData = parseUserRecord(raw);
  const customerId = userData?.stripeCustomerId as string | undefined;

  if (!customerId) {
    throw new ValidationError('No active Stripe subscription found.');
  }

  const baseUrl = await getBaseUrl(c.env.KV, c.req.url);
  const returnUrl = `${baseUrl}/app/subscribe`;

  const session = await createPortalSession({
    customerId,
    returnUrl,
    secretKey,
  });

  logger.info('Portal session created', { email: user.email, sessionId: session.id });
  return c.json({ portalUrl: session.url });
});

// Rate limit switch: 5 per minute per user
const switchRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 5,
  keyPrefix: 'billing-switch',
});

const SwitchSchema = z.object({
  tier: z.string().min(1, 'Tier is required'),
  mode: z.enum(['default', 'advanced']).optional().default('default'),
});

// POST /billing/switch — deep-link portal to plan change confirmation
app.post('/switch', requireIdentity, switchRateLimiter, async (c) => {
  // REQ-ENTERPRISE-009: no plan switching in enterprise mode (no-op when flag unset).
  if (isEnterpriseMode(c.env)) {
    throw new ForbiddenError('Plan switching is not available in enterprise mode');
  }
  const secretKey = c.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new ValidationError('Stripe is not configured.');
  }

  const user = c.get('user');

  const { tier, mode } = await parseJsonBody(c, SwitchSchema);

  if (tier === 'free') {
    throw new ValidationError('Use the Customer Portal to cancel or downgrade to free.');
  }

  // Look up user's existing subscription
  const userData = parseUserRecord(await c.env.KV.get(`user:${user.email}`, 'json'));
  const customerId = userData?.stripeCustomerId as string | undefined;
  const subscriptionId = userData?.stripeSubscriptionId as string | undefined;

  if (!customerId || !subscriptionId) {
    throw new ValidationError('No active subscription found. Use checkout to subscribe.');
  }

  // Resolve the new price ID
  const tiers = await getTierConfig(c.env.KV);
  const newPriceId = getStripePriceId(tier, mode, tiers);
  if (!newPriceId) {
    throw new ValidationError(`No Stripe price found for tier "${tier}" mode "${mode}".`);
  }

  // Fetch subscription to get the subscription item ID (si_xxx)
  const snapshot = await fetchSubscription(subscriptionId, secretKey);
  if (!snapshot) {
    // Subscription no longer exists on Stripe — clean up billing fields in KV.
    // Only reset billing fields — never touch identity fields (addedBy, addedAt, role).
    logger.warn('Stale subscription in KV, cleaning up', { email: user.email, subscriptionId });
    await updateUserRecord(c.env.KV, user.email, {
      subscriptionTier: 'pending',
      accessTier: 'pending',
      billingStatus: BILLING_STATUS.CANCELED,
    });
    throw new ValidationError('Subscription expired. Redirecting to checkout.');
  }
  if (!snapshot.subscriptionItemId) {
    throw new ValidationError('Could not resolve subscription details from Stripe.');
  }

  const baseUrl = await getBaseUrl(c.env.KV, c.req.url);
  const returnUrl = `${baseUrl}/app/`;

  const session = await createSwitchPortalSession({
    customerId,
    subscriptionId,
    subscriptionItemId: snapshot.subscriptionItemId,
    newPriceId,
    returnUrl,
    secretKey,
  });

  logger.info('Switch portal session created', { email: user.email, tier, mode, sessionId: session.id });
  return c.json({ portalUrl: session.url });
});

export default app;
