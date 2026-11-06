import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createMcpOAuthRoutes, createMcpPortalApiRoutes, type McpOAuthDependencies } from '../../routes/mcp-oauth';
import { beginMcpPortalConnect, finishMcpPortalConnect, getMcpPortalGrant, disconnectMcpPortal } from '../../lib/mcp-portal-token';
import { mcpPortalFixture, portal, access, refresh } from '../helpers/mcp-portal-fixture';
import type { AuthVariables } from '../../middleware/auth';
import type { Env } from '../../types';

let actor = 'owner';
async function fixture(mode = '') {
  actor = 'owner';
  const f = await mcpPortalFixture();
  const env = { ...f.env, ...(mode === 'enterprise' ? { ENTERPRISE_MODE: 'active' } : mode === 'saas' ? { SAAS_MODE: 'active' } : {}) } as Env;
  const retained: string[] = [];
  const deps: McpOAuthDependencies = {
    authenticate: async request => {
      retained.push(request.url);
      if (actor === 'anonymous' || request.headers.has('cf-access-authenticated-user-email')) throw Error('Denied');
      return { bucketName: actor, user: { email: `${actor}@example.com`, authenticated: true, subscriptionTier: 'free' } };
    },
    begin: (env, owner, portal, instance) => beginMcpPortalConnect(env, owner, portal, instance, f.send),
    finish: (env, owner, instance, state, code, issuer) => finishMcpPortalConnect(env, owner, instance, state, code, issuer, f.send),
    grant: getMcpPortalGrant,
    disconnect: (env, owner, portal) => disconnectMcpPortal(env, owner, portal, f.send),
  };
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.route('/auth/mcp', createMcpOAuthRoutes(deps)); app.route('/api/mcp-portals', createMcpPortalApiRoutes(deps));
  return { ...f, get authorization() { return f.authorization; }, app, env, retained, request: (path: string, init?: RequestInit) => app.request(`https://instance.example${path}`, init, env) };
}

describe('Settings MCP owner OAuth and non-secret status API', () => {
  it.each(['default', 'saas', 'enterprise'])('REQ-AGENT-226 AC3: %s uses browser OAuth and clean owner-bound completion without compute startup', async mode => {
    const f = await fixture(mode);
    expect(await (await f.request('/api/mcp-portals')).json()).toEqual({ portals: [{ ...portal, connected: false }] });
    // The fixture establishes a genuine synthetic PKCE authorization URL and verifier.
    await f.begin();
    const state = f.authorization.searchParams.get('state')!;
    const response = await f.request(`/auth/mcp/callback?state=${state}&code=synthetic-code`, { headers: { 'cf-access-authenticated-user-email': 'forged@example.com' } });
    expect(response.status).toBe(303); expect(response.headers.get('Location')).toBe('/app/?mcp=connected');
    expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const status = await (await f.request('/api/mcp-portals')).text();
    expect(JSON.parse(status)).toEqual({ portals: [{ ...portal, connected: true }] });
    const artifacts = JSON.stringify({ retained: f.retained, status, headers: [...response.headers], body: await response.text() });
    for (const secret of [access, refresh, 'synthetic-code', state]) expect(artifacts).not.toContain(secret);
    actor = 'other'; expect(await (await f.request('/api/mcp-portals')).json()).toEqual({ portals: [{ ...portal, connected: false }] });
  });

  it('REQ-AGENT-226 AC3: authorization servers can read only fixed non-secret public client metadata', async () => {
    const f = await fixture(); actor = 'anonymous';
    const response = await f.request('/auth/mcp/client-metadata');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ client_id: 'https://instance.example/auth/mcp/client-metadata',
      redirect_uris: ['https://instance.example/auth/mcp/callback'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' });
  });

  it('REQ-AGENT-226 AC2: connect navigates only to the configured portal and callback rejects malformed, wrong-owner and replayed returns', async () => {
    const f = await fixture();
    const connect = await f.request('/auth/mcp/connect/fixture');
    expect(connect.status).toBe(302); expect(new URL(connect.headers.get('Location')!).origin).toBe('https://portal.example');
    expect((await f.request('/auth/mcp/connect/unconfigured')).status).toBe(404);
    await f.begin(); const state = f.authorization.searchParams.get('state')!;
    actor = 'other';
    expect((await f.request(`/auth/mcp/callback?state=${state}&code=synthetic-code`)).headers.get('Location')).toBe('/app/?mcp=reconnect');
    actor = 'owner';
    expect((await f.request(`/auth/mcp/callback?state=${state}&code=synthetic-code&code=duplicate`)).headers.get('Location')).toBe('/app/?mcp=reconnect');
    expect((await f.request(`/auth/mcp/callback?state=${state}&code=synthetic-code&iss=https://other.example`)).headers.get('Location')).toBe('/app/?mcp=reconnect');
    expect((await f.request(`/auth/mcp/callback?state=${state}&code=synthetic-code`)).headers.get('Location')).toBe('/app/?mcp=connected');
    expect((await f.request(`/auth/mcp/callback?state=${state}&code=synthetic-code`)).headers.get('Location')).toBe('/app/?mcp=reconnect');
  });

  it('REQ-AGENT-226 AC2: anonymous, service and forged header identities cannot own portal grants', async () => {
    const f = await fixture(); actor = 'anonymous';
    expect((await f.request('/auth/mcp/connect/fixture')).status).toBe(401);
    expect((await f.request('/api/mcp-portals')).status).toBe(401);
    actor = 'owner';
    for (const header of ['Authorization', 'X-Service-Auth', 'CF-Access-Client-Id', 'CF-Access-Client-Secret']) {
      expect((await f.request('/auth/mcp/connect/fixture', { headers: { [header]: 'synthetic-service-credential' } })).status).toBe(401);
      expect((await f.request('/api/mcp-portals', { headers: { [header]: 'synthetic-service-credential' } })).status).toBe(401);
    }
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
  });

  it('REQ-AGENT-226 AC7: same-origin disconnect clears only the authenticated owner portal', async () => {
    const f = await fixture(); await f.begin(); await f.finish();
    const path = '/api/mcp-portals/fixture/disconnect';
    for (const origin of [undefined, 'https://other.example']) expect((await f.request(path, {
      method: 'POST', headers: origin ? { Origin: origin } : {},
    })).status).toBe(403);
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.access_token).toBe(access);
    const response = await f.request(path, { method: 'POST', headers: { Origin: 'https://instance.example' } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true });
    expect(await (await f.request('/api/mcp-portals')).json()).toEqual({ portals: [{ ...portal, connected: false }] });
  });
});
