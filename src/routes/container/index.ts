/**
 * Container routes index
 * Combines lifecycle, status, and debug routes with shared auth middleware
 */
import { Hono } from 'hono';
import type { Env } from '../../types';
import { authMiddleware, AuthVariables } from '../../middleware/auth';
import lifecycleRoutes from './lifecycle';
import statusRoutes from './status';
import debugRoutes from './debug';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Use shared auth middleware for all container routes
app.use('*', authMiddleware);

// Mount route modules
app.route('/', lifecycleRoutes);
app.route('/', statusRoutes);
app.route('/', debugRoutes);

export default app;
