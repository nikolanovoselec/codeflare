import { Hono, type MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import type { AuthVariables } from '../middleware/auth';
import { getBaseUrl } from '../lib/kv-keys';
import { getConfiguredMcpPortals } from '../lib/mcp-portals';
import { beginMcpPortalConnect, finishMcpPortalConnect, getMcpPortalGrant, disconnectMcpPortal,
  getValidMcpPortalToken, type McpPortalTokenFailure, mcpPortalClientMetadata, MCP_CLIENT_METADATA_PATH, publicHttps } from '../lib/mcp-portal-token';
import { createRateLimiter } from '../middleware/rate-limit';
import { authenticateRequest } from '../lib/access';
import { isSessionOidcMode } from '../lib/onboarding';
import { isActiveTier, getEffectiveTier, isEnterpriseMode } from '../lib/subscription';
import { createLogger } from '../lib/logger';

const logger = createLogger('mcp-portal-oauth');

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
export interface McpOAuthDependencies {
  authenticate: typeof authenticateRequest;
  begin: typeof beginMcpPortalConnect; finish: typeof finishMcpPortalConnect;
  grant: typeof getMcpPortalGrant; disconnect: typeof disconnectMcpPortal;
  token: typeof getValidMcpPortalToken;
}
const defaults: McpOAuthDependencies = { authenticate: authenticateRequest, begin: beginMcpPortalConnect, finish: finishMcpPortalConnect,
  grant: getMcpPortalGrant, disconnect: disconnectMcpPortal, token: getValidMcpPortalToken };

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
    let validating = true;
    try {
      const url = new URL(c.req.url), q = url.searchParams;
      const base = new URL(await getBaseUrl(c.env.KV, c.req.url)).origin;
      if (url.protocol !== 'https:' || url.origin !== base || [...q.keys()].some(k => !['state', 'code', 'iss', 'error', 'error_description'].includes(k))
        || [...new Set(q.keys())].some(k => q.getAll(k).length !== 1) || !q.get('state') || (q.has('code') === q.has('error'))) throw new Error('Invalid callback');
      validating = false;
      await deps.finish(c.env, c.get('bucketName'), base, q.get('state')!, q.has('error') ? null : q.get('code'), q.get('iss') ?? undefined);
      return c.redirect('/app/?mcp=connected', 303);
    } catch {
      if (validating) {
        try {
          logger.warn('MCP OAuth outcome', { operation: 'callback', stage: 'callback-validation', outcome: 'rejected', detail: 'other' });
        } catch { /* Logging cannot replace the fixed callback outcome. */ }
      }
      return c.redirect('/app/?mcp=reconnect', 303);
    }
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
  // REQ-AGENT-226 AC5/6, REQ-AGENT-228 AC4: explicit, owner-bound recovery only.
  app.post('/:name/recover', createRateLimiter({ windowMs: 60_000, maxRequests: 20, keyPrefix: 'mcp-recover' }), async c => {
    try {
      const base = new URL(await getBaseUrl(c.env.KV, c.req.url)).origin;
      if (c.req.header('Origin') !== base || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: 'Origin denied' }, 403);
      if (new URL(c.req.url).origin !== base || !base.startsWith('https://')) return c.json({ error: 'Use the configured instance URL' }, 400);
      let body: unknown;
      try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid recovery intent' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !('authorize' in body)
        || typeof body.authorize !== 'boolean' || Object.keys(body).length !== 1) return c.json({ error: 'Invalid recovery intent' }, 400);
      const portal = (await getConfiguredMcpPortals(c.env.KV)).find(p => p.name === c.req.param('name'));
      if (!portal) return c.json({ state: 'ineligible' });
      const owner = c.get('bucketName');
      const grant = await deps.grant(c.env, owner, portal);
      if (!grant || grant.instance !== base) return c.json({ state: 'ineligible' });
      const observed: { failure?: McpPortalTokenFailure } = {};
      const token = await deps.token(c.env, owner, portal, undefined, result => { observed.failure = result; });
      if (token) return c.json({ state: 'ready' });
      const failure = observed.failure;
      if (!body.authorize || !(failure?.reason === 'no-refresh-token'
        || (failure?.reason === 'refresh-error' && failure.detail === 'invalid_grant'))) return c.json({ state: 'unavailable' });
      const current = await deps.grant(c.env, owner, portal);
      if (!current || current.id !== grant.id || current.instance !== base) return c.json({ state: 'unavailable' });
      const url = await deps.begin(c.env, owner, portal, base, undefined, grant.id);
      return c.json({ state: 'authorization', url });
    } catch { return c.json({ state: 'unavailable' }); }
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
