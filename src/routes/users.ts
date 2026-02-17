// users.ts = admin user management (GET/DELETE /api/users). See user.ts for current user identity.
import { Hono } from 'hono';
import type { Env, Session } from '../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { getAllUsers, syncAccessPolicy } from '../lib/access-policy';
import { getBucketName } from '../lib/access';
import { getSessionPrefix, listAllKvKeys } from '../lib/kv-keys';
import { getContainerId } from '../lib/container-helpers';
import { getContainer } from '@cloudflare/containers';
import { createLogger } from '../lib/logger';
import { ValidationError, NotFoundError, toError } from '../lib/error-types';
import { CF_API_BASE } from '../lib/constants';
import { r2AdminCB } from '../lib/circuit-breakers';

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

  // Clean up sessions and containers for this user
  const bucketName = getBucketName(email, c.env.CLOUDFLARE_WORKER_NAME);
  const sessionPrefix = getSessionPrefix(bucketName);
  const sessionKeys = await listAllKvKeys(c.env.KV, sessionPrefix);

  for (const key of sessionKeys) {
    try {
      const sessionData = await c.env.KV.get<Session>(key.name, 'json');
      if (sessionData) {
        const containerId = getContainerId(bucketName, sessionData.id);
        const container = getContainer(c.env.CONTAINER, containerId);
        await container.destroy();
      }
    } catch (err) {
      logger.warn('Failed to destroy container during user deletion', { sessionKey: key.name, error: String(err) });
    }
    await c.env.KV.delete(key.name);
  }

  await c.env.KV.delete(`user:${email}`);

  const accountId = await c.env.KV.get('setup:account_id');

  // Try to delete R2 bucket (wrapped in circuit breaker for resilience)
  // NOTE: If the bucket is not empty, the Cloudflare API will reject deletion.
  // Emptying R2 buckets requires S3-compatible API with SigV4 signing — significant new code.
  // Manual R2 cleanup may be needed after user deletion via the Cloudflare dashboard.
  try {
    if (accountId && c.env.CLOUDFLARE_API_TOKEN) {
      const bucketName = getBucketName(email, c.env.CLOUDFLARE_WORKER_NAME);
      const res = await r2AdminCB.execute(() =>
        fetch(`${CF_API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}` },
        })
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (body.includes('not empty') || body.includes('BucketNotEmpty')) {
          logger.warn('R2 bucket not empty, manual cleanup may be needed', { bucketName, email });
        } else {
          logger.error('Failed to delete R2 bucket', new Error(`HTTP ${res.status}: ${body}`), { bucketName });
        }
      }
    }
  } catch (err) {
    // Non-fatal — circuit breaker open or network error
    logger.error('Failed to delete R2 bucket', toError(err));
  }

  await trySyncAccessPolicy(c.env);

  return c.json({ success: true, email });
});

export default app;
