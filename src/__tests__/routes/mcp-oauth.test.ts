import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createMcpOAuthRoutes, createMcpPortalApiRoutes, type McpOAuthDependencies } from '../../routes/mcp-oauth';
import { beginMcpPortalConnect, finishMcpPortalConnect, getMcpPortalGrant, getValidMcpPortalToken, disconnectMcpPortal } from '../../lib/mcp-portal-token';
import { mcpPortalFixture, portal, access, refresh } from '../helpers/mcp-portal-fixture';
import type { AuthVariables } from '../../middleware/auth';
import type { Env } from '../../types';
import { forwardMcpPortal } from '../../mcp-portal-interceptor';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { decryptFromKV, getOrImportKey } from '../../lib/kv-crypto';
import { setLogLevel } from '../../lib/logger';

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
    begin: (env, owner, portal, instance, _send, expectedGrantId) => beginMcpPortalConnect(env, owner, portal, instance, f.send, expectedGrantId),
    token: (env, owner, portal, _send, report) => getValidMcpPortalToken(env, owner, portal, f.send, report),
    finish: (env, owner, instance, state, code, issuer) => finishMcpPortalConnect(env, owner, instance, state, code, issuer, f.send),
    grant: getMcpPortalGrant,
    disconnect: (env, owner, portal) => disconnectMcpPortal(env, owner, portal, f.send),
  };
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.route('/auth/mcp', createMcpOAuthRoutes(deps)); app.route('/api/mcp-portals', createMcpPortalApiRoutes(deps));
  return { ...f, get authorization() { return f.authorization; }, app, env, retained, deps, request: (path: string, init?: RequestInit) => app.request(`https://instance.example${path}`, init, env) };
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

  it('REQ-AGENT-226 AC4: plaintext saved grants remain disconnected in the owner status API', async () => {
    const f = await fixture(); await f.begin(); await f.finish();
    const key = 'mcp-portal:owner:owner:portal:fixture';
    const stored = await f.kv.get(key) as string;
    await f.kv.put(key, await decryptFromKV(stored.slice(3), (await getOrImportKey(f.env))!, key));
    const response = await f.request('/api/mcp-portals');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ portals: [{ ...portal, connected: false }] });
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

  it('REQ-AGENT-226 AC1/2/7 / REQ-AGENT-228 AC4: explicit authorization again preserves the saved grant until successful replacement', async () => {
    const f = await fixture(); await f.begin(); await f.finish();
    const original = (await getMcpPortalGrant(f.env, 'owner', portal))!;
    const connect = await f.request('/auth/mcp/connect/fixture');
    expect(connect.status).toBe(302);
    const cancelled = new URL(connect.headers.get('Location')!);
    expect(cancelled.origin).toBe('https://portal.example');
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.id).toBe(original.id);
    const returned = await f.request(`/auth/mcp/callback?state=${cancelled.searchParams.get('state')}&error=access_denied`);
    expect(returned.headers.get('Location')).toBe('/app/?mcp=reconnect');
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.id).toBe(original.id);
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.access_token).toBe(original.tokens.access_token);
    expect(await (await f.request('/api/mcp-portals')).json()).toEqual({ portals: [{ ...portal, connected: true }] });
    const retry = await f.request('/auth/mcp/connect/fixture');
    expect(retry.status).toBe(302);
    f.visitAuthorization(retry.headers.get('Location')!);
    const completed = await f.request(`/auth/mcp/callback?state=${f.authorization.searchParams.get('state')}&code=synthetic-code`);
    expect(completed.headers.get('Location')).toBe('/app/?mcp=connected');
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.id).not.toBe(original.id);
    expect(await getValidMcpPortalToken(f.env, 'owner', portal, f.send)).toBe(access);
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

// Recovery maps only the existing owner grant lifecycle and bounded authorization intent.
const recoveryPath = '/api/mcp-portals/fixture/recover';
const recoveryRequest = (authorize = true): RequestInit => ({ method: 'POST',
  headers: { Origin: 'https://instance.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ authorize }) });

describe('Explicit owner MCP recovery', () => {
  it.each(['fresh', 'silent-refresh'] as const)('REQ-AGENT-226 AC5: %s returns ready without exposing Worker tokens or starting authorization', async mode => {
    const f = await fixture(); if (mode === 'silent-refresh') f.expiry(30);
    await f.begin(); await f.finish(); f.expiry(3600);
    const response = await f.request(recoveryPath, recoveryRequest(false));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ state: 'ready' });
    expect((await f.kv.list({ prefix: 'mcp-portal:pending:' })).keys).toHaveLength(0);
    expect((await getMcpPortalGrant(f.env, 'owner', portal))?.tokens.access_token).toBe(mode === 'fresh' ? access : `${access}-ROTATED`);
  });

  it.each(['no-refresh-token', 'invalid_grant'] as const)('REQ-AGENT-226 AC6 / REQ-AGENT-228 AC4: %s returns only a standard PKCE authorization URL when explicitly permitted', async failure => {
    const f = await fixture(); f.expiry(30); if (failure === 'no-refresh-token') f.withoutRefreshToken();
    await f.begin(); await f.finish(); if (failure === 'invalid_grant') f.rejectRefresh();
    const response = await f.request(recoveryPath, recoveryRequest());
    expect(response.status).toBe(200);
    const result = await response.json() as { state: string; url: string };
    expect(Object.keys(result).sort()).toEqual(['state', 'url']); expect(result.state).toBe('authorization');
    const url = new URL(result.url);
    expect(url.origin).toBe('https://portal.example'); expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://instance.example/auth/mcp/callback');
    for (const secret of [access, refresh, 'synthetic-code', 'invalid_grant']) expect(JSON.stringify(result)).not.toContain(secret);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await disconnectMcpPortal(f.env, 'owner', portal, f.send);
    const callback = await f.request(`/auth/mcp/callback?state=${url.searchParams.get('state')}&code=synthetic-code`);
    expect(callback.headers.get('Location')).toBe('/app/?mcp=reconnect');
    expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
  });

  it.each(['no-refresh-token', 'invalid_grant'] as const)('REQ-AGENT-228 AC4: authorize=false suppresses %s browser authorization', async failure => {
    const f = await fixture(); f.expiry(30); if (failure === 'no-refresh-token') f.withoutRefreshToken();
    await f.begin(); await f.finish(); f.rejectRefresh();
    expect(await (await f.request(recoveryPath, recoveryRequest(false))).json()).toEqual({ state: 'unavailable' });
    expect((await f.kv.list({ prefix: 'mcp-portal:pending:' })).keys).toHaveLength(0);
  });

  it('REQ-AGENT-226 AC6: browser recovery resumes the unchanged Pi placeholder request without disconnect', async () => {
    const f = await fixture(); f.expiry(30); f.withoutRefreshToken(); await f.begin(); await f.finish();
    const oldGrant = await getMcpPortalGrant(f.env, 'owner', portal);
    const request = new Request(portal.url, { method: 'POST', headers: {
      Authorization: 'Bearer codeflare-mcp-portal', 'Content-Type': 'application/json', 'Mcp-Session-Id': 'same-session',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect((await forwardMcpPortal(request.clone(), f.env, { bucket: 'owner', portals: [portal] }, f.send)).status).toBe(401);
    const recovery = await (await f.request(recoveryPath, recoveryRequest())).json() as { state: string; url: string };
    expect(recovery.state).toBe('authorization');
    f.visitAuthorization(recovery.url); f.expiry(3600);
    const state = new URL(recovery.url).searchParams.get('state');
    expect((await f.request(`/auth/mcp/callback?state=${state}&code=synthetic-code`)).headers.get('Location')).toBe('/app/?mcp=connected');
    const current = await getMcpPortalGrant(f.env, 'owner', portal);
    expect(current?.id).not.toBe(oldGrant?.id);
    expect(await (await f.request(recoveryPath, recoveryRequest(false))).json()).toEqual({ state: 'ready' });
    const response = await forwardMcpPortal(request.clone(), f.env, { bucket: 'owner', portals: [portal] }, async input => {
      const forwarded = input as Request;
      expect(forwarded.headers.get('Authorization')).toBe(`Bearer ${current!.tokens.access_token}`);
      expect(forwarded.headers.get('Mcp-Session-Id')).toBe('same-session');
      expect(await forwarded.json()).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      return Response.json({ recovered: true });
    });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ recovered: true });
    expect(request.headers.get('Authorization')).toBe('Bearer codeflare-mcp-portal');
  });

  it.each(['missing', 'new', 'changed', 'other-owner', 'tombstone'] as const)('REQ-AGENT-226 AC6: %s grants are ineligible without OAuth', async change => {
    const f = await fixture();
    if (change !== 'missing' && change !== 'new') { await f.begin(); await f.finish(); }
    if (change === 'new') await f.begin();
    if (change === 'changed') await f.kv.put(SETUP_KEYS.MCP_PORTALS, JSON.stringify([{ ...portal, url: 'https://changed.example/mcp' }]));
    if (change === 'other-owner') actor = 'other';
    if (change === 'tombstone') await disconnectMcpPortal(f.env, 'owner', portal, f.send);
    const before = await f.kv.list({ prefix: 'mcp-portal:pending:' });
    expect(await (await f.request(recoveryPath, recoveryRequest())).json()).toEqual({ state: 'ineligible' });
    expect((await f.kv.list({ prefix: 'mcp-portal:pending:' })).keys).toEqual(before.keys);
  });

  it('REQ-AGENT-228 AC4: recovery rejects service identities, cross-origin admission and invalid request intent', async () => {
    const f = await fixture(); await f.begin(); await f.finish();
    actor = 'anonymous'; expect((await f.request(recoveryPath, recoveryRequest())).status).toBe(401); actor = 'owner';
    for (const header of ['Authorization', 'X-Service-Auth', 'CF-Access-Client-Id', 'CF-Access-Client-Secret']) {
      expect((await f.request(recoveryPath, { ...recoveryRequest(), headers: { Origin: 'https://instance.example', [header]: 'service' } })).status).toBe(401);
    }
    for (const headers of [{}, { Origin: 'https://other.example' }, { Origin: 'https://instance.example', 'Sec-Fetch-Site': 'cross-site' }] as HeadersInit[]) {
      expect((await f.request(recoveryPath, { ...recoveryRequest(), headers })).status).toBe(403);
    }
    for (const body of ['{}', 'null', '[]', '{', '{"authorize":"true"}', '{"authorize":true,"setting":true}']) {
      expect((await f.request(recoveryPath, { ...recoveryRequest(), body })).status).toBe(400);
    }
    expect((await f.kv.list({ prefix: 'mcp-portal:pending:' })).keys).toHaveLength(0);
  });

  it.each(['timeout', 'server_error', 'invalid_client', 'invalid_request', 'temporarily_unavailable'] as const)('REQ-AGENT-226 AC6: %s refresh failure cannot mint authorization', async detail => {
    const f = await fixture(); f.expiry(30); await f.begin(); await f.finish();
    f.deps.token = (env, owner, configured, _send, report) => getValidMcpPortalToken(env, owner, configured, async () => {
      if (detail === 'timeout') throw new DOMException('Synthetic timeout', 'TimeoutError');
      return Response.json({ error: detail }, { status: detail === 'server_error' ? 500 : 400 });
    }, report);
    expect(await (await f.request(recoveryPath, recoveryRequest())).json()).toEqual({ state: 'unavailable' });
    expect((await f.kv.list({ prefix: 'mcp-portal:pending:' })).keys).toHaveLength(0);
  });

  it.each(['disconnect', 'configuration', 'generation'] as const)('REQ-AGENT-226 AC6: observed %s between refresh failure and begin cannot start recovery', async change => {
    const f = await fixture(); f.expiry(30); await f.begin(); await f.finish(); f.rejectRefresh();
    const token = f.deps.token;
    f.deps.token = async (...args) => {
      const result = await token(...args);
      if (change === 'disconnect') await disconnectMcpPortal(f.env, 'owner', portal, f.send);
      if (change === 'configuration') await f.kv.put(SETUP_KEYS.MCP_PORTALS, '[]');
      if (change === 'generation') { await f.begin(); await f.finish(); }
      return result;
    };
    expect(await (await f.request(recoveryPath, recoveryRequest())).json()).toEqual({ state: 'unavailable' });
    expect((await f.kv.list({ prefix: 'mcp-portal:pending:' })).keys).toHaveLength(0);
  });

  it.each(['lookup-unavailable', 'lookup-throws', 'concurrent-change', 'readback-rejected'] as const)(
    'REQ-AGENT-226 AC6: %s cannot authorize browser recovery', async reason => {
      const f = await fixture(); await f.begin(); await f.finish();
      f.deps.token = async (_env, _owner, _portal, _send, report) => {
        report?.({ reason });
        if (reason === 'lookup-throws') throw Error('Synthetic secret-bearing lookup error');
        return null;
      };
      const response = await f.request(recoveryPath, recoveryRequest());
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ state: 'unavailable' });
      expect((await f.kv.list({ prefix: 'mcp-portal:pending:' })).keys).toHaveLength(0);
    });

  it('REQ-AGENT-228 AC4: recovery requires the current configured instance origin', async () => {
    const f = await fixture(); await f.begin(); await f.finish();
    await f.kv.put(SETUP_KEYS.CUSTOM_DOMAIN, 'changed.example');
    expect((await f.request(recoveryPath, { ...recoveryRequest(), headers: { Origin: 'https://changed.example' } })).status).toBe(400);
    expect((await f.kv.list({ prefix: 'mcp-portal:pending:' })).keys).toHaveLength(0);
  });

});

// Fixed stage and confidentiality are intentional diagnostics contracts. Route
// status, callback outcome and grant publication remain the observable behavior.
describe('MCP route diagnostics preserve clean outcomes', () => {
  it.each(['validation', 'registration', 'exchange', 'cancelled'] as const)(
    '%s reports only a fixed stage/error classification and keeps the existing route outcome', async failure => {
      const f = await fixture();
      const secret = 'SYNTHETIC-ROUTE-SECRET owner-private@example.test https://private.example/callback';
      let callbackState = '';
      if (failure === 'exchange' || failure === 'cancelled') {
        await f.begin(); callbackState = f.authorization.searchParams.get('state')!;
      }
      const send: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if ((failure === 'registration' && url.pathname === '/register') || (failure === 'exchange' && url.pathname === '/token')) {
          return Response.json({ error: failure === 'registration' ? 'invalid_client_metadata' : 'invalid_grant',
            error_description: secret, error_uri: secret, access_token: access, refresh_token: refresh }, { status: 400 });
        }
        return f.send(input, init);
      };
      f.deps.begin = (env, owner, configured, instance, _send, expected) => beginMcpPortalConnect(env, owner, configured, instance, send, expected);
      f.deps.finish = (env, owner, instance, state, code, issuer) => finishMcpPortalConnect(env, owner, instance, state, code, issuer, send);
      const records: string[] = [];
      const spies = (['log', 'warn', 'error'] as const).map(level => vi.spyOn(console, level)
        .mockImplementation(line => { records.push(String(line)); }));
      setLogLevel('info');
      try {
        const response = await f.request(failure === 'registration' ? '/auth/mcp/connect/fixture'
          : failure === 'validation' ? `/auth/mcp/callback?state=${encodeURIComponent(secret)}&code=${encodeURIComponent(secret)}&unexpected=1`
            : `/auth/mcp/callback?state=${callbackState}&${failure === 'cancelled' ? 'error=access_denied' : 'code=synthetic-code'}&error_description=${encodeURIComponent(secret)}`);
        expect(response.status).toBe(failure === 'registration' ? 502 : 303);
        if (failure === 'registration') expect(await response.clone().json()).toEqual({
          error: 'MCP portal connection unavailable. Return to Settings and reconnect.', code: 'MCP_CONNECT_FAILED',
        });
        else expect(response.headers.get('Location')).toBe('/app/?mcp=reconnect');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
        expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
        const stages = { validation: 'callback-validation', registration: 'registration', exchange: 'code-exchange', cancelled: 'authorization-response' };
        expect(records.map(line => {
          const record = JSON.parse(line);
          expect(Object.keys(record).sort()).toEqual(['data', 'level', 'message', 'module', 'timestamp']);
          return { ...record, timestamp: undefined };
        })).toEqual([{ timestamp: undefined, level: 'warn', module: 'mcp-portal-oauth', message: 'MCP OAuth outcome', data: {
          operation: failure === 'registration' ? 'connect' : 'callback', stage: stages[failure], outcome: 'rejected',
          detail: failure === 'registration' ? 'invalid_client_metadata' : failure === 'exchange' ? 'invalid_grant' : 'other',
        } }]);
        const artifacts = JSON.stringify({ records, headers: [...response.headers], body: await response.text(), retained: f.retained });
        for (const forbidden of [secret, access, refresh, 'synthetic-code', ...(callbackState ? [callbackState] : [])]) {
          expect(artifacts).not.toContain(forbidden);
        }
      } finally { spies.forEach(spy => spy.mockRestore()); setLogLevel('silent'); }
    });

  it('a logging transport failure cannot replace callback validation redirect', async () => {
    const f = await fixture(); setLogLevel('warn');
    const output = vi.spyOn(console, 'warn').mockImplementation(() => { throw Error('synthetic log transport unavailable'); });
    try {
      const response = await f.request('/auth/mcp/callback?state=invalid&code=synthetic-code&unexpected=1');
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe('/app/?mcp=reconnect');
      expect(await getMcpPortalGrant(f.env, 'owner', portal)).toBeNull();
    } finally { output.mockRestore(); setLogLevel('silent'); }
  });
});
