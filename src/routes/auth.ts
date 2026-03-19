import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { requireIdentity, type AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { ValidationError, ForbiddenError } from '../lib/error-types';
import { isActiveUser } from '../lib/access-tier';
import { getTierConfig, getUserTier } from '../lib/subscription';
import { getAllUsers } from '../lib/access-policy';
import { escapeXml } from '../lib/xml-utils';
import { createLogger } from '../lib/logger';
import { verifyTurnstileToken } from '../lib/turnstile';

const logger = createLogger('auth-routes');

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Public — no authentication required
app.get('/providers', async (c) => {
  const idpList = await c.env.KV.get('setup:idp_list', 'json');
  return c.json({ providers: idpList || [] });
});

// Requires identity (pending, active, and blocked users can access)
app.get('/status', requireIdentity, async (c) => {
  const user = c.get('user');
  // Default to 'advanced' for legacy accessTier (pre-setup or service auth backward compat)
  const accessTier = user.accessTier || 'advanced';
  // subscriptionTier: use actual value, fall back to accessTier for backward compat.
  // Non-SaaS users without a tier get 'advanced' (full access, same as pre-subscription behavior).
  const subscriptionTier = user.subscriptionTier ?? accessTier;

  // Read user data from KV for additional fields
  const userData = await c.env.KV.get(`user:${user.email}`, 'json') as Record<string, unknown> | null;

  // Include turnstile site key and requestedAt for pending users
  let turnstileSiteKey: string | null = null;
  let requestedAt: string | null = null;
  if (subscriptionTier === 'pending') {
    turnstileSiteKey = await c.env.KV.get('setup:turnstile_site_key') ?? null;
    if (userData && typeof userData.requestedAt === 'string') {
      requestedAt = userData.requestedAt;
    }
  }

  // Include onboardingComplete flag for active users
  const onboardingComplete = userData && userData.onboardingComplete === true;

  // hasSubscribed = user explicitly chose a tier via POST /subscribe (has subscribedAt)
  const hasSubscribed = userData && typeof userData.subscribedAt === 'string';

  return c.json({
    email: user.email,
    accessTier,
    subscriptionTier,
    role: user.role || 'user',
    turnstileSiteKey,
    requestedAt,
    onboardingComplete,
    hasSubscribed,
  });
});

// Rate limit for access requests: 3 per hour per user (SaaS mode only)
const requestAccessRateLimiter = createRateLimiter({
  windowMs: 3_600_000,
  maxRequests: 3,
  keyPrefix: 'request-access',
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
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new ValidationError('Invalid JSON body'); }

  const parsed = RequestAccessSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  // Verify Turnstile token (required for SaaS mode access request gating)
  const turnstileSecret = c.env.TURNSTILE_SECRET_KEY
    || await c.env.KV.get('setup:turnstile_secret_key');

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
  const updated = { ...existingRaw, requestedAt };
  await c.env.KV.put(`user:${user.email}`, JSON.stringify(updated));

  // Send admin notification email if Resend is configured
  const resendApiKey = c.env.RESEND_API_KEY;
  if (resendApiKey) {
    try {
      const users = await getAllUsers(c.env.KV);
      const adminRecipients = users.filter((u) => u.role === 'admin').map((u) => u.email);
      if (adminRecipients.length > 0) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resendApiKey}`,
          },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            from: c.env.WAITLIST_FROM_EMAIL || 'Codeflare <onboarding@resend.dev>',
            to: adminRecipients,
            subject: `Codeflare access request: ${user.email.replace(/[\r\n]/g, '')}`,
            html: [
              '<h2>New Codeflare access request</h2>',
              `<p><strong>Email:</strong> ${escapeXml(user.email)}</p>`,
              `<p><strong>Requested at:</strong> ${requestedAt}</p>`,
              `<p><strong>IP:</strong> ${escapeXml(remoteIp || 'unknown')}</p>`,
            ].join('\n'),
            reply_to: user.email.replace(/[\r\n]/g, ''),
          }),
        });
      }
    } catch (err) {
      // Non-fatal: log but don't fail the request
      logger.error('Failed to send access request notification email', err instanceof Error ? err : new Error(String(err)));
    }
  }

  logger.info('Access request submitted', { email: user.email });
  return c.json({ success: true });
});

// Rate limit for subscribe: 3 per hour per user
const subscribeRateLimiter = createRateLimiter({
  windowMs: 3_600_000,
  maxRequests: 3,
  keyPrefix: 'subscribe',
});

const SUBSCRIBABLE_TIERS = new Set(['free', 'standard', 'max', 'unlimited']);

const SubscribeSchema = z.object({
  tier: z.string().min(1, 'Tier is required'),
  turnstileToken: z.string().min(1, 'Turnstile token is required'),
});

// POST /api/auth/subscribe — self-service tier selection for pending users
app.post('/subscribe', requireIdentity, subscribeRateLimiter, async (c) => {
  const user = c.get('user');

  // Idempotency: if user already has a non-pending tier, return success
  const existingRaw = await c.env.KV.get(`user:${user.email}`, 'json') as Record<string, unknown> | null;
  if (existingRaw?.subscribedAt) {
    const tier = (existingRaw.subscriptionTier as string) || 'free';
    return c.json({ success: true, tier, trialDays: 0, onboardingComplete: existingRaw.onboardingComplete === true });
  }

  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new ValidationError('Invalid JSON body'); }

  const parsed = SubscribeSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

  if (!SUBSCRIBABLE_TIERS.has(parsed.data.tier)) {
    throw new ValidationError(`Invalid tier: ${parsed.data.tier}. Must be one of: free, standard, max, unlimited`);
  }

  // Verify Turnstile token
  const turnstileSecret = c.env.TURNSTILE_SECRET_KEY
    || await c.env.KV.get('setup:turnstile_secret_key');
  if (turnstileSecret) {
    const remoteIp = c.req.header('CF-Connecting-IP') || null;
    const verification = await verifyTurnstileToken(parsed.data.turnstileToken, turnstileSecret, remoteIp);
    if (!verification.success) {
      throw new ForbiddenError('CAPTCHA verification failed');
    }
  }

  // Resolve trial period from tier config
  const tiers = await getTierConfig(c.env.KV);
  const tierConfig = getUserTier(parsed.data.tier, tiers);
  const trialDays = tierConfig.trialDays ?? 0;

  const now = new Date();
  const updated: Record<string, unknown> = {
    ...existingRaw,
    subscriptionTier: parsed.data.tier,
    accessTier: parsed.data.tier, // backward compat
    subscribedAt: now.toISOString(),
  };

  // Set trial expiry for tiers with trial period
  if (trialDays > 0) {
    const expiresAt = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
    updated.subscriptionExpiresAt = expiresAt.toISOString();
  }

  await c.env.KV.put(`user:${user.email}`, JSON.stringify(updated));

  const onboardingComplete = updated.onboardingComplete === true;
  logger.info('User subscribed', { email: user.email, tier: parsed.data.tier, trialDays });

  return c.json({ success: true, tier: parsed.data.tier, trialDays, onboardingComplete });
});

// POST /api/auth/onboarding-complete — mark guided setup as completed for this user
app.post('/onboarding-complete', requireIdentity, async (c) => {
  const user = c.get('user');
  const existingRaw = await c.env.KV.get(`user:${user.email}`, 'json') as Record<string, unknown> | null;
  if (!existingRaw) {
    throw new ValidationError('User record not found');
  }

  const updated = { ...existingRaw, onboardingComplete: true };
  await c.env.KV.put(`user:${user.email}`, JSON.stringify(updated));

  logger.info('Onboarding marked complete', { email: user.email });
  return c.json({ success: true });
});

export default app;
