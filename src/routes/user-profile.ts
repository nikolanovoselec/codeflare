// user-profile.ts = current user identity (GET /api/user). See users.ts for admin CRUD.
import { Hono } from 'hono';
import type { Env } from '../types';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { isOnboardingLandingPageActive } from '../lib/onboarding';

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

export default app;
