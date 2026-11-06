import { Hono, type MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import type { AuthVariables } from '../middleware/auth';
import { getBaseUrl } from '../lib/kv-keys';
import { getConfiguredMcpPortals } from '../lib/mcp-portals';
import { beginMcpPortalConnect, finishMcpPortalConnect, getMcpPortalGrant, disconnectMcpPortal,
  mcpPortalClientMetadata, MCP_CLIENT_METADATA_PATH, publicHttps } from '../lib/mcp-portal-token';
import { createRateLimiter } from '../middleware/rate-limit';
import { authenticateRequest } from '../lib/access';
import { isSessionOidcMode } from '../lib/onboarding';
import { isActiveTier, getEffectiveTier, isEnterpriseMode } from '../lib/subscription';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
export interface McpOAuthDependencies {
  authenticate: typeof authenticateRequest;
  begin: typeof beginMcpPortalConnect; finish: typeof finishMcpPortalConnect;
  grant: typeof getMcpPortalGrant; disconnect: typeof disconnectMcpPortal;
}
const defaults: McpOAuthDependencies = { authenticate: authenticateRequest, begin: beginMcpPortalConnect, finish: finishMcpPortalConnect,
  grant: getMcpPortalGrant, disconnect: disconnectMcpPortal };

function ownerAuthentication(authenticate: typeof authenticateRequest): MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> {
  return async (c, next) => {
    for (const [key, value] of Object.entries(headers)) c.header(key, value);
    // Human identity only; unsigned identity headers and service tokens cannot own grants.
    if (['Authorization', 'X-Service-Auth', 'CF-Access-Client-Id', 'CF-Access-Client-Secret'].some(h => c.req.header(h))) {
      return c.json({ error: 'Sign in to manage MCP portals', code: 'MCP_OWNER_REQUIRED' }, 401);
    }
    const original = c.req.raw;
    const clean = new URL(original.url); clean.search = ''; clean.hash = '';
    const identityHeaders = new Headers(original.headers);
    identityHeaders.delete('cf-access-authenticated-user-email');
    let identity: Awaited<ReturnType<typeof authenticateRequest>>;
    try { identity = await authenticate(new Request(clean, { method: original.method, headers: identityHeaders }), c.env); }
    catch { return c.json({ error: 'Sign in to manage MCP portals', code: 'MCP_OWNER_REQUIRED' }, 401); }
    c.set('user', identity.user); c.set('bucketName', identity.bucketName);
    if (isSessionOidcMode(c.env) && !isEnterpriseMode(c.env)) {
      const user = identity.user;
      const tier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd, c.env);
      if (!isActiveTier(tier)) return c.json({ error: 'Access denied', code: tier === 'blocked' ? 'BLOCKED' : 'PENDING' }, 403);
    }
    return next();
  };
}

/** One owner-authenticated surface in every deployment mode; no container/session lookup. */
export function createMcpOAuthRoutes(deps: McpOAuthDependencies = defaults) {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  // Public client metadata is not an OAuth issuer or a credential/configuration service.
  // Authorization servers supporting CIMD fetch this fixed document themselves.
  app.get('/client-metadata', async c => {
    const base = new URL(await getBaseUrl(c.env.KV, c.req.url)).origin;
    if (publicHttps(base).origin !== new URL(c.req.url).origin) return c.notFound();
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
    return c.json({ client_id: `${base}${MCP_CLIENT_METADATA_PATH}`, ...mcpPortalClientMetadata(base) });
  });
  app.use('*', ownerAuthentication(deps.authenticate));
  app.use('*', createRateLimiter({ windowMs: 60_000, maxRequests: 20, keyPrefix: 'mcp-connect' }));
  app.get('/connect/:name', async c => {
    const portal = (await getConfiguredMcpPortals(c.env.KV)).find(p => p.name === c.req.param('name'));
    if (!portal) return c.json({ error: 'MCP portal not configured', code: 'MCP_NOT_CONFIGURED' }, 404);
    const base = new URL(await getBaseUrl(c.env.KV, c.req.url)).origin;
    if (new URL(c.req.url).origin !== base || !base.startsWith('https://')) return c.json({ error: 'Use the configured instance URL' }, 400);
    try { return c.redirect(await deps.begin(c.env, c.get('bucketName'), portal, base)); }
    catch { return c.json({ error: 'MCP portal connection unavailable. Return to Settings and reconnect.', code: 'MCP_CONNECT_FAILED' }, 502); }
  });
  app.get('/callback', async c => {
    try {
      const url = new URL(c.req.url), q = url.searchParams;
      const base = new URL(await getBaseUrl(c.env.KV, c.req.url)).origin;
      if (url.protocol !== 'https:' || url.origin !== base || [...q.keys()].some(k => !['state', 'code', 'iss', 'error', 'error_description'].includes(k))
        || [...new Set(q.keys())].some(k => q.getAll(k).length !== 1) || !q.get('state') || (q.has('code') === q.has('error'))) throw new Error('Invalid callback');
      await deps.finish(c.env, c.get('bucketName'), base, q.get('state')!, q.has('error') ? null : q.get('code'), q.get('iss') ?? undefined);
      return c.redirect('/app/?mcp=connected', 303);
    } catch { return c.redirect('/app/?mcp=reconnect', 303); }
  });
  return app;
}

/** API routes retain the standard active-user authorization and explicit same-origin mutation admission. */
export function createMcpPortalApiRoutes(deps: McpOAuthDependencies = defaults) {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', ownerAuthentication(deps.authenticate));
  app.get('/', async c => {
    const portals = await getConfiguredMcpPortals(c.env.KV);
    return c.json({ portals: await Promise.all(portals.map(async portal => {
      let connected = false;
      try { const grant = await deps.grant(c.env, c.get('bucketName'), portal);
        connected = !!grant && (!grant.expiresAt || grant.expiresAt > Date.now() || !!grant.tokens.refresh_token);
      } catch { /* Missing encryption/configuration is disconnected, not a secret-bearing error. */ }
      return { ...portal, connected };
    })) });
  });
  app.post('/:name/disconnect', async c => {
    const base = new URL(await getBaseUrl(c.env.KV, c.req.url)).origin;
    if (c.req.header('Origin') !== base || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: 'Origin denied' }, 403);
    const portal = (await getConfiguredMcpPortals(c.env.KV)).find(p => p.name === c.req.param('name'));
    if (!portal) return c.json({ error: 'MCP portal not configured' }, 404);
    await deps.disconnect(c.env, c.get('bucketName'), portal);
    return c.json({ success: true });
  });
  return app;
}
export default createMcpOAuthRoutes();
