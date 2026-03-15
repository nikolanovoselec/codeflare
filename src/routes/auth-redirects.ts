import { Hono } from 'hono';
import type { Env } from '../types';
import { createLogger } from '../lib/logger';

const logger = createLogger('auth-redirects');

const app = new Hono<{ Bindings: Env }>();

// Login: redirect to /app/ and let CF Access handle authentication.
// For path-scoped Access apps there is no supported way to pre-select an IdP
// via URL parameters — the CF Access login page shows all configured IdPs.
app.get('/login/:provider', async (c) => {
  const customDomain = await c.env.KV.get('setup:custom_domain');
  if (!customDomain) {
    return c.json({ error: 'Auth not configured' }, 503);
  }

  logger.info('Redirecting to /app/ for CF Access auth', { provider: c.req.param('provider') });
  return c.redirect(`https://${customDomain}/app/`);
});

app.get('/logout', async (c) => {
  const authDomain = await c.env.KV.get('setup:auth_domain');
  const customDomain = await c.env.KV.get('setup:custom_domain');
  // Redirect to custom domain root after logout (login page)
  const returnTo = customDomain
    ? `https://${customDomain}/`
    : `${new URL(c.req.url).protocol}//${new URL(c.req.url).host}/`;

  if (authDomain) {
    return c.redirect(
      `https://${authDomain}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(returnTo)}`
    );
  }

  return c.redirect(returnTo);
});

export default app;
