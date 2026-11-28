import { afterEach, expect, it, vi } from 'vitest';
import { wireContainerInterception, type InterceptionHost } from '../../container/container-interception';
import { CloudflareBrowserInterceptor } from '../../cloudflare-browser-interceptor';
import { LlmInterceptor } from '../../llm-interceptor';
import { GitHubInterceptor } from '../../github-interceptor';
import { EgressController } from '../../egress-controller';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { clearCloudflareConnection, storeCloudflareConnection } from '../../lib/cloudflare-token';
import { createMockKV } from '../helpers/mock-kv';
import type { Env } from '../../types';
import type { OperatorPolicy } from '../../operators/policy';
import { executeBrowserAction } from '../../../preseed/agents/pi/extensions/browser-run-helpers';

afterEach(() => vi.restoreAllMocks());

// The Container SDK transport is the only registration substitute. It dispatches
// exact hosts before its catch-all; every registered Worker entrypoint is real.
async function registered({ enterprise = true, strict = false, token = 'admin-browser-token',
  account = 'acc', bucket = 'user-bucket', containerToken = 'codeflare-oauth',
  upstream = undefined as Response | undefined, inspectedUpstream = undefined as Response | undefined,
  gatewayBound = true, gatewayThrows = false, connected = true, ownerAccount = 'owner-account', oauthConfigured = true,
  source = 'oauth' as 'oauth' | 'pat', operatorPolicy = undefined as InterceptionHost['_operatorPolicy'] } = {}) {
  const kv = createMockKV();
  if (token) kv._set(SETUP_KEYS.BROWSER_RENDER_TOKEN, { token });
  if (account) kv._store.set(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID, account);
  if (oauthConfigured) {
    kv._store.set(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID, 'configured-client');
    kv._set(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_SECRET, { secret: 'configured-client-secret' });
  }
  const direct: Request[] = [];
  const inspected: Request[] = [];
  const env = { KV: kv, ENTERPRISE_MODE: enterprise ? 'active' : undefined,
    EGRESS: gatewayBound ? { fetch: async (request: Request) => {
      inspected.push(request);
      if (gatewayThrows) throw new Error('Gateway unavailable');
      return inspectedUpstream ?? new Response('gateway-response');
    } } : undefined } as unknown as Env;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    direct.push(input as Request);
    return upstream ?? new Response('browser-response');
  });
  if (connected) await storeCloudflareConnection(env, 'user-bucket', { accessToken: 'owner-oauth-token',
    accountId: ownerAccount, source,
    expiresAt: Date.now() + 3_600_000 });
  const handlers = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const entrypoints = { CloudflareBrowserInterceptor, LlmInterceptor, GitHubInterceptor, EgressController };
  const exports = Object.fromEntries(Object.entries(entrypoints).map(([name, Handler]) => [name,
    ({ props }: { props: Record<string, unknown> }) => new Handler({ props } as unknown as ExecutionContext, env)]));
  await wireContainerInterception({ env, logger: { info() {}, warn() {}, error() {} },
    ctx: { exports, container: { interceptOutboundHttps: (host: string, handler: { fetch(request: Request): Promise<Response> }) => {
      handlers.set(host, handler);
    } } }, _bucketName: bucket || null, _sessionId: null, _userEmail: null, _userGroups: [],
    _cloudflareApiToken: containerToken, _strictEgress: strict, _operatorPolicy: operatorPolicy,
  } as unknown as InterceptionHost);
  const send = (path: string, upgrade = false) => {
    const request = new Request(`https://api.cloudflare.com${path}`, { headers: {
      authorization: `Bearer ${enterprise ? 'codeflare-enterprise' : 'codeflare-oauth'}`, ...(upgrade ? { Upgrade: 'websocket' } : {}),
    } });
    const handler = handlers.get(new URL(request.url).hostname) ?? handlers.get('*');
    return handler ? handler.fetch(request) : Promise.resolve(new Response('unintercepted', { status: 418 }));
  };
  const sendRequest = (request: Request) => {
    const handler = handlers.get(new URL(request.url).hostname) ?? handlers.get('*');
    return handler ? handler.fetch(request) : fetch(request);
  };
  return { send, sendRequest, direct, inspected, env };
}

it.each([false, true])('REQ-BROWSER-008 AC2: registered Browser dispatch precedes strict catch-all with strict=%s', async strict => {
  const f = await registered({ strict });
  const path = '/client/v4/accounts/acc/browser-rendering/snapshot';
  expect(await (await f.send(path)).text()).toBe(strict ? 'gateway-response' : 'browser-response');
  const outgoing = strict ? f.inspected : f.direct;
  expect(outgoing.map(request => ({ url: request.url, authorization: request.headers.get('authorization'),
    redirect: request.redirect }))).toEqual([{
    url: `https://api.cloudflare.com${path}`, authorization: 'Bearer admin-browser-token', redirect: 'manual',
  }]);
  expect(strict ? f.direct : f.inspected).toEqual([]);
  const other = await f.send('/client/v4/accounts/other/browser-rendering/snapshot');
  expect(other.status).toBe(strict ? 200 : 403);
  if (strict) {
    expect(await other.text()).toBe('gateway-response');
    expect(f.inspected.map(request => request.headers.get('authorization'))).toEqual([
      'Bearer admin-browser-token', 'Bearer codeflare-enterprise',
    ]);
  }
  expect(f.direct.map(request => request.url)).toEqual(strict ? [] : [`https://api.cloudflare.com${path}`]);
});

it.each(['token', 'account'] as const)('REQ-BROWSER-008 AC5: missing %s leaves Browser traffic without admin credentials', async missing => {
  for (const strict of [false, true]) {
    // An unavailable binding must not displace the earlier administrator refusal.
    const f = await registered({ strict, gatewayBound: false, [missing]: '' });
    for (const upgrade of [false, true]) {
      const response = await f.send(`/client/v4/accounts/acc/browser-rendering/${upgrade ? 'devtools/browser' : 'snapshot'}`, upgrade);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'BROWSER_NO_TOKEN' });
    }
    expect(f.direct).toEqual([]);
    expect(f.inspected).toEqual([]);
  }
});

it.each([false, true])('REQ-BROWSER-008 AC3: registered Markdown tool preserves Gateway result/refusal blocked=%s', async blocked => {
  const markdown = '# Public page\n\nRendered **Markdown**.';
  const f = await registered({ strict: true,
    upstream: Response.json({ success: true, result: 'unsafe direct result' }),
    inspectedUpstream: blocked
      ? new Response('Gateway policy refusal', { status: 403 })
      : Response.json({ success: true, result: markdown }),
  });
  const result = await executeBrowserAction({ tool: 'browser_markdown', params: { url: 'https://example.com/page' },
    accountId: 'acc', token: 'codeflare-enterprise',
    fetchImpl: (input, init) => f.sendRequest(new Request(input, init as RequestInit)),
  });
  if (blocked) {
    expect(result.isError).toBe(true);
    expect(result.text).toBe('Browser Run /markdown failed: HTTP 403');
  } else {
    expect(result.isError).not.toBe(true);
    expect(result.text).toBe(markdown);
  }
  expect(f.direct).toEqual([]);
  expect(f.inspected.map(request => ({ url: request.url, authorization: request.headers.get('authorization'),
    method: request.method, redirect: request.redirect }))).toEqual([{
    url: 'https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/markdown',
    authorization: 'Bearer admin-browser-token', method: 'POST', redirect: 'manual',
  }]);
  expect(await f.inspected[0]?.json()).toEqual({ url: 'https://example.com/page' });
});

it('REQ-AGENT-078: registered OAuth dispatch resolves the bound owner token', async () => {
  const f = await registered({ enterprise: false });
  expect(await (await f.send('/client/v4/user')).text()).toBe('browser-response');
  expect(f.direct.map(request => request.headers.get('authorization'))).toEqual(['Bearer owner-oauth-token']);
  expect(f.inspected).toEqual([]);
});

it('REQ-AGENT-078: registered OAuth CDP relays bidirectional text and binary frames with the bound owner token', async () => {
  const upstream = new WebSocketPair();
  const browser = upstream[1];
  browser.accept();
  const f = await registered({ enterprise: false, upstream: new Response(null, { status: 101, webSocket: upstream[0] }) });
  const response = await f.send('/client/v4/accounts/acc/browser-rendering/devtools/browser', true);
  expect(response.status).toBe(101);
  const client = response.webSocket!;
  client.accept();
  const next = (socket: WebSocket) => new Promise<string | ArrayBuffer>(resolve => {
    socket.addEventListener('message', event => resolve(event.data), { once: true });
  });
  try {
    for (const [sender, receiver] of [[client, browser], [browser, client]]) {
      const text = next(receiver);
      sender.send('oauth-cdp');
      expect(await text).toBe('oauth-cdp');
      const binary = next(receiver);
      sender.send(new Uint8Array([0, 127, 255]).buffer);
      expect(new Uint8Array(await binary as ArrayBuffer)).toEqual(new Uint8Array([0, 127, 255]));
    }
    expect(f.direct.map(request => request.headers.get('authorization'))).toEqual(['Bearer owner-oauth-token']);
    expect(f.inspected).toEqual([]);
  } finally {
    client.close();
    browser.close();
  }
});

it.each([{ containerToken: 'owner-pat' }, { bucket: '' }])('REQ-AGENT-078: OAuth registration guards leave traffic unintercepted: %j', async options => {
  const f = await registered({ enterprise: false, ...options });
  expect((await f.send('/client/v4/user')).status).toBe(418);
  expect(f.direct).toEqual([]);
  expect(f.inspected).toEqual([]);
});

// Public transport contract: real registrations preserve caller destination, body
// and credentials across changed modes; PAT/plain reuse their transparent path.
it.each([
  { mode: 'connected OAuth REST inference', enterprise: false, strict: false, token: '', account: '',
    connected: true, containerToken: 'codeflare-oauth', bucket: 'user-bucket',
    url: 'https://api.cloudflare.com/client/v4/accounts/other/ai/v1/chat/completions' },
  { mode: 'OAuth REST inference', enterprise: false, strict: false, token: '', account: '',
    containerToken: 'codeflare-oauth', bucket: 'user-bucket',
    url: 'https://api.cloudflare.com/client/v4/accounts/other/ai/v1/chat/completions' },
  { mode: 'OAuth Gateway', enterprise: false, strict: false, token: '', account: '',
    containerToken: 'codeflare-oauth', bucket: 'user-bucket',
    url: 'https://gateway.ai.cloudflare.com/v1/other/gateway/compat/chat/completions' },
  { mode: 'PAT', enterprise: false, strict: false, token: '', account: '',
    containerToken: 'owner-pat', bucket: 'user-bucket',
    url: 'https://api.cloudflare.com/client/v4/accounts/other/logpush/jobs' },
  { mode: 'plain', enterprise: false, strict: false, token: '', account: '',
    containerToken: '', bucket: '',
    url: 'https://api.cloudflare.com/client/v4/accounts/other/logpush/jobs' },
  { mode: 'Enterprise direct without Browser config', enterprise: true, strict: false, token: '', account: '',
    containerToken: '', bucket: 'user-bucket',
    url: 'https://api.cloudflare.com/client/v4/accounts/other/logpush/jobs' },
  { mode: 'Enterprise inspected without Browser config', enterprise: true, strict: true, token: '', account: '',
    containerToken: '', bucket: 'user-bucket',
    url: 'https://api.cloudflare.com/client/v4/accounts/other/logpush/jobs' },
  { mode: 'Enterprise inspected Browser caller', enterprise: true, strict: true,
    token: 'admin-browser-token', account: 'acc', containerToken: '', bucket: 'user-bucket',
    url: 'https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/snapshot' },
  { mode: 'Enterprise configured Browser caller', enterprise: true, strict: false,
    token: 'admin-browser-token', account: 'acc', containerToken: '', bucket: 'user-bucket',
    url: 'https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/snapshot' },
])('REQ-BROWSER-008/REQ-AGENT-078: caller identity through registered $mode transport', async options => {
  const f = await registered({ connected: false, ...options });
  const gateway = new URL(options.url).hostname === 'gateway.ai.cloudflare.com';
  const headers: Record<string, string> = gateway
    ? { 'cf-aig-authorization': 'Bearer caller-cloudflare-token', authorization: 'Bearer provider-token' }
    : { authorization: 'Bearer caller-cloudflare-token' };
  const response = await f.sendRequest(new Request(options.url, { method: 'POST', headers, redirect: 'manual',
    body: '{"input":"caller"}' }));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(options.strict ? 'gateway-response' : 'browser-response');
  const outgoing = options.strict ? f.inspected : f.direct;
  expect(outgoing.map(request => request.url)).toEqual([options.url]);
  const [request] = outgoing;
  expect(request.method).toBe('POST');
  expect(await request.text()).toBe('{"input":"caller"}');
  expect(request.redirect).toBe('manual');
  expect(request.headers.get('authorization')).toBe(gateway ? 'Bearer provider-token' : 'Bearer caller-cloudflare-token');
  expect(request.headers.get('cf-aig-authorization')).toBe(gateway ? 'Bearer caller-cloudflare-token' : null);
  expect(options.strict ? f.direct : f.inspected).toEqual([]);
});

// Enterprise keeps the Browser marker/account in the container. Ordinary API
// requests select a separate owner connection at the Worker boundary, not from
// that marker's administrator credentials or from a request-supplied owner.
it.each(['oauth', 'pat'] as const)('REQ-AGENT-078/REQ-BROWSER-008: registered Enterprise %s owner grant is independent of admin Browser configuration', async source => {
  for (const strict of [false, true]) {
    for (const configuredBrowser of [false, true]) {
      const f = await registered({ strict, source,
        token: configuredBrowser ? 'admin-browser-token' : '', account: configuredBrowser ? 'acc' : '',
      });
      const url = 'https://api.cloudflare.com/client/v4/accounts/owner-account/workers/scripts/example';
      const response = await f.sendRequest(new Request(url, {
        method: 'PUT', headers: { authorization: 'Bearer codeflare-enterprise',
          'content-type': 'application/javascript', 'x-bucket': 'foreign-owner' }, body: 'export default {};',
      }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(strict ? 'gateway-response' : 'browser-response');
      const outgoing = strict ? f.inspected : f.direct;
      expect(outgoing.map(request => ({ url: request.url, method: request.method,
        authorization: request.headers.get('authorization'), redirect: request.redirect }))).toEqual([{
        url, method: 'PUT', authorization: 'Bearer owner-oauth-token', redirect: 'manual',
      }]);
      expect(await outgoing[0].text()).toBe('export default {};');
      expect(outgoing[0].headers.get('content-type')).toBe('application/javascript');
      expect(strict ? f.direct : f.inspected).toEqual([]);
    }
  }
});

it('REQ-AGENT-078: registered Enterprise owner API accepts absent auth without borrowing admin Browser identity', async () => {
  const f = await registered();
  const url = 'https://api.cloudflare.com/client/v4/accounts';
  expect((await f.sendRequest(new Request(url))).status).toBe(200);
  expect(f.direct.map(request => ({ url: request.url, authorization: request.headers.get('authorization') }))).toEqual([
    { url, authorization: 'Bearer owner-oauth-token' },
  ]);
});

it.each([
  { reason: 'no owner grant', connected: false, bucket: 'user-bucket', account: 'owner-account', status: 401 },
  { reason: 'admin Browser account without an owner grant', connected: false, bucket: 'user-bucket', account: 'acc', status: 401 },
  { reason: 'foreign parent owner', connected: true, bucket: 'foreign-owner', account: 'owner-account', status: 401 },
  { reason: 'missing parent owner', connected: true, bucket: '', account: 'owner-account', status: 401 },
])('REQ-AGENT-078/REQ-BROWSER-008: Enterprise $reason cannot fall back to admin credentials', async ({ connected, bucket, account, status }) => {
  for (const strict of [false, true]) {
    const f = await registered({ strict, connected, bucket });
    const response = await f.sendRequest(new Request(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`, {
      headers: { authorization: 'Bearer codeflare-enterprise', 'x-bucket': 'user-bucket' },
    }));
    expect(response.status).toBe(status);
    expect(f.direct).toEqual([]);
    expect(f.inspected).toEqual([]);
  }
});

it.each([401, 403])('REQ-AGENT-078: Enterprise owner API preserves upstream %s without replay or admin fallback', async status => {
  for (const strict of [false, true]) {
    const refusal = new Response('owner API refusal', { status });
    const f = await registered({ strict, upstream: refusal, inspectedUpstream: refusal });
    const response = await f.send('/client/v4/accounts/owner-account/workers/scripts');
    expect(response.status).toBe(status);
    expect(await response.text()).toBe('owner API refusal');
    expect((strict ? f.inspected : f.direct).map(request => request.headers.get('authorization'))).toEqual(['Bearer owner-oauth-token']);
    expect(strict ? f.direct : f.inspected).toEqual([]);
  }
});

it('REQ-AGENT-078: strict Enterprise owner API fails closed without EGRESS despite a valid owner grant', async () => {
  const f = await registered({ strict: true, gatewayBound: false });
  const response = await f.send('/client/v4/accounts/owner-account/workers/scripts');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'EGRESS_UNAVAILABLE' });
  expect(f.direct).toEqual([]);
  expect(f.inspected).toEqual([]);
});

it('REQ-OPERATOR-004: registered restricted Operator cannot inherit the parent Cloudflare connection', async () => {
  const operatorPolicy: OperatorPolicy = { schemaVersion: 1, networkHosts: ['api.cloudflare.com'],
    github: { repositories: [], methods: [] }, storage: { readPrefixes: [], writePrefixes: [] },
    inference: { routeIds: [], defaultRouteId: null, reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } };
  const f = await registered({ strict: true, operatorPolicy });
  const response = await f.send('/client/v4/accounts/owner-account/workers/scripts');
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'OPERATOR_BROWSER_DENIED' });
  expect(f.direct).toEqual([]);
  expect(f.inspected).toEqual([]);
});

it('REQ-AGENT-078: registered Enterprise owner API refreshes the Worker-held connection at request time', async () => {
  const f = await registered({ strict: true });
  await storeCloudflareConnection(f.env, 'user-bucket', { source: 'oauth', accessToken: 'expired-owner-token',
    refreshToken: 'owner-refresh-token', expiresAt: Date.now() - 60_000, accountId: 'owner-account' });
  await f.env.KV.put(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID, 'configured-client');
  await f.env.KV.put(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_SECRET, JSON.stringify({ secret: 'configured-client-secret' }));
  const tokenRequests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url === 'https://dash.cloudflare.com/oauth2/token') {
      tokenRequests.push(request);
      return Response.json({ access_token: 'fresh-owner-token', refresh_token: 'rotated-owner-refresh', expires_in: 3600 });
    }
    f.direct.push(request);
    return new Response('unsafe direct API');
  });
  const response = await f.send('/client/v4/accounts/owner-account/workers/scripts');
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('gateway-response');
  expect(f.inspected.map(request => request.headers.get('authorization'))).toEqual(['Bearer fresh-owner-token']);
  expect(f.direct).toEqual([]);
  expect(tokenRequests.map(request => request.url)).toEqual(['https://dash.cloudflare.com/oauth2/token']);
  const form = new URLSearchParams(await tokenRequests[0].text());
  expect(form.get('grant_type')).toBe('refresh_token');
  expect(form.get('refresh_token')).toBe('owner-refresh-token');
});

it('REQ-AGENT-078/REQ-BROWSER-008: owner disconnect after registration leaves admin Browser usable but cannot authorize management', async () => {
  const f = await registered({ strict: true });
  await clearCloudflareConnection(f.env, 'user-bucket');
  // Another user's live grant cannot replace the disconnected parent's grant.
  await storeCloudflareConnection(f.env, 'foreign-owner', {
    accessToken: 'foreign-owner-secret', source: 'pat', accountId: 'owner-account',
  });
  const response = await f.sendRequest(new Request('https://api.cloudflare.com/client/v4/accounts/owner-account/workers/scripts', {
    headers: { 'x-bucket': 'foreign-owner' },
  }));
  expect(response.status).toBe(401);
  expect(f.direct).toEqual([]);
  expect(f.inspected).toEqual([]);
  expect((await f.send('/client/v4/accounts/acc/browser-rendering/snapshot')).status).toBe(200);
  expect(f.inspected.map(request => request.headers.get('authorization'))).toEqual(['Bearer admin-browser-token']);
});

it('REQ-AGENT-078: a persisted legacy owner grant does not require an OAuth client registration', async () => {
  const f = await registered({ source: 'pat', oauthConfigured: false, token: '', account: '' });
  const response = await f.send('/client/v4/accounts/owner-account/workers/scripts');
  expect(response.status).toBe(200);
  expect(f.direct.map(request => request.headers.get('authorization'))).toEqual(['Bearer owner-oauth-token']);
  expect(f.inspected).toEqual([]);
});

it('REQ-AGENT-078: strict Enterprise owner API does not retry directly when EGRESS throws', async () => {
  const f = await registered({ strict: true, gatewayThrows: true });
  const response = await f.send('/client/v4/accounts/owner-account/workers/scripts');
  expect(response.status).toBe(502);
  expect(f.direct).toEqual([]);
  expect(f.inspected.map(request => request.headers.get('authorization'))).toEqual(['Bearer owner-oauth-token']);
});
