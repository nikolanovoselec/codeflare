/**
 * Stripe webhook handler — unauthenticated, mounted under /public/stripe/*.
 *
 * POST /webhook — receives Stripe webhook events, verified by HMAC signature.
 * No CF Access auth, no CSRF, no rate limiting. Signature is the only guard.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { ValidationError } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import {
  verifyWebhookSignature,
  parseStripeEvent,
  resolveTierFromPriceId,
  isStripeConfigured,
} from '../lib/stripe';

const logger = createLogger('stripe-webhook');

const app = new Hono<{ Bindings: Env }>();

/** Dedupe TTL: 72 hours in seconds */
const DEDUPE_TTL_SECONDS = 72 * 60 * 60;

// POST /webhook
app.post('/webhook', async (c) => {
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

  // Dedupe: check if we've already processed this event
  const dedupeKey = `stripe:event:${event.id}`;
  const existing = await c.env.KV.get(dedupeKey);
  if (existing) {
    logger.info('Duplicate event skipped', { eventId: event.id, type: event.type });
    return c.json({ received: true });
  }

  // Handle event types
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
      default:
        logger.info('Unhandled event type', { type: event.type, eventId: event.id });
    }
  } catch (err) {
    logger.error('Webhook handler error', err instanceof Error ? err : new Error(String(err)), {
      eventId: event.id,
      type: event.type,
    });
    // Return 200 to prevent Stripe retries for handler errors
    // (we logged the error; Stripe retrying won't help)
  }

  // Write dedupe key with TTL
  await c.env.KV.put(dedupeKey, 'processed', { expirationTtl: DEDUPE_TTL_SECONDS });

  return c.json({ received: true });
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

  // Resolve tier from metadata or price
  const metadata = session.metadata as Record<string, string> | undefined;
  const tier = metadata?.tier ?? 'standard';
  const mode = metadata?.mode ?? 'default';

  // Update user KV
  const existing = await env.KV.get(`user:${email}`, 'json') as Record<string, unknown> | null;
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
    trialBillingTriggered: false,
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
  if (!email) return;

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
  if (!email) return;

  const existing = await env.KV.get(`user:${email}`, 'json') as Record<string, unknown> | null;
  const updated = { ...existing, billingStatus: 'canceled' };
  await env.KV.put(`user:${email}`, JSON.stringify(updated));

  logger.info('Subscription deleted', { email, customerId });
}

// ---------------------------------------------------------------------------
// Customer lookup
// ---------------------------------------------------------------------------

async function resolveEmailFromCustomer(customerId: string, env: Env): Promise<string | null> {
  return env.KV.get(`stripe-customer:${customerId}`);
}

export default app;
