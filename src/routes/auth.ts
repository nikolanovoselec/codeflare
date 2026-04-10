import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { requireIdentity, type AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { ValidationError, ForbiddenError, toError } from '../lib/error-types';
import { isActiveUser } from '../lib/access-tier';
import { getTierConfig, getEffectiveTier, SUBSCRIBABLE_TIER_IDS, countPaidSlots } from '../lib/subscription';
import { getAllUsers, getAdminEmails } from '../lib/access-policy';
import { createLogger } from '../lib/logger';
import { verifyTurnstileToken } from '../lib/turnstile';
import { sendSubscriptionEmail, sendSubscriptionAdminNotification, sendAccessRequestNotification } from '../lib/email';
import { getBucketName } from '../lib/access';
import { updateUserRecord } from '../lib/user-record';
import { parseJsonBody, firstZodError } from '../lib/request-helpers';
import { getPreferencesKey, SETUP_KEYS } from '../lib/kv-keys';
import { isStripeConfigured, getStripePrices } from '../lib/stripe';
import { getCurrencyForCountry } from '../lib/currency';

const logger = createLogger('auth-routes');

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Public — no authentication required
app.get('/providers', async (c) => {
  const idpList = await c.env.KV.get(SETUP_KEYS.IDP_LIST, 'json');
  return c.json({ providers: idpList || [] });
});

// GET /api/auth/onboarding-config — onboarding page config (turnstile key).
// Moved from /public/onboarding-config — user is authenticated at this point.
app.get('/onboarding-config', requireIdentity, async (c) => {
  const siteKey = await c.env.KV.get(SETUP_KEYS.TURNSTILE_SITE_KEY);
  return c.json({ active: true, turnstileSiteKey: siteKey });
});

// GET /api/auth/tiers — subscribable tier config for the subscribe page.
app.get('/tiers', requireIdentity, async (c) => {
  const allTiers = await getTierConfig(c.env.KV);
  const subscribable = allTiers.filter((t) => {
    if (!SUBSCRIBABLE_TIER_IDS.has(t.id as string)) return false;
    // Free (priceMonthly === 0) and Custom/unlimited always show.
    // Paid tiers only show when stripePriceId is configured in admin.
    if (t.priceMonthly === 0 || t.id === 'unlimited') return true;
    return !!t.stripePriceId;
  });

  // Enrich with Stripe prices when configured (REQ-SUB-020: detect visitor currency)
  if (isStripeConfigured(c.env) && c.env.STRIPE_SECRET_KEY) {
    const country = c.req.header('CF-IPCountry') || '';
    const currency = getCurrencyForCountry(country);
    const priceIds = subscribable.flatMap((t) =>
      [t.stripePriceId, t.stripeAdvancedPriceId].filter((id): id is string => !!id)
    );
    if (priceIds.length > 0) {
      try {
        const prices = await getStripePrices(priceIds, c.env.STRIPE_SECRET_KEY, currency);
        const enriched = subscribable.map((t) => {
          const stdPrice = t.stripePriceId ? prices.get(t.stripePriceId) : undefined;
          const advPrice = t.stripeAdvancedPriceId ? prices.get(t.stripeAdvancedPriceId) : undefined;
          return {
            ...t,
            ...(stdPrice ? { stripePrice: stdPrice } : {}),
            ...(advPrice ? { stripeAdvancedPrice: advPrice } : {}),
          };
        });
        return c.json({ tiers: enriched });
      } catch { /* non-fatal — return tiers without prices */ }
    }
  }

  return c.json({ tiers: subscribable });
});

// Requires identity (pending, active, and blocked users can access)
app.get('/status', requireIdentity, async (c) => {
  const user = c.get('user');
  // Default to 'advanced' for legacy accessTier (pre-setup or service auth backward compat)
  const accessTier = user.accessTier || 'advanced';

  // Parallelize independent KV reads: user data, turnstile key, and session preferences
  let prefsKey: string | null = null;
  try {
    const bucketName = getBucketName(user.email, c.env.CLOUDFLARE_WORKER_NAME);
    prefsKey = getPreferencesKey(bucketName);
  } catch { /* getBucketName may not be available in test mocks */ }

  const [userData, turnstileSiteKey, prefs] = await Promise.all([
    c.env.KV.get(`user:${user.email}`, 'json') as Promise<Record<string, unknown> | null>,
    c.env.KV.get(SETUP_KEYS.TURNSTILE_SITE_KEY).then(v => v ?? null),
    prefsKey
      ? c.env.KV.get(prefsKey, 'json').then(v => v as Record<string, unknown> | null).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Billing-aware tier resolution: downgrade paid tiers to free when billing is canceled/past_due
  const billingStatus = (userData?.billingStatus as string) ?? null;
  const billingPeriodEnd = (userData?.billingPeriodEnd as string) ?? null;
  const subscriptionTier = getEffectiveTier(user.subscriptionTier, accessTier, billingStatus, billingPeriodEnd);

  let requestedAt: string | null = null;
  if (subscriptionTier === 'pending') {
    if (userData && typeof userData.requestedAt === 'string') {
      requestedAt = userData.requestedAt;
    }
  }

  // Include onboardingComplete flag for active users
  const onboardingComplete = userData && userData.onboardingComplete === true;

  // hasSubscribed = user has an active subscription (self-subscribed OR admin-promoted)
  const hasSubscribed = subscriptionTier !== 'pending' && subscriptionTier !== 'blocked';

  // trialUsed = user has already used their free trial (no new trials on plan switch)
  const trialUsed = userData?.trialUsed === true;

  const sessionMode = prefs?.sessionMode === 'advanced' ? 'advanced' : 'default';

  // subscribedMode = what mode the user paid for (gates Settings Pro toggle)
  const subscribedMode = (userData?.subscribedMode === 'advanced' ? 'advanced' : 'default') as string;

  // Check if user capacity is reached (for frontend to disable subscribe buttons)
  let userCapacityReached = false;
  const maxUsers = parseInt(await c.env.KV.get(SETUP_KEYS.MAX_USERS) ?? '0');
  if (maxUsers > 0 && !hasSubscribed) {
    try {
      const allUsers = await getAllUsers(c.env.KV);
      userCapacityReached = countPaidSlots(allUsers) >= maxUsers;
    } catch { /* non-fatal */ }
  }

  return c.json({
    email: user.email,
    accessTier,
    subscriptionTier,
    role: user.role || 'user',
    turnstileSiteKey,
    requestedAt,
    onboardingComplete,
    hasSubscribed,
    trialUsed,
    sessionMode,
    subscribedMode,
    billingStatus,
    userCapacityReached,
  });
});

// Rate limit for access requests: 3 per hour per user (SaaS mode only)
const requestAccessRateLimiter = createRateLimiter({
  windowMs: 3_600_000,
  maxRequests: 3,
  keyPrefix: 'request-access',
  failClosed: true,
});

const RequestAccessSchema = z.object({
  turnstileToken: z.string().min(1, 'Turnstile token is required'),
});


// POST /api/auth/request-access — pending users request access with Turnstile captcha (SaaS mode)
app.post('/request-access', requireIdentity, requestAccessRateLimiter, async (c) => {
  const user = c.get('user');
  // Default to 'advanced' if tier is unset (pre-setup or service auth)
  const effectiveTier = user.subscriptionTier ?? user.accessTier ?? 'advanced';

  // Already active users don't need to request
  if (isActiveUser(effectiveTier)) {
    throw new ValidationError('Account is already active');
  }

  // Blocked users cannot request
  if (effectiveTier === 'blocked') {
    throw new ForbiddenError('Account is blocked');
  }

  // Idempotency: if already requested, return success without re-notifying
  const existingRaw = await c.env.KV.get(`user:${user.email}`, 'json') as Record<string, unknown> | null;
  if (existingRaw && typeof existingRaw.requestedAt === 'string') {
    return c.json({ success: true });
  }

  // Parse body
  const raw = await parseJsonBody(c);

  const parsed = RequestAccessSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(firstZodError(parsed.error));
  }

  // Verify Turnstile token (required for SaaS mode access request gating)
  const turnstileSecret = c.env.TURNSTILE_SECRET_KEY
    || await c.env.KV.get(SETUP_KEYS.TURNSTILE_SECRET_KEY);

  if (!turnstileSecret) {
    throw new ValidationError('Turnstile is not configured for access requests');
  }

  const remoteIp = c.req.header('CF-Connecting-IP') || null;
  const verification = await verifyTurnstileToken(
    parsed.data.turnstileToken,
    turnstileSecret,
    remoteIp
  );

  if (!verification.success) {
    logger.warn('Turnstile verification failed for access request', {
      email: user.email,
      errorCodes: verification['error-codes'],
    });
    throw new ForbiddenError('CAPTCHA verification failed');
  }

  const requestedAt = new Date().toISOString();
  await updateUserRecord(c.env.KV, user.email, { requestedAt });

  // Send admin notification email (non-fatal, using shared sendEmail helper)
  try {
    const adminEmails = await getAdminEmails(c.env.KV);
    await sendAccessRequestNotification({
      userEmail: user.email,
      requestedAt,
      remoteIp,
      adminEmails,
      env: c.env,
    });
  } catch (err) {
    logger.error('Failed to send access request notification email', toError(err));
  }

  logger.info('Access request submitted', { email: user.email });
  return c.json({ success: true });
});

// Rate limit for subscribe: 3 per minute per user
const subscribeRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 3,
  keyPrefix: 'subscribe',
});

const SubscribeSchema = z.object({
  tier: z.string().min(1, 'Tier is required'),
  turnstileToken: z.string().optional().default(''),
  mode: z.enum(['default', 'advanced']).optional().default('default'),
});

// POST /api/auth/subscribe — self-service tier selection for pending users
app.post('/subscribe', requireIdentity, subscribeRateLimiter, async (c) => {
  const user = c.get('user');
  const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd);
  if (effectiveTier === 'blocked') {
    throw new ForbiddenError('Account is blocked');
  }

  const raw = await parseJsonBody(c);

  const parsed = SubscribeSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(firstZodError(parsed.error));

  if (!SUBSCRIBABLE_TIER_IDS.has(parsed.data.tier)) {
    throw new ValidationError(`Invalid tier: ${parsed.data.tier}. Must be one of: free, standard, advanced, max, unlimited`);
  }

  // Gate paid tiers when Stripe is configured — they must go through checkout
  if (isStripeConfigured(c.env) && parsed.data.tier !== 'free') {
    throw new ValidationError('Paid subscriptions require checkout.');
  }

  const existingRaw = await c.env.KV.get(`user:${user.email}`, 'json') as Record<string, unknown> | null;
  const isAlreadySubscribed = !!existingRaw?.subscribedAt;

  // Max users cap — block new subscriptions when capacity is reached
  if (!isAlreadySubscribed) {
    const maxUsers = parseInt(await c.env.KV.get(SETUP_KEYS.MAX_USERS) ?? '0');
    if (maxUsers > 0) {
      const allUsers = await getAllUsers(c.env.KV);
      if (countPaidSlots(allUsers) >= maxUsers) {
        throw new ValidationError('Subscriptions are currently full. Please try again later.');
      }
    }
  }

  // Read current mode from preferences (used for idempotency check + email previousMode)
  let previousMode = 'default';
  try {
    const bkt = getBucketName(user.email, c.env.CLOUDFLARE_WORKER_NAME);
    const p = await c.env.KV.get(getPreferencesKey(bkt), 'json') as Record<string, unknown> | null;
    if (p?.sessionMode === 'advanced') previousMode = 'advanced';
  } catch { /* non-fatal */ }

  // Idempotency: same tier AND same mode → return success without re-processing
  if (isAlreadySubscribed && existingRaw?.subscriptionTier === parsed.data.tier) {
    if (parsed.data.mode === previousMode) {
      return c.json({ success: true, tier: parsed.data.tier, trialQuotaHours: 0, onboardingComplete: existingRaw.onboardingComplete === true });
    }
  }

  // CF-001: Require Turnstile token for new subscriptions when secret is configured.
  // Active users switching plans skip Turnstile.
  if (!isAlreadySubscribed) {
    const turnstileSecret = c.env.TURNSTILE_SECRET_KEY
      || await c.env.KV.get(SETUP_KEYS.TURNSTILE_SECRET_KEY);
    if (turnstileSecret) {
      if (!parsed.data.turnstileToken) {
        throw new ForbiddenError('CAPTCHA token required');
      }
      const remoteIp = c.req.header('CF-Connecting-IP') || null;
      const verification = await verifyTurnstileToken(parsed.data.turnstileToken, turnstileSecret, remoteIp);
      if (!verification.success) {
        throw new ForbiddenError('CAPTCHA verification failed');
      }
    }
  }

  const now = new Date();
  // Mark trial as used on first subscription so plan switches don't grant new trials
  const trialUsed = existingRaw?.trialUsed === true || isAlreadySubscribed;
  await updateUserRecord(c.env.KV, user.email, {
    subscriptionTier: parsed.data.tier,
    accessTier: parsed.data.tier, // backward compat
    subscribedMode: parsed.data.mode,
    subscribedAt: now.toISOString(),
    trialUsed,
  });

  // Save session mode preference when subscribing/switching (non-fatal)
  try {
    if (parsed.data.mode) {
      const subBucketName = getBucketName(user.email, c.env.CLOUDFLARE_WORKER_NAME);
      const prefsKey = getPreferencesKey(subBucketName);
      const existingPrefs = await c.env.KV.get(prefsKey, 'json') as Record<string, unknown> | null;
      await c.env.KV.put(prefsKey, JSON.stringify({ ...existingPrefs, sessionMode: parsed.data.mode }));
    }
  } catch { /* non-fatal */ }

  const onboardingComplete = existingRaw?.onboardingComplete === true;
  logger.info('User subscribed', { email: user.email, tier: parsed.data.tier });

  // Non-fatal: send subscription confirmation + admin notification emails
  try {
    const tiers = await getTierConfig(c.env.KV);
    const tierConfig = tiers.find(t => t.id === parsed.data.tier);
    const customDomain = await c.env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN);
    const instanceUrl = customDomain ? `https://${customDomain}` : undefined;

    const previousTierId = isAlreadySubscribed ? String(existingRaw?.subscriptionTier ?? '') : undefined;
    const previousTierConfig = previousTierId ? tiers.find(t => t.id === previousTierId) : undefined;

    const country = c.req.header('CF-IPCountry') || 'US';
    const cur = getCurrencyForCountry(country);
    const priceCents = parsed.data.mode === 'advanced'
      ? (tierConfig?.advancedPriceMonthly ?? tierConfig?.priceMonthly)
      : tierConfig?.priceMonthly;
    const priceStr = priceCents != null && priceCents > 0
      ? `${cur === 'eur' ? '\u20AC' : cur === 'gbp' ? '\u00A3' : cur === 'chf' ? 'CHF ' : '$'}${(priceCents / 100).toFixed(0)}`
      : undefined;
    const emailMonthlyHours = tierConfig?.monthlySeconds != null ? `${Math.round(tierConfig.monthlySeconds / 3600)}h` : 'Unlimited';
    const emailMaxSessions = tierConfig?.maxSessions ?? 1;
    const emailTrialHours = trialUsed ? 0 : (tierConfig?.trialQuotaHours ?? 0);
    const emailSubscribedAt = now.toISOString();

    const emailPromise = Promise.all([
      sendSubscriptionEmail({
        userEmail: user.email,
        tierName: tierConfig?.displayName ?? parsed.data.tier,
        previousTierName: previousTierConfig?.displayName ?? previousTierId,
        monthlyHours: emailMonthlyHours,
        maxSessions: emailMaxSessions,
        trialHours: emailTrialHours,
        sessionMode: parsed.data.mode,
        previousMode: isAlreadySubscribed ? previousMode : undefined,
        price: priceStr,
        subscribedAt: emailSubscribedAt,
        instanceUrl,
        env: c.env,
      }),
      (async () => {
        const adminEmails = await getAdminEmails(c.env.KV);
        return sendSubscriptionAdminNotification({
          userEmail: user.email,
          tierName: tierConfig?.displayName ?? parsed.data.tier,
          previousTierName: previousTierConfig?.displayName ?? previousTierId,
          sessionMode: parsed.data.mode,
          previousMode: isAlreadySubscribed ? previousMode : undefined,
          monthlyHours: emailMonthlyHours,
          maxSessions: emailMaxSessions,
          price: priceStr,
          trialHours: emailTrialHours,
          subscribedAt: emailSubscribedAt,
          adminEmails,
          env: c.env,
        });
      })(),
    ]);
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(emailPromise);
    } else {
      void emailPromise;
    }
  } catch (err) {
    logger.error('Failed to send subscription emails', toError(err));
  }

  return c.json({ success: true, tier: parsed.data.tier, trialQuotaHours: 0, onboardingComplete, trialUsed });
});

// Rate limit for team contact: 1 per hour per user
const contactTeamRateLimiter = createRateLimiter({
  windowMs: 3_600_000,
  maxRequests: 1,
  keyPrefix: 'contact-team',
});

// POST /api/auth/contact-team — notify admins that a user wants Team/Enterprise access
app.post('/contact-team', requireIdentity, contactTeamRateLimiter, async (c) => {
  const user = c.get('user');
  let plan: string | undefined;
  try {
    const body = await c.req.json<{ plan?: string }>().catch(() => ({} as { plan?: string }));
    plan = typeof body.plan === 'string' ? body.plan.slice(0, 64) : undefined;
  } catch { /* body parsing is best-effort */ }
  try {
    const adminEmails = await getAdminEmails(c.env.KV);
    await sendAccessRequestNotification({
      userEmail: user.email,
      requestedAt: new Date().toISOString(),
      remoteIp: c.req.header('CF-Connecting-IP') || null,
      plan: plan || 'Custom',
      adminEmails,
      env: c.env,
    });
  } catch (err) {
    logger.error('Failed to send team contact email', toError(err));
  }
  logger.info('Team access inquiry', { email: user.email, plan });
  return c.json({ success: true });
});

export default app;
