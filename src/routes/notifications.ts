import { Hono } from 'hono';
import type { Env } from '../types';
import { authMiddleware, type AuthVariables } from '../middleware/auth';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

/** Compile-only Phase 1 route seams. Behavior follows the red CI receipt. */
app.get('/config', (c) => c.json({ error: 'Not implemented' }, 501));
app.post('/subscription', (c) => c.json({ error: 'Not implemented' }, 501));
app.delete('/subscription', (c) => c.json({ error: 'Not implemented' }, 501));

export default app;
