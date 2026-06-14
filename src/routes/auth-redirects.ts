import { Hono } from 'hono';
import type { Env } from '../types';
import { createLogger } from '../lib/logger';
import { isSaasModeActive, isSessionOidcMode } from '../lib/onboarding';
import { SETUP_KEYS } from '../lib/kv-keys';

const logger = createLogger('auth-redirects');

const app = new Hono<{ Bindings: Env }>();

// Login: SaaS mode redirects to GitHub OIDC, default mode uses CF Access.
app.get('/login/:provider', async (c) => {
  // SaaS mode with GitHub OIDC
  if (isSaasModeActive(c.env.SAAS_MODE) && c.env.OAUTH_CLIENT_ID) {
    return c.redirect('/auth/github/login');
  }

  // Default mode: redirect to /app/ and let CF Access handle authentication
  const customDomain = await c.env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN);
  if (!customDomain) {
    return c.json({ error: 'Auth not configured' }, 503);
  }

  logger.info('Redirecting to /app/ for CF Access auth', { provider: c.req.param('provider') });
  return c.redirect(`https://${customDomain}/app/`);
});

app.get('/logout', async (c) => {
  // SaaS AND onboarding modes issue the app's own GitHub-OIDC session cookie, so
  // logout clears it via the GitHub logout route. Enterprise / default deployments
  // delegate to Cloudflare Access logout instead (below). Onboarding must route
  // here too: sending it to the CF Access logout endpoint makes Access reject the
  // returnTo as an invalid redirect URL.
  if (isSessionOidcMode(c.env) && c.env.OAUTH_CLIENT_ID) {
    return c.redirect('/auth/github/logout');
  }

  // Default mode: CF Access logout
  const authDomain = await c.env.KV.get(SETUP_KEYS.AUTH_DOMAIN);
  const customDomain = await c.env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN);
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
