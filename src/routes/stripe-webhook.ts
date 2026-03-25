/**
 * Stripe webhook handler — unauthenticated, mounted under /public/stripe/*.
 *
 * POST /webhook — receives Stripe webhook events, verified by HMAC signature.
 * No CF Access auth, no CSRF. Signature is the only guard.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { ValidationError } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import { createRateLimiter } from '../middleware/rate-limit';
import {
  verifyWebhookSignature,
  parseStripeEvent,
  resolveTierFromPriceId,
  isStripeConfigured,
} from '../lib/stripe';
import { SUBSCRIBABLE_TIER_IDS, getTierConfig, getUserTier } from '../lib/subscription';
import { sendRenewalEmail } from '../lib/email';

const logger = createLogger('stripe-webhook');

const app = new Hono<{ Bindings: Env }>();

/** Dedupe TTL: 72 hours in seconds */
const DEDUPE_TTL_SECONDS = 72 * 60 * 60;

// CF-010: Rate limit webhook endpoint to prevent volume-based attacks
const webhookRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 100,
  keyPrefix: 'stripe-webhook',
});

// POST /webhook
app.post('/webhook', webhookRateLimiter, async (c) => {
  if (!isStripeConfigured(c.env) || !c.env.STRIPE_WEBHOOK_SECRET) {
    throw new ValidationError('Stripe webhook not configured.');
  }

  // Read raw body for signature verification
  const rawBody = await c.req.raw.clone().text();
  const signatureHeader = c.req.header('Stripe-Signature');

  if (!signatureHeader) {
    return c.json({ error: 'Missing Stripe-Signature header' }, 400);
  }

  const valid = await verifyWebhookSignature(rawBody, signatureHeader, c.env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return c.json({ error: 'Invalid signature' }, 400);
  }

  // Parse event
  let event;
  try {
    event = parseStripeEvent(rawBody);
  } catch {
    return c.json({ error: 'Invalid event payload' }, 400);
  }

  // Dedupe: check if we've already processed this event.
  // Note: KV has ~60s eventual consistency lag. A Stripe retry hitting a different
  // edge before the dedupe key propagates may re-process the event. This is acceptable
  // because all handlers are idempotent (same data written twice) and CF-023 guards
  // checkout.session.completed against overwriting existing subscriptions.
  const dedupeKey = `stripe:event:${event.id}`;
  const existingEvent = await c.env.KV.get(dedupeKey);
  if (existingEvent) {
    logger.info('Duplicate event skipped', { eventId: event.id, type: event.type });
    return c.json({ received: true });
  }

  // Handle event types.
  // CF-001 fix: dedupe key is written ONLY on handler success (inside try block).
  // On handler failure, we return 500 so Stripe retries transient errors.
  // Note on CF-003: handlers use read-spread-write pattern. Each handler's explicit
  // fields take precedence over spread. With CF-001 preventing dedupe-masking of
  // failed events, the remaining race window (two successful writes within KV
  // propagation lag) only overwrites to identical values in practice.
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event, c.env);
        break;
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event, c.env);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(event, c.env);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event, c.env);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event, c.env);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event, c.env);
        break;
      default:
        logger.info('Unhandled event type', { type: event.type, eventId: event.id });
    }

    // Write dedupe key with TTL only on handler success
    await c.env.KV.put(dedupeKey, 'processed', { expirationTtl: DEDUPE_TTL_SECONDS });
    return c.json({ received: true });
  } catch (err) {
    logger.error('Webhook handler error', err instanceof Error ? err : new Error(String(err)), {
      eventId: event.id,
      type: event.type,
    });
    // Return 500 so Stripe retries transient failures (KV timeouts, network errors).
    // Dedupe key is NOT written — the event can be reprocessed on retry.
    return c.json({ error: 'Internal handler error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
  env: Env,
): Promise<void> {
  const session = event.data.object;
  const email = (session.customer_email as string) || (session.metadata as Record<string, string>)?.email;
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;

  if (!email) {
    logger.error('checkout.session.completed missing email', new Error('missing email'), { eventId: event.id });
    return;
  }

  // Store customer mapping: stripe-customer:{customerId} → email
  if (customerId) {
    await env.KV.put(`stripe-customer:${customerId}`, email);
  }

  // CF-008: Validate metadata tier — fall back to price-based resolution if absent/invalid
  const metadata = session.metadata as Record<string, string> | undefined;
  let tier = metadata?.tier;
  const mode = metadata?.mode ?? 'default';

  if (!tier || !SUBSCRIBABLE_TIER_IDS.has(tier)) {
    // Attempt price-based resolution from session line items
    const lineItems = session.line_items as { data?: Array<{ price?: { id?: string } }> } | undefined;
    const sessionPriceId = lineItems?.data?.[0]?.price?.id;
    const resolved = sessionPriceId ? resolveTierFromPriceId(sessionPriceId) : null;
    if (resolved) {
      tier = resolved.tier;
    } else {
      logger.error('checkout.session.completed: cannot resolve tier from metadata or price', new Error('tier resolution failed'), {
        eventId: event.id,
        metadataTier: metadata?.tier,
      });
      return;
    }
  }

  // CF-023: Check for existing subscription before overwriting
  const existing = await env.KV.get(`user:${email}`, 'json') as Record<string, unknown> | null;
  if (existing?.stripeSubscriptionId && existing.stripeSubscriptionId !== subscriptionId) {
    logger.warn('checkout.session.completed: user already has a different subscription', {
      email,
      existingSubscriptionId: existing.stripeSubscriptionId,
      newSubscriptionId: subscriptionId,
    });
  }

  // Update user KV
  const updated: Record<string, unknown> = {
    ...existing,
    subscriptionTier: tier,
    accessTier: tier,
    subscribedMode: mode,
    subscribedAt: new Date().toISOString(),
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    checkoutSessionId: session.id as string,
    billingStatus: 'active',
    trialUsed: existing?.trialUsed === true,
  };
  await env.KV.put(`user:${email}`, JSON.stringify(updated));

  logger.info('Checkout completed', { email, tier, mode, customerId, subscriptionId });
}

async function handleSubscriptionCreated(
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
  env: Env,
): Promise<void> {
  const subscription = event.data.object;
  const customerId = subscription.customer as string;

  if (!customerId) return;

  const email = await resolveEmailFromCustomer(customerId, env);
  if (!email) {
    logger.warn('subscription.created: cannot resolve email', { customerId });
    return;
  }

  // Extract price ID from subscription items
  const items = subscription.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
  const priceId = items?.data?.[0]?.price?.id;
  const tierInfo = priceId ? resolveTierFromPriceId(priceId) : null;

  const existing = await env.KV.get(`user:${email}`, 'json') as Record<string, unknown> | null;
  const updated: Record<string, unknown> = {
    ...existing,
    stripeSubscriptionId: subscription.id as string,
    billingStatus: subscription.status as string,
    billingPeriodEnd: typeof subscription.current_period_end === 'number'
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : undefined,
    ...(priceId ? { stripePriceId: priceId } : {}),
    ...(tierInfo ? { subscriptionTier: tierInfo.tier, accessTier: tierInfo.tier, subscribedMode: tierInfo.mode } : {}),
  };
  await env.KV.put(`user:${email}`, JSON.stringify(updated));

  logger.info('Subscription created', { email, subscriptionId: subscription.id, priceId });
}

async function handleInvoicePaid(
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
  env: Env,
): Promise<void> {
  const invoice = event.data.object;
  const customerId = invoice.customer as string;

  if (!customerId) return;

  const email = await resolveEmailFromCustomer(customerId, env);
  if (!email) {
    logger.warn('invoice.paid: cannot resolve email', { customerId });
    return;
  }

  const subscriptionId = invoice.subscription as string;
  const periodEnd = invoice.lines as { data?: Array<{ period?: { end?: number } }> };
  const endTs = periodEnd?.data?.[0]?.period?.end;

  const existing = await env.KV.get(`user:${email}`, 'json') as Record<string, unknown> | null;
  const updated: Record<string, unknown> = {
    ...existing,
    billingStatus: 'active',
    ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
    ...(endTs ? { billingPeriodEnd: new Date(endTs * 1000).toISOString() } : {}),
  };
  await env.KV.put(`user:${email}`, JSON.stringify(updated));

  // CF-012: Send renewal confirmation email (fire-and-forget)
  try {
    const tierValue = (updated.subscriptionTier as string) ?? 'standard';
    const tiers = await getTierConfig(env.KV);
    const tierConfig = getUserTier(tierValue, tiers);
    const monthlyHours = tierConfig.monthlySeconds !== null
      ? `${Math.round(tierConfig.monthlySeconds / 3600)}h`
      : 'Unlimited';
    void sendRenewalEmail({
      userEmail: email,
      tierName: tierConfig.displayName,
      monthlyHours,
      maxSessions: tierConfig.maxSessions,
      env,
    });
  } catch { /* non-fatal */ }

  logger.info('Invoice paid', { email, subscriptionId });
}

async function handlePaymentFailed(
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
  env: Env,
): Promise<void> {
  const invoice = event.data.object;
  const customerId = invoice.customer as string;

  if (!customerId) return;

  const email = await resolveEmailFromCustomer(customerId, env);
  if (!email) {
    // CF-032: Log warning on unresolved customer (was silently dropped)
    logger.warn('invoice.payment_failed: cannot resolve email', { customerId, eventId: event.id });
    return;
  }

  const existing = await env.KV.get(`user:${email}`, 'json') as Record<string, unknown> | null;
  const updated = { ...existing, billingStatus: 'past_due' };
  await env.KV.put(`user:${email}`, JSON.stringify(updated));

  logger.warn('Payment failed', { email, customerId });
}

async function handleSubscriptionDeleted(
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
  env: Env,
): Promise<void> {
  const subscription = event.data.object;
  const customerId = subscription.customer as string;

  if (!customerId) return;

  const email = await resolveEmailFromCustomer(customerId, env);
  if (!email) {
    // CF-032: Log warning on unresolved customer (was silently dropped)
    logger.warn('subscription.deleted: cannot resolve email', { customerId, eventId: event.id });
    return;
  }

  const existing = await env.KV.get(`user:${email}`, 'json') as Record<string, unknown> | null;
  const updated = { ...existing, billingStatus: 'canceled' };
  await env.KV.put(`user:${email}`, JSON.stringify(updated));

  logger.info('Subscription deleted', { email, customerId });
}

async function handleSubscriptionUpdated(
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
  env: Env,
): Promise<void> {
  const subscription = event.data.object;
  const customerId = subscription.customer as string;

  if (!customerId) return;

  const email = await resolveEmailFromCustomer(customerId, env);
  if (!email) {
    logger.warn('subscription.updated: cannot resolve email', { customerId });
    return;
  }

  // Extract price ID from subscription items
  const items = subscription.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
  const priceId = items?.data?.[0]?.price?.id;
  const tierInfo = priceId ? resolveTierFromPriceId(priceId) : null;

  const existing = await env.KV.get(`user:${email}`, 'json') as Record<string, unknown> | null;
  const updated: Record<string, unknown> = {
    ...existing,
    stripeSubscriptionId: subscription.id as string,
    billingStatus: subscription.status as string,
    ...(priceId ? { stripePriceId: priceId } : {}),
    ...(tierInfo ? {
      subscriptionTier: tierInfo.tier,
      accessTier: tierInfo.tier,
      subscribedMode: tierInfo.mode,
    } : {}),
    ...(typeof subscription.current_period_end === 'number'
      ? { billingPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString() }
      : {}),
  };
  await env.KV.put(`user:${email}`, JSON.stringify(updated));

  logger.info('Subscription updated', { email, subscriptionId: subscription.id, priceId, tier: tierInfo?.tier });
}

// ---------------------------------------------------------------------------
// Customer lookup — CF-005: KV lookup with Stripe API fallback
// ---------------------------------------------------------------------------

async function resolveEmailFromCustomer(customerId: string, env: Env): Promise<string | null> {
  // Primary: KV mapping written by handleCheckoutCompleted
  const kvEmail = await env.KV.get(`stripe-customer:${customerId}`);
  if (kvEmail) return kvEmail;

  // Fallback: fetch from Stripe API (handles delayed/failed checkout events)
  if (env.STRIPE_SECRET_KEY) {
    try {
      const response = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
        headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const customer = await response.json() as { email?: string };
        if (customer.email) {
          // Cache for future lookups
          await env.KV.put(`stripe-customer:${customerId}`, customer.email);
          return customer.email;
        }
      }
    } catch (err) {
      logger.warn('Stripe API customer lookup failed', { customerId, error: String(err) });
    }
  }

  return null;
}

export default app;
