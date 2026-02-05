// AUTH: HTTP request authentication middleware.
// See also: src/index.ts (WebSocket upgrade intercept), src/routes/terminal.ts (WebSocket auth)

import { Context, Next } from 'hono';
import { authenticateRequest } from '../lib/access';
import { ForbiddenError } from '../lib/error-types';
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
 * Auth middleware that validates user authentication via Cloudflare Access
 * Sets `user` and `bucketName` on the context for downstream handlers
 *
 * Delegates to authenticateRequest() which throws AuthError/ForbiddenError
 * on failure — caught by the global error handler in index.ts.
 *
 * Usage:
 *   import { authMiddleware, AuthVariables } from '../middleware/auth';
 *   const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
 *   app.use('*', authMiddleware);
 */
export async function authMiddleware(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) {
  const { user, bucketName } = await authenticateRequest(c.req.raw, c.env);
  c.set('user', user);
  c.set('bucketName', bucketName);
  return next();
}

/**
 * Middleware that requires the authenticated user to have admin role.
 * Must be used AFTER authMiddleware (user must already be on context).
 *
 * Usage:
 *   app.post('/admin-route', requireAdmin, async (c) => { ... });
 */
export async function requireAdmin(c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) {
  const user = c.get('user');
  if (user?.role !== 'admin') {
    throw new ForbiddenError('Admin access required');
  }
  return next();
}
