import { createMockKV } from './mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
import type { Env } from '../../types';
import { beginMcpPortalConnect, finishMcpPortalConnect } from '../../lib/mcp-portal-token';

export const portal = { name: 'fixture', url: 'https://portal.example/mcp?codemode=search_and_execute' };
export const instance = 'https://instance.example';
export const access = 'SYNTHETIC-MCP-ACCESS', refresh = 'SYNTHETIC-MCP-REFRESH';
export async function mcpPortalFixture() {
  const kv = createMockKV();
  // Opaque encrypted read views model KV propagation without decrypting grants.
  const connectionKey = 'mcp-portal:owner:owner:portal:fixture';
  let connectionView: string | null | undefined;
  let afterConnectionWrite: (() => Promise<void>) | undefined;
  const get = kv.get.getMockImplementation()!;
  const put = kv.put.getMockImplementation()!;
  kv.get.mockImplementation(async (key, type) => key === connectionKey && connectionView !== undefined
    ? connectionView : get(key, type));
  kv.put.mockImplementation(async (key, value, opts) => {
    await put(key, value, opts);
    if (key === connectionKey && afterConnectionWrite) {
      const action = afterConnectionWrite; afterConnectionWrite = undefined; await action();
    }
  });
  await kv.put(SETUP_KEYS.MCP_PORTALS, JSON.stringify([portal]));
  await kv.put(SETUP_KEYS.CUSTOM_DOMAIN, 'instance.example');
  const env = { KV: kv, ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } as unknown as Env;
  let authorization: URL | undefined, expiresIn = 3600, rejectRefresh = false, omitRefreshedToken = false, token = access;
  let resource = 'https://portal.example/mcp', issuer = 'https://portal.example', cimd = false, dcr = true;
  let beforeToken: (() => Promise<void>) | undefined;
  let beforeDiscovery: (() => Promise<void>) | undefined;
  let beforeRefreshRejection: (() => Promise<void>) | undefined;
  let rotatingRefresh = false, currentRefresh = refresh, noRefreshToken = false;
  const issuedByCode = new Map<string, { resource: string; clientId: string }>();
  const send: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== 'https://portal.example') throw new Error('Synthetic fixture prohibits external I/O');
    if (url.pathname === '/mcp') return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://portal.example/.well-known/oauth-protected-resource"' } });
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      const concurrentAction = beforeDiscovery; beforeDiscovery = undefined;
      if (concurrentAction) await concurrentAction();
      return Response.json({ resource, authorization_servers: ['https://portal.example'], scopes_supported: ['mcp'] });
    }
    if (url.pathname.startsWith('/.well-known/')) return Response.json({ issuer,
      authorization_endpoint: 'https://portal.example/authorize', token_endpoint: 'https://portal.example/token',
      ...(cimd ? { client_id_metadata_document_supported: true } : {}),
      ...(dcr ? { registration_endpoint: 'https://portal.example/register' } : {}), revocation_endpoint: 'https://portal.example/revoke',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') return Response.json({ ...await request.json() as object, client_id: 'synthetic-client', token_endpoint_auth_method: 'none' }, { status: 201 });
    if (url.pathname === '/revoke') return new Response(null, { status: 200 });
    if (url.pathname === '/token') {
      if (beforeToken) await beforeToken();
      const body = new URLSearchParams(await request.text());
      // With DCR available, model an issuer unable to fetch this Access-protected
      // application's metadata URI; its dynamically registered client still works.
      if (body.get('client_id') !== (dcr ? 'synthetic-client' : `${instance}/auth/mcp/client-metadata`)) return Response.json({ error: 'invalid_client' }, { status: 400 });
      if (body.get('resource') !== resource) return Response.json({ error: 'invalid_target' }, { status: 400 });
      if (body.get('grant_type') === 'refresh_token') {
        if (rejectRefresh || body.get('refresh_token') !== currentRefresh) {
          if (beforeRefreshRejection) await beforeRefreshRejection();
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        if (rotatingRefresh) currentRefresh += '-ROTATED';
        token = `${access}-ROTATED`;
      } else {
        if (!authorization || body.get('code') !== 'synthetic-code' || body.get('redirect_uri') !== `${instance}/auth/mcp/callback`) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')!));
        const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        if (challenge !== authorization.searchParams.get('code_challenge')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        issuedByCode.set(body.get('code')!, { resource, clientId: body.get('client_id')! });
      }
      return Response.json({ access_token: token,
        ...(noRefreshToken || (body.get('grant_type') === 'refresh_token' && omitRefreshedToken) ? {} : { refresh_token: currentRefresh }),
        token_type: 'Bearer', expires_in: expiresIn });
    }
    throw new Error('Unexpected synthetic OAuth path');
  };
  const begin = async (owner = 'owner') => {
    authorization = new URL(await beginMcpPortalConnect(env, owner, portal, instance, send)); return authorization;
  };
  const finish = async (owner = 'owner') => {
    if (!authorization) throw new Error('Begin first');
    return finishMcpPortalConnect(env, owner, instance, authorization.searchParams.get('state')!, 'synthetic-code', undefined, send);
  };
  return { env, kv, send, begin, finish,
    async connectionSnapshot() { return await get(connectionKey) as string; },
    readConnection(value: string | null | undefined) { connectionView = value; },
    afterConnectionWrite(value: () => Promise<void>) { afterConnectionWrite = value; },
    get authorization() { return authorization!; },
    cimd() { cimd = true; dcr = false; },
    bothRegistrations() { cimd = true; dcr = true; },
    omitRefreshOnRenewal() { omitRefreshedToken = true; },
    withoutRefreshToken() { noRefreshToken = true; },
    expiry(seconds: number) { expiresIn = seconds; }, rejectRefresh() { rejectRefresh = true; },
    resource(value: string) { resource = value; }, issuer(value: string) { issuer = value; },
    beforeToken(value: () => Promise<void>) { beforeToken = value; },
    beforeDiscovery(value: () => Promise<void>) { beforeDiscovery = value; },
    beforeRefreshRejection(value: () => Promise<void>) { beforeRefreshRejection = value; },
    rotateRefresh() { rotatingRefresh = true; },
    issuedForCode(code: string) { return issuedByCode.get(code); },
  };
}
