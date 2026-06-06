// users.ts = admin user management (GET/DELETE/PATCH /api/users). See user.ts for current user identity.
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { AccessTierSchema, SubscriptionTierSchema } from '../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { getAllUsers, getAdminEmails, syncAccessPolicy } from '../lib/access-policy';
import { createLogger } from '../lib/logger';
import { ValidationError, NotFoundError, ForbiddenError, toError } from '../lib/error-types';
import { cleanupUserData } from '../lib/user-cleanup';
import { isSaasModeActive } from '../lib/onboarding';
import { isEnterpriseMode } from '../lib/subscription';
import { parseJsonBody } from '../lib/request-helpers';
import { sendTierChangeNotification } from '../lib/email';
import { getBucketName } from '../lib/access';
import { updateUserRecord } from '../lib/user-record';
import { getPreferencesKey, SETUP_KEYS } from '../lib/kv-keys';

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
    const accountId = await env.KV.get(SETUP_KEYS.ACCOUNT_ID);
    const domain = await env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN);
    if (accountId && domain && env.CLOUDFLARE_API_TOKEN) {
      await syncAccessPolicy(env.CLOUDFLARE_API_TOKEN, accountId, domain, env.KV);
    }
  } catch (err) {
    logger.error('Failed to sync Access policy', toError(err));
  }
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

// REQ-ENTERPRISE-009: in enterprise mode, user administration is delegated to the
// customer's Cloudflare Access — blocking/deleting/tier-changing a user here is
// meaningless (Access still admits them). Fail closed on every user-management
// route. No-op when ENTERPRISE_MODE is unset, so SaaS/non-SaaS are unchanged.
app.use('*', async (c, next) => {
  if (isEnterpriseMode(c.env)) {
    throw new ForbiddenError('User management is disabled in enterprise mode — users are managed via Cloudflare Access');
  }
  return next();
});

/**
 * Rate limiter for user mutations (DELETE and PATCH)
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
  const maxUsers = parseInt(await c.env.KV.get(SETUP_KEYS.MAX_USERS) ?? '0');
  return c.json({ users, maxUsers });
});

// PUT /api/users/max-users - Set max users cap (admin only)
app.put('/max-users', requireAdmin, async (c) => {
  const raw = await parseJsonBody(c);
  const parsed = z.object({ maxUsers: z.number().int().min(0) }).safeParse(raw);
  if (!parsed.success) throw new ValidationError('maxUsers must be a non-negative integer');
  await c.env.KV.put(SETUP_KEYS.MAX_USERS, String(parsed.data.maxUsers));
  return c.json({ success: true, maxUsers: parsed.data.maxUsers });
});

// DELETE /api/users/:email - Remove a user (admin only)
app.delete('/:email', requireAdmin, userMutationRateLimiter, async (c) => {
  const rawEmail = c.req.param('email');
  if (!rawEmail) throw new ValidationError('Email parameter is required');
  const email = rawEmail.trim().toLowerCase();
  const currentUser = c.get('user');

  if (email === currentUser.email.trim().toLowerCase()) {
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

// PATCH /api/users/:email - Update a user's subscription tier (admin only, SaaS mode only)
app.patch('/:email', requireAdmin, userMutationRateLimiter, async (c) => {
  if (!isSaasModeActive(c.env.SAAS_MODE)) {
    throw new ValidationError('Subscription tiers are only available in SaaS mode');
  }

  const rawEmail = c.req.param('email');
  if (!rawEmail) throw new ValidationError('Email parameter is required');
  const email = rawEmail.trim().toLowerCase();

  // Accept tier + optional mode override
  const patchSchema = z.object({
    subscriptionTier: SubscriptionTierSchema.optional(),
    accessTier: AccessTierSchema.optional(),
    subscribedMode: z.enum(['default', 'advanced']).optional(),
  }).refine(
    (d) => d.subscriptionTier !== undefined || d.accessTier !== undefined,
    { message: 'Either subscriptionTier or accessTier is required' }
  );
  const body = await parseJsonBody(c, patchSchema);

  const newTier = body.subscriptionTier ?? body.accessTier!;

  // Validate existing record with schema before merging
  const existingRaw = await c.env.KV.get(`user:${email}`, 'json');
  if (!existingRaw) throw new NotFoundError('User', email);
  const kvUserSchema = z.object({
    addedBy: z.string().default('unknown'),
    addedAt: z.string().default(''),
    role: z.enum(['admin', 'user']).default('user'),
    accessTier: SubscriptionTierSchema.optional(),
    subscriptionTier: SubscriptionTierSchema.optional(),
  }).passthrough();
  const existing = kvUserSchema.parse(existingRaw);

  // Admin tier changes only allowed for self (recovery from corrupted KV state).
  if (existing.role === 'admin') {
    const currentUser = c.get('user');
    if (email !== currentUser.email.trim().toLowerCase()) {
      throw new ValidationError('Cannot change another admin\'s tier');
    }
  }

  // Map new tier to nearest valid AccessTier for backward compat.
  // New tiers (free/trial/max/unlimited) don't exist in the old 4-value schema —
  // writing them raw would cause AccessTierSchema.safeParse to reject → fallback 'advanced'.
  const LEGACY_TIERS = new Set(['pending', 'standard', 'advanced', 'blocked']);
  const legacyAccessTier = LEGACY_TIERS.has(newTier) ? newTier : 'advanced';
  // Use explicit mode if provided by admin, otherwise default to 'default'
  const subscribedMode = body.subscribedMode ?? 'default';
  await updateUserRecord(c.env.KV, email, { subscriptionTier: newTier, accessTier: legacyAccessTier, subscribedMode });

  // Auto-set sessionMode to 'advanced' for tiers that support it.
  if (newTier === 'advanced' || newTier === 'max' || newTier === 'unlimited') {
    const bucketName = getBucketName(email, c.env.CLOUDFLARE_WORKER_NAME);
    const prefsKey = getPreferencesKey(bucketName);
    const existingPrefs = await c.env.KV.get(prefsKey, 'json') as Record<string, unknown> | null;
    if (!existingPrefs?.sessionMode) {
      await c.env.KV.put(prefsKey, JSON.stringify({ ...existingPrefs, sessionMode: 'advanced' }));
    }
  }

  const previousTier = existing.subscriptionTier ?? existing.accessTier ?? 'unset';
  logger.info('User subscription tier updated', {
    email,
    previousTier,
    subscriptionTier: newTier,
    updatedBy: c.get('user').email,
  });

  // Fire-and-forget tier change notification email (non-fatal)
  try {
    const adminEmails = await getAdminEmails(c.env.KV);
    void sendTierChangeNotification({
      userEmail: email,
      previousTier,
      newTier,
      changedBy: c.get('user').email,
      adminEmails,
      env: c.env,
    });
  } catch { /* notification failure must not block tier update response */ }

  return c.json({ success: true, email, subscriptionTier: newTier, accessTier: legacyAccessTier });
});

export default app;
