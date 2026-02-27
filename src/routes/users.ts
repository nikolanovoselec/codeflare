// users.ts = admin user management (GET/DELETE /api/users). See user.ts for current user identity.
import { Hono } from 'hono';
import type { Env } from '../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { getAllUsers, syncAccessPolicy } from '../lib/access-policy';
import { createLogger } from '../lib/logger';
import { ValidationError, NotFoundError, toError } from '../lib/error-types';
import { cleanupUserData } from '../lib/user-cleanup';

const logger = createLogger('users');

/**
 * Attempt to sync the CF Access policy after a user mutation.
 * Non-fatal: logs errors but does not throw.
 */
async function trySyncAccessPolicy(env: Env): Promise<void> {
  try {
    const accountId = await env.KV.get('setup:account_id');
    const domain = await env.KV.get('setup:custom_domain');
    if (accountId && domain && env.CLOUDFLARE_API_TOKEN) {
      await syncAccessPolicy(env.CLOUDFLARE_API_TOKEN, accountId, domain, env.KV);
    }
  } catch (err) {
    logger.error('Failed to sync Access policy', toError(err));
  }
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

/**
 * Rate limiter for user mutations (DELETE)
 * Limits to 20 mutations per minute per user
 */
const userMutationRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 20,
  keyPrefix: 'user-mutation',
});

// GET /api/users - List all users
app.get('/', requireAdmin, async (c) => {
  const users = await getAllUsers(c.env.KV);
  return c.json({ users });
});

// DELETE /api/users/:email - Remove a user (admin only)
app.delete('/:email', requireAdmin, userMutationRateLimiter, async (c) => {
  const email = decodeURIComponent(c.req.param('email'));
  const currentUser = c.get('user');

  if (!email) {
    throw new ValidationError('Email parameter is required');
  }

  if (email === currentUser.email) {
    throw new ValidationError('Cannot remove yourself');
  }

  const existing = await c.env.KV.get(`user:${email}`);
  if (!existing) {
    throw new NotFoundError('User', email);
  }

  const result = await cleanupUserData(email, c.env);
  logger.info('User data cleaned up', { email, ...result });

  await trySyncAccessPolicy(c.env);

  return c.json({ success: true, email });
});

export default app;
