import { Hono } from 'hono';
import type { Env } from '../types';
import { createLogger } from '../lib/logger';

const logger = createLogger('auth-redirects');

interface IdpEntry {
  id: string;
  type: string;
  name: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/login/:provider', async (c) => {
  const provider = c.req.param('provider');
  const idpList = await c.env.KV.get<IdpEntry[]>('setup:idp_list', 'json');

  if (!idpList) {
    return c.json({ error: 'No identity providers configured' }, 404);
  }

  const matched = idpList.find((p) => p.id === provider || p.type === provider);
  if (!matched) {
    return c.json({ error: 'Unknown provider' }, 404);
  }

  const customDomain = await c.env.KV.get('setup:custom_domain');

  if (!customDomain) {
    return c.json({ error: 'Auth not configured' }, 503);
  }

  // Fetch the protected URL server-side to capture CF Access's 302 redirect.
  // CF Access generates a login URL with a signed `meta` JWT that we can't forge.
  // We relay this redirect to the user's browser, appending the IdP hint.
  try {
    const probeRes = await fetch(`https://${customDomain}/app/`, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'Accept': 'text/html' },
    });

    const location = probeRes.headers.get('Location');
    if (location && location.includes('cdn-cgi/access/login')) {
      // Append idp parameter to pre-select the identity provider
      const separator = location.includes('?') ? '&' : '?';
      const loginUrl = `${location}${separator}idp=${matched.id}`;
      logger.info('Relaying CF Access login with IdP hint', { provider: matched.type });
      return c.redirect(loginUrl);
    }

    // If no Access redirect (user already authenticated or Access not configured),
    // fall through to direct redirect
    logger.warn('No CF Access redirect from /app/ probe', { status: probeRes.status });
  } catch (err) {
    logger.warn('Failed to probe /app/ for CF Access redirect', { error: String(err) });
  }

  // Fallback: redirect directly to /app/ and let CF Access handle naturally
  const loginUrl = `https://${customDomain}/app/`;

  logger.info('Redirecting to identity provider', { provider: matched.id, type: matched.type });

  return c.redirect(loginUrl);
});

app.get('/logout', async (c) => {
  const authDomain = await c.env.KV.get('setup:auth_domain');
  const appUrl = new URL(c.req.url);
  const returnTo = `${appUrl.protocol}//${appUrl.host}/`;

  if (authDomain) {
    return c.redirect(
      `https://${authDomain}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(returnTo)}`
    );
  }

  return c.redirect(returnTo);
});

export default app;
