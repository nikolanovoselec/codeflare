/**
 * Session routes aggregator
 * Combines CRUD and lifecycle routes into a single Hono app
 */
import { Hono } from 'hono';
import type { Env } from '../../types';
import { authMiddleware, AuthVariables } from '../../middleware/auth';
import crudRoutes from './crud';
import lifecycleRoutes from './lifecycle';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Apply shared auth middleware to all session routes
app.use('*', authMiddleware);

// Mount lifecycle routes FIRST — static /batch-status must register before CRUD's parametric /:id,
// otherwise Hono matches /:id with id='batch-status' and returns 404.
app.route('/', lifecycleRoutes);

// Mount CRUD routes (/, /:id, /:id/touch)
app.route('/', crudRoutes);

export default app;
