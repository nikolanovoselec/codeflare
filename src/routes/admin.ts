/**
 * Admin routes
 * Handles admin-only endpoints like destroy-by-id
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { DO_ID_PATTERN } from '../lib/constants';
import { AppError, AuthError, ValidationError, toError, toErrorMessage } from '../lib/error-types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { createLogger } from '../lib/logger';

const DestroyByIdSchema = z.object({
  doId: z.string().regex(DO_ID_PATTERN, 'Invalid DO ID format - must be 64 hex characters'),
});

const logger = createLogger('admin');

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// All admin routes require authenticated admin user
app.use('*', authMiddleware);

/**
 * Rate limiter for admin endpoints
 * Limits to 10 requests per minute per user
 */
const adminRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'admin',
});

/**
 * POST /api/admin/destroy-by-id
 *
 * Operational/admin-only endpoint for destroying a specific container by
 * its 64-char hex Durable Object ID. This is a destructive action that
 * permanently removes the container and its associated state.
 *
 * Access control: requires authenticated admin user (enforced by
 * authMiddleware + requireAdmin). Rate-limited to 10 req/min per user.
 *
 * CRITICAL: Uses idFromString to reference EXISTING DOs.
 * DO NOT use idFromName - it creates NEW DOs!
 */
app.post('/destroy-by-id', requireAdmin, adminRateLimiter, async (c) => {
  const reqLogger = logger.child({ requestId: c.get('requestId') });

  try {
    const data = await c.req.json();
    const parsed = DestroyByIdSchema.safeParse(data);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0].message);
    }
    const { doId } = parsed.data;

    // CRITICAL: Use idFromString to get the ACTUAL existing DO by its hex ID
    // DO NOT use idFromName - it creates a NEW DO with the hex as its name!
    const doIdObj = c.env.CONTAINER.idFromString(doId);
    const container = c.env.CONTAINER.get(doIdObj);

    // DO NOT call getState() before destroy - it wakes up the DO and starts the container!
    // Just destroy directly
    await container.destroy();

    reqLogger.info('Container destroyed via admin endpoint', { doId });

    return c.json({
      success: true,
      doId,
      message: 'Container destroyed via raw DO ID',
    });
  } catch (err) {
    reqLogger.error('Admin destroy-by-id error', toError(err));

    if (err instanceof AuthError || err instanceof ValidationError) {
      throw err;
    }

    throw new AppError('ADMIN_ERROR', 500, toErrorMessage(err), 'Admin operation failed. Please try again.');
  }
});

export default app;
