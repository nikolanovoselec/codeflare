/**
 * Stripe webhook handler - unauthenticated, mounted under /public/stripe/*.
 *
 * POST /webhook - receives Stripe webhook events, verified by HMAC signature.
 * No CF Access auth, no CSRF. Signature is the only guard.
 *
 * Signal and Sync pattern: webhooks are signals that trigger a fetch of the
 * latest state from the Stripe API. KV is a read cache, not the source of truth.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { BILLING_STATUS } from '../types';
import { ValidationError, toError } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import { createRateLimiter } from '../middleware/rate-limit';
import {
  verifyWebhookSignature,
  parseStripeEvent,
  isStripeConfigured,
  fetchSubscription,
  resolveTierFromPriceId,
} from '../lib/stripe';
import { updateUserRecord, parseUserRecord } from '../lib/user-record';
import { reconcileAgentConfigs } from '../lib/r2-seed';
import { getR2Config } from '../lib/r2-config';
import { getBucketName } from '../lib/access';
import { getPreferencesKey } from '../lib/kv-keys';
import { getAdminEmails } from '../lib/access-policy';
import { sendSubscriptionAdminNotification, sendSubscriptionEmail } from '../lib/email';
import { getBaseUrl } from '../lib/kv-keys';
import { getTierConfig, getUserTier, getEffectiveTier } from '../lib/subscription';
import { resolveUserFromKV } from '../lib/access';

const logger = createLogger('stripe-webhook');

const app = new Hono<{ Bindings: Env }>();

/** Dedupe TTL: 72 hours in seconds */
const DEDUPE_TTL_SECONDS = 72 * 60 * 60;

// CF-010: Rate limit webhook endpoint to prevent volume-based attacks.
// CF-012: This limiter runs before signature verification and keys on a spoofable
// CF-Connecting-IP fallback, so the budget is tightened (was 100/min) to bound how
// much a spoofed IP can burn before the signature check rejects the payload.
// CF-006: failClosed so a KV outage cannot fail open and remove this guard on an
// unauthenticated mutation endpoint (see AD66).
const webhookRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: 'stripe-webhook',
  failClosed: true,
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
  // because all handlers are idempotent - syncSubscriptionState fetches the same
  // latest state from Stripe regardless of how many times it runs.
  const dedupeKey = `stripe:event:${event.id}`;
  const existingEvent = await c.env.KV.get(dedupeKey);
  if (existingEvent) {
    logger.info('Duplicate event skipped', { eventId: event.id, type: event.type });
    return c.json({ received: true });
  }

  // Handle event types.
  // CF-001 fix: dedupe key is written ONLY on handler success (inside try block).
  // On handler failure, we return 500 so Stripe retries transient errors.
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event, c.env);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event, c.env);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event, c.env);
        break;
      default:
        logger.info('Unhandled event type', { type: event.type, eventId: event.id });
    }

    // Write dedupe key with TTL only on handler success
    await c.env.KV.put(dedupeKey, 'processed', { expirationTtl: DEDUPE_TTL_SECONDS });
    return c.json({ received: true });
  } catch (err) {
    logger.error('Webhook handler error', toError(err), {
      eventId: event.id,
      type: event.type,
    });
    // Return 500 so Stripe retries transient failures (KV timeouts, network errors).
    // Dedupe key is NOT written - the event can be reprocessed on retry.
    return c.json({ error: 'Internal handler error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// Event handlers - Signal and Sync (3 handlers, reduced from 6)
// ---------------------------------------------------------------------------

/**
 * checkout.session.completed - initial subscription setup.
 * Maps email→customer in KV, writes subscribedAt/checkoutSessionId,
 * then calls syncSubscriptionState for tier/billing fields.
 */
async function handleCheckoutCompleted(
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
  env: Env,
): Promise<void> {
  const session = event.data.object;
  // CF-011: Prefer metadata.email (CF Access-verified) over customer_email (user-controlled Stripe form)
  const email = (session.metadata as Record<string, string>)?.email || (session.customer_email as string);
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

  // CF-023: Check for existing subscription before overwriting
  const existing = parseUserRecord(await env.KV.get(`user:${email}`, 'json'));
  if (existing?.stripeSubscriptionId && existing.stripeSubscriptionId !== subscriptionId) {
    logger.warn('checkout.session.completed: user already has a different subscription', {
      email,
      existingSubscriptionId: existing.stripeSubscriptionId,
      newSubscriptionId: subscriptionId,
    });
  }

  // Write checkout-specific fields that only exist at checkout time
  await updateUserRecord(env.KV, email, {
    subscribedAt: new Date().toISOString(),
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    checkoutSessionId: session.id as string,
    trialUsed: existing?.trialUsed === true,
  });

  // Sync full subscription state from Stripe API (tier, billing, period)
  await syncSubscriptionState(customerId, subscriptionId, env);

  // Note: Stripe handles customer receipt emails via Dashboard > Customer emails
  // settings ("Successful payments" toggle). We don't send invoices programmatically
  // because subscriptions use collection_method=charge_automatically, and
  // POST /v1/invoices/{id}/send only works for collection_method=send_invoice.

  // Send user confirmation + admin notification (best-effort)
  try {
    const updatedUser = await resolveUserFromKV(env.KV, email);
    const tiers = await getTierConfig(env.KV);
    const tier = getUserTier(
      getEffectiveTier(updatedUser?.subscriptionTier, updatedUser?.accessTier, updatedUser?.billingStatus, updatedUser?.billingPeriodEnd),
      tiers,
    );
    const monthlyHours = tier.monthlySeconds != null
      ? String(Math.round(tier.monthlySeconds / 3600))
      : 'Unlimited';
    const subscribedAt = new Date().toISOString();
    const instanceUrl = await getBaseUrl(env.KV, '');

    // User confirmation email
    void sendSubscriptionEmail({
      userEmail: email,
      tierName: tier.displayName || tier.id,
      sessionMode: updatedUser?.subscribedMode ?? 'default',
      monthlyHours,
      maxSessions: tier.maxSessions,
      trialHours: 0,
      subscribedAt,
      instanceUrl: instanceUrl || undefined,
      env,
    });

    // Admin notification
    const adminEmails = await getAdminEmails(env.KV);
    if (adminEmails.length > 0) {
      void sendSubscriptionAdminNotification({
        userEmail: email,
        tierName: tier.displayName || tier.id,
        sessionMode: updatedUser?.subscribedMode ?? 'default',
        monthlyHours,
        maxSessions: tier.maxSessions,
        subscribedAt,
        adminEmails,
        env,
      });
    }
  } catch {
    // Non-fatal - emails are best-effort
  }

  logger.info('Checkout completed', { email, customerId, subscriptionId });
}

/**
 * customer.subscription.updated - plan changes, renewals, payment status changes.
 * Delegates entirely to syncSubscriptionState.
 */
async function handleSubscriptionUpdated(
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
  env: Env,
): Promise<void> {
  const subscription = event.data.object;
  const customerId = subscription.customer as string;
  const subscriptionId = subscription.id as string;

  if (!customerId) return;

  await syncSubscriptionState(customerId, subscriptionId, env);

  logger.info('Subscription updated (synced)', { customerId, subscriptionId });
}

/**
 * customer.subscription.deleted - subscription canceled/expired.
 * Writes directly (can't fetch a deleted subscription from Stripe API).
 */
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

  // CF-004: Reset tiers to 'free' so all enforcement paths (including raw field reads) deny access.
  // Also reset subscribedMode to 'default' so code reading subscribedMode from KV
  // doesn't see stale 'advanced' after the subscription is gone.
  await updateUserRecord(env.KV, email, {
    billingStatus: BILLING_STATUS.CANCELED,
    subscriptionTier: 'free',
    accessTier: 'free',
    subscribedMode: 'default',
  });

  // Auto-reconcile preseed to default mode - subscription actually terminated
  // (period ended after cancel, or immediate revocation). This does NOT fire
  // when user initiates cancellation (that's cancel_at_period_end: true on
  // subscription.updated, which keeps the subscription active).
  try {
    const bucketName = getBucketName(email);
    const { endpoint } = await getR2Config(env);
    // Subscription is gone, user is no longer Custom-tier, so the gate is
    // explicitly closed. cleanup: true also removes any context-mode files
    // already in the bucket via the mode filter (advanced-only keys), but
    // we make the gate explicit at every reconcile call site for consistency.
    await reconcileAgentConfigs(env, bucketName, endpoint, 'default', {
      overwrite: true,
      cleanup: true,
      contextModeEnabled: false,
    });
    const prefsKey = getPreferencesKey(bucketName);
    const prefs = await env.KV.get(prefsKey, 'json') as Record<string, unknown> | null;
    await env.KV.put(prefsKey, JSON.stringify({ ...prefs, sessionMode: 'default' }));
    logger.info('Auto-reconciled agent configs on subscription deletion', { email });
  } catch (err) {
    logger.warn('Auto-reconcile on subscription deletion failed (non-fatal)', { error: String(err) });
  }

  logger.info('Subscription deleted', { email, customerId });
}

// ---------------------------------------------------------------------------
// Signal and Sync - fetch latest state from Stripe API and write to KV
// ---------------------------------------------------------------------------

/**
 * Fetch subscription state from Stripe API and write a complete snapshot to KV.
 * Timestamp-guarded: skips write if KV's lastSyncedAt is newer.
 * Preserves existing KV fields (addedBy, onboardingComplete, etc.).
 * Preserves tier/mode when price metadata is null (avoids blanking).
 */
export async function syncSubscriptionState(
  customerId: string,
  subscriptionId: string,
  env: Env,
): Promise<void> {
  // 1. Resolve email from customer ID
  const email = await resolveEmailFromCustomer(customerId, env);
  if (!email) {
    logger.warn('syncSubscriptionState: cannot resolve email', { customerId, subscriptionId });
    return;
  }

  // 2. Fetch subscription from Stripe API
  if (!env.STRIPE_SECRET_KEY) {
    logger.warn('syncSubscriptionState: STRIPE_SECRET_KEY not configured', { subscriptionId });
    return;
  }
  const snapshot = await fetchSubscription(subscriptionId, env.STRIPE_SECRET_KEY);
  if (!snapshot) {
    logger.warn('syncSubscriptionState: subscription not found', { subscriptionId });
    return;
  }

  // 3. Timestamp guard: skip if KV's lastSyncedAt >= now
  const existing = parseUserRecord(await env.KV.get(`user:${email}`, 'json'));
  const now = new Date().toISOString();
  if (existing?.lastSyncedAt && existing.lastSyncedAt > now) {
    logger.info('syncSubscriptionState: skipped (KV lastSyncedAt is newer)', {
      email, kvLastSynced: existing.lastSyncedAt,
    });
    return;
  }

  // 4. Build patch from snapshot - only set tier/mode if not null (preserve existing)
  const patch: Record<string, unknown> = {
    stripeSubscriptionId: snapshot.subscriptionId,
    stripeCustomerId: snapshot.customerId,
    billingStatus: snapshot.status,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    lastSyncedAt: now,
  };

  if (snapshot.tier !== null) {
    patch.subscriptionTier = snapshot.tier;
    patch.accessTier = snapshot.tier;
  }
  // Derive the subscribed mode (Standard='default' / Pro='advanced') from the
  // Stripe price. Prefer the price's `metadata.mode`; when absent - the common
  // case, because admins configure prices via the tier-config
  // stripePriceId/stripeAdvancedPriceId slots rather than per-price metadata -
  // fall back to the price slot via resolveTierFromPriceId. Without this
  // fallback a Standard<->Pro subscription change leaves subscribedMode stale,
  // so the mode-change reconcile in step 6 (skill recreation + sessionMode
  // preference flip) never fires (REQ-SUB-015 AC6).
  let resolvedMode = snapshot.mode;
  if (resolvedMode === null && snapshot.priceId !== null) {
    const resolved = resolveTierFromPriceId(snapshot.priceId, await getTierConfig(env.KV));
    if (resolved) resolvedMode = resolved.mode;
  }
  if (resolvedMode !== null) {
    patch.subscribedMode = resolvedMode;
  }
  if (snapshot.priceId !== null) {
    patch.stripePriceId = snapshot.priceId;
  }
  if (snapshot.billingPeriodEnd !== null) {
    patch.billingPeriodEnd = snapshot.billingPeriodEnd;
  }
  // HIGH-1: Mark trial as used when status transitions away from trialing.
  // Prevents unlimited free trials via subscribe→cancel→resubscribe.
  if (snapshot.status !== 'trialing') {
    patch.trialUsed = true;
  }

  // 5. Write via updateUserRecord (preserves existing fields)
  await updateUserRecord(env.KV, email, patch);

  // 6. Auto-reconcile on mode change: if subscribedMode changed between
  // advanced and default in either direction, reconcile R2 preseed files
  // so the next session picks up the correct skills/agents/rules.
  const previousMode = existing?.subscribedMode ?? 'default';
  const newMode = (patch.subscribedMode as string) ?? previousMode;
  if (previousMode !== newMode) {
    try {
      const bucketName = getBucketName(email);
      const { endpoint } = await getR2Config(env);
      // Tier-gate context-mode preseed: unlimited (Custom) tier in Pro mode only.
      // Reads tier from the patch when present, falling back to the existing record.
      const effectiveTierForGate = (patch.subscriptionTier as string | undefined)
        ?? (patch.accessTier as string | undefined)
        ?? existing?.subscriptionTier
        ?? existing?.accessTier;
      const contextModeEnabled = effectiveTierForGate === 'unlimited' && newMode === 'advanced';
      await reconcileAgentConfigs(env, bucketName, endpoint, newMode as 'default' | 'advanced', {
        overwrite: true,
        cleanup: true,
        contextModeEnabled,
      });
      const prefsKey = getPreferencesKey(bucketName);
      const prefs = await env.KV.get(prefsKey, 'json') as Record<string, unknown> | null;
      await env.KV.put(prefsKey, JSON.stringify({ ...prefs, sessionMode: newMode }));
      logger.info('Auto-reconciled agent configs on mode change', { email, previousMode, newMode });
    } catch (err) {
      logger.warn('Auto-reconcile on mode change failed (non-fatal)', { error: String(err) });
    }
  }

  logger.info('syncSubscriptionState: synced', {
    email, subscriptionId, tier: snapshot.tier, status: snapshot.status,
  });
}

// ---------------------------------------------------------------------------
// Customer lookup - CF-005: KV lookup with Stripe API fallback
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
