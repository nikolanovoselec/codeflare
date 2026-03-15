// users.ts = admin user management (GET/DELETE/PATCH /api/users). See user.ts for current user identity.
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { AccessTierSchema } from '../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { getAllUsers, syncAccessPolicy } from '../lib/access-policy';
import { createLogger } from '../lib/logger';
import { ValidationError, NotFoundError, toError } from '../lib/error-types';
import { cleanupUserData } from '../lib/user-cleanup';
import { isSaasModeActive } from '../lib/onboarding';
import { getBucketName } from '../lib/access';
import { getPreferencesKey } from '../lib/kv-keys';

const logger = createLogger('users');

/**
 * Attempt to sync the CF Access policy after a user mutation.
 * Non-fatal: logs errors but does not throw.
 */
async function trySyncAccessPolicy(env: Env): Promise<void> {
  // SaaS mode: Access policy uses login_method includes (any GitHub user).
  // Syncing would overwrite it with email/group includes, breaking the policy.
  if (isSaasModeActive(env.SAAS_MODE)) return;

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

  const existing = await c.env.KV.get(`user:${email}`, 'json');
  if (!existing) {
    throw new NotFoundError('User', email);
  }

  // Admin users can only be removed via Setup, not via user management
  const parsed = existing as { role?: string };
  if (parsed.role === 'admin') {
    throw new ValidationError('Cannot delete admin users — remove from admin list in Setup instead');
  }

  const result = await cleanupUserData(email, c.env);
  logger.info('User data cleaned up', { email, ...result });

  await trySyncAccessPolicy(c.env);

  return c.json({ success: true, email });
});

// PATCH /api/users/:email - Update a user's access tier (admin only, SaaS mode only)
app.patch('/:email', requireAdmin, userMutationRateLimiter, async (c) => {
  if (!isSaasModeActive(c.env.SAAS_MODE)) {
    throw new ValidationError('Access tiers are only available in SaaS mode');
  }

  const rawEmail = decodeURIComponent(c.req.param('email'));
  if (!rawEmail) throw new ValidationError('Email parameter is required');
  const email = rawEmail.trim().toLowerCase();

  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new ValidationError('Invalid JSON body'); }

  const patchSchema = z.object({ accessTier: AccessTierSchema });
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

  // Validate existing record with schema before merging
  const existingRaw = await c.env.KV.get(`user:${email}`, 'json');
  if (!existingRaw) throw new NotFoundError('User', email);
  const kvUserSchema = z.object({
    addedBy: z.string().default('unknown'),
    addedAt: z.string().default(''),
    role: z.enum(['admin', 'user']).default('user'),
    accessTier: AccessTierSchema.optional(),
  }).passthrough();
  const existing = kvUserSchema.parse(existingRaw);

  // Admin users always have advanced tier — prevent accidental lockout
  if (existing.role === 'admin') {
    throw new ValidationError('Cannot change admin access tier');
  }

  const updated = { ...existing, accessTier: parsed.data.accessTier };
  await c.env.KV.put(`user:${email}`, JSON.stringify(updated));

  // Auto-set sessionMode to 'advanced' for newly promoted advanced users.
  // This ensures their first session seeds advanced agent skills and rules.
  // Existing sessionMode preferences are NOT overridden.
  if (parsed.data.accessTier === 'advanced') {
    const bucketName = getBucketName(email, c.env.CLOUDFLARE_WORKER_NAME);
    const prefsKey = getPreferencesKey(bucketName);
    const existingPrefs = await c.env.KV.get(prefsKey, 'json') as Record<string, unknown> | null;
    if (!existingPrefs?.sessionMode) {
      await c.env.KV.put(prefsKey, JSON.stringify({ ...existingPrefs, sessionMode: 'advanced' }));
    }
  }

  logger.info('User access tier updated', {
    email,
    previousTier: existing.accessTier ?? 'unset',
    accessTier: parsed.data.accessTier,
    updatedBy: c.get('user').email,
  });

  return c.json({ success: true, email, accessTier: parsed.data.accessTier });
});

export default app;
