// AUTH: HTTP request authentication middleware.
// See also: src/index.ts (WebSocket upgrade intercept), src/routes/terminal.ts (WebSocket auth)
//
// Three-tier middleware system:
//   requireIdentity   — authenticate only, no tier gate (pending users pass through)
//   requireActiveUser — authenticate + tier check when SAAS_MODE is active
//   requireAdmin      — requires admin role (must be used after requireIdentity or requireActiveUser)

import { Context, Next } from 'hono';
import { authenticateRequest } from '../lib/access';
import { ForbiddenError } from '../lib/error-types';
import { isSaasModeActive } from '../lib/onboarding';
import { isActiveUser } from '../lib/access-tier';
import type { Env, AccessUser } from '../types';

/**
 * Shared auth variables type for Hono context
 * Routes can extend this with additional variables
 */
export type AuthVariables = {
  user: AccessUser;
  bucketName: string;
  /** Set by request tracing middleware in index.ts, inherited by sub-routers */
  requestId: string;
};

/**
 * requireIdentity — authenticate the request and set user/bucketName on context.
 * No tier gating: pending, blocked, and unrecognized users pass through.
 * Use for routes that need identity but not an active subscription (e.g. /auth/status).
 */
export async function requireIdentity(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) {
  const { user, bucketName } = await authenticateRequest(c.req.raw, c.env);
  c.set('user', user);
  c.set('bucketName', bucketName);
  return next();
}

/**
 * requireActiveUser — authenticate + enforce access-tier gate when SAAS_MODE is active.
 *
 * In SaaS mode:
 *   - standard / advanced / undefined tier → pass through
 *   - pending tier + HTML request → redirect to /app/subscribe
 *   - pending tier + API request  → 403 { code: 'PENDING' }
 *   - blocked tier                → 403 { code: 'BLOCKED' }
 *
 * When SAAS_MODE is not set, behaves identically to requireIdentity (backward compat).
 */
export async function requireActiveUser(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) {
  const { user, bucketName } = await authenticateRequest(c.req.raw, c.env);
  c.set('user', user);
  c.set('bucketName', bucketName);

  if (isSaasModeActive(c.env.SAAS_MODE) && !isActiveUser(user.accessTier)) {
    const code = user.accessTier === 'blocked' ? 'BLOCKED' : 'PENDING';
    return c.json({ error: 'Access denied', code }, 403);
  }

  return next();
}

/**
 * Backward-compatible alias: existing routes that use `authMiddleware` continue to work.
 * Maps to requireActiveUser so they gain tier gating when SAAS_MODE is enabled.
 */
export { requireActiveUser as authMiddleware };

/**
 * Middleware that requires the authenticated user to have admin role.
 * Must be used AFTER requireIdentity or requireActiveUser (user must already be on context).
 *
 * Usage:
 *   app.use('*', authMiddleware);
 *   app.post('/admin-route', requireAdmin, async (c) => { ... });
 */
export async function requireAdmin(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) {
  const user = c.get('user');
  if (user?.role !== 'admin') {
    throw new ForbiddenError('Admin access required');
  }
  return next();
}
