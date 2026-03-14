import { Hono } from 'hono';
import type { Env } from '../types';
import { requireIdentity, type AuthVariables } from '../middleware/auth';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Public — no authentication required
app.get('/providers', async (c) => {
  const idpList = await c.env.KV.get('setup:idp_list', 'json');
  return c.json({ providers: idpList || [] });
});

// Requires identity (pending users can access)
app.get('/status', requireIdentity, async (c) => {
  const user = c.get('user');
  return c.json({
    email: user.email,
    accessTier: user.accessTier || 'advanced',
    role: user.role || 'user',
  });
});

export default app;
