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

  const authDomain = await c.env.KV.get('setup:auth_domain');
  const customDomain = await c.env.KV.get('setup:custom_domain');

  if (!authDomain || !customDomain) {
    return c.json({ error: 'Auth not configured' }, 503);
  }

  // CF Access login URL: path = protected hostname, idp = IdP UUID, redirect_url = relative path
  const loginUrl = `https://${authDomain}/cdn-cgi/access/login/${customDomain}?idp=${matched.id}&redirect_url=${encodeURIComponent('/app/')}`;

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
