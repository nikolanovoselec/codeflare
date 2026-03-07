// user-profile.ts = current user identity (GET /api/user). See users.ts for admin CRUD.
import { Hono } from 'hono';
import type { Env } from '../types';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { isOnboardingLandingPageActive } from '../lib/onboarding';
import { getOrCreateScopedR2Token } from '../lib/r2-admin';

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
 * Returns authenticated user info
 *
 * Note: Bucket creation is handled by POST /api/container/start,
 * so we don't create it here to avoid unnecessary latency.
 */
app.get('/', async (c) => {
  const user = c.get('user');
  const bucketName = c.get('bucketName');

  return c.json({
    email: user.email,
    authenticated: user.authenticated,
    role: user.role,
    bucketName,
    workerName: c.env.CLOUDFLARE_WORKER_NAME || 'codeflare',
    onboardingActive: isOnboardingLandingPageActive(c.env.ONBOARDING_LANDING_PAGE),
  });
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
  const accountId = await c.env.KV.get('setup:account_id');

  if (!accountId || !c.env.CLOUDFLARE_API_TOKEN) {
    return c.json({ ready: false, error: 'Setup incomplete' }, 503);
  }

  try {
    await getOrCreateScopedR2Token(user.email, accountId, c.env.CLOUDFLARE_API_TOKEN, bucketName, c.env.KV);
    return c.json({ ready: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ready: false, error: msg }, 500);
  }
});

export default app;
