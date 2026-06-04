// user-profile.ts = current user identity (GET /api/user). See users.ts for admin CRUD.
import { Hono } from 'hono';
import type { Env } from '../types';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { isOnboardingLandingPageActive, isSaasModeActive } from '../lib/onboarding';
import { isEnterpriseMode } from '../lib/subscription';
import { getOrCreateScopedR2Token } from '../lib/r2-admin';
import { getOrImportKey } from '../lib/kv-crypto';
import { SETUP_KEYS } from '../lib/kv-keys';

/**
 * Rate limiter for ensure-r2-token
 * Limits to 5 requests per minute per user
 */
const ensureR2TokenRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 5,
  keyPrefix: 'ensure-r2-token',
});

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Use shared auth middleware
app.use('*', authMiddleware);

/**
 * GET /api/user
 * Returns authenticated user info including access tier, onboarding status, and configuration
 *
 * Note: Bucket creation is handled by POST /api/container/start.
 * This endpoint does NOT create buckets — it only reads user metadata.
 */
app.get('/', async (c) => {
  const user = c.get('user');
  const bucketName = c.get('bucketName');

  // Read onboardingComplete and subscribedMode from user's KV entry
  const kvRaw = await c.env.KV.get(`user:${user.email}`, 'json') as { onboardingComplete?: boolean; subscribedMode?: string } | null;
  const onboardingComplete = kvRaw?.onboardingComplete === true;
  const subscribedMode = kvRaw?.subscribedMode === 'advanced' ? 'advanced' : 'default';

  const subscriptionTier = user.subscriptionTier ?? user.accessTier;
  const hasSubscribed = subscriptionTier !== 'pending' && subscriptionTier !== 'blocked';

  return c.json({
    email: user.email,
    authenticated: user.authenticated,
    role: user.role,
    accessTier: user.accessTier,
    subscriptionTier,
    bucketName,
    workerName: c.env.CLOUDFLARE_WORKER_NAME || 'codeflare',
    onboardingActive: isOnboardingLandingPageActive(c.env.ONBOARDING_LANDING_PAGE),
    saasMode: isSaasModeActive(c.env.SAAS_MODE),
    onboardingComplete,
    hasSubscribed,
    subscribedMode,
    enterpriseMode: isEnterpriseMode(c.env),
  });
});

/**
 * POST /api/user/onboarding-complete
 * Marks the current user's onboarding as complete so they go to dashboard next time.
 */
app.post('/onboarding-complete', async (c) => {
  const user = c.get('user');
  const kvRaw = await c.env.KV.get(`user:${user.email}`, 'json') as Record<string, unknown> | null;
  if (kvRaw) {
    await c.env.KV.put(`user:${user.email}`, JSON.stringify({ ...kvRaw, onboardingComplete: true }));
  }
  return c.json({ success: true });
});

/**
 * GET /api/user/r2-status
 * Returns whether a scoped R2 token exists for the current user
 */
app.get('/r2-status', async (c) => {
  const user = c.get('user');
  const token = await c.env.KV.get(`r2token:${user.email}`);
  return c.json({ ready: !!token });
});

/**
 * POST /api/user/ensure-r2-token
 * Eagerly creates a scoped R2 token for the current user if one doesn't exist.
 */
app.post('/ensure-r2-token', ensureR2TokenRateLimiter, async (c) => {
  const user = c.get('user');
  const bucketName = c.get('bucketName');
  const accountId = await c.env.KV.get(SETUP_KEYS.ACCOUNT_ID);

  if (!accountId || !c.env.CLOUDFLARE_API_TOKEN) {
    return c.json({ ready: false, error: 'Setup incomplete' }, 503);
  }

  try {
    const cryptoKey = await getOrImportKey(c.env);
    await getOrCreateScopedR2Token(user.email, accountId, c.env.CLOUDFLARE_API_TOKEN, bucketName, c.env.KV, cryptoKey);
    return c.json({ ready: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ready: false, error: msg }, 500);
  }
});

export default app;
