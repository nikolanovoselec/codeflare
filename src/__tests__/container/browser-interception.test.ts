import { afterEach, expect, it, vi } from 'vitest';
import { wireContainerInterception, type InterceptionHost } from '../../container/container-interception';
import { CloudflareBrowserInterceptor } from '../../cloudflare-browser-interceptor';
import { LlmInterceptor } from '../../llm-interceptor';
import { GitHubInterceptor } from '../../github-interceptor';
import { EgressController } from '../../egress-controller';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { storeCloudflareConnection } from '../../lib/cloudflare-token';
import { createMockKV } from '../helpers/mock-kv';
import type { Env } from '../../types';
import { executeBrowserAction } from '../../../preseed/agents/pi/extensions/browser-run-helpers';

afterEach(() => vi.restoreAllMocks());

// The Container SDK transport is the only registration substitute. It dispatches
// exact hosts before its catch-all; every registered Worker entrypoint is real.
async function registered({ enterprise = true, strict = false, token = 'admin-browser-token',
  account = 'acc', bucket = 'user-bucket', containerToken = 'codeflare-oauth',
  upstream = undefined as Response | undefined, inspectedUpstream = undefined as Response | undefined,
  gatewayBound = true, connected = true } = {}) {
  const kv = createMockKV();
  if (token) kv._set(SETUP_KEYS.BROWSER_RENDER_TOKEN, { token });
  if (account) kv._store.set(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID, account);
  const direct: Request[] = [];
  const inspected: Request[] = [];
  const env = { KV: kv, ENTERPRISE_MODE: enterprise ? 'active' : undefined,
    EGRESS: gatewayBound ? { fetch: async (request: Request) => {
      inspected.push(request);
      return inspectedUpstream ?? new Response('gateway-response');
    } } : undefined } as unknown as Env;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    direct.push(input as Request);
    return upstream ?? new Response('browser-response');
  });
  if (connected) await storeCloudflareConnection(env, 'user-bucket', { accessToken: 'owner-oauth-token', source: 'oauth',
    expiresAt: Date.now() + 3_600_000 });
  const handlers = new Map<string, { fetch(request: Request): Promise<Response> }>();
  const entrypoints = { CloudflareBrowserInterceptor, LlmInterceptor, GitHubInterceptor, EgressController };
  const exports = Object.fromEntries(Object.entries(entrypoints).map(([name, Handler]) => [name,
    ({ props }: { props: Record<string, unknown> }) => new Handler({ props } as unknown as ExecutionContext, env)]));
  await wireContainerInterception({ env, logger: { info() {}, warn() {}, error() {} },
    ctx: { exports, container: { interceptOutboundHttps: (host: string, handler: { fetch(request: Request): Promise<Response> }) => {
      handlers.set(host, handler);
    } } }, _bucketName: bucket || null, _sessionId: null, _userEmail: null, _userGroups: [],
    _cloudflareApiToken: containerToken, _strictEgress: strict,
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
  return { send, sendRequest, direct, inspected };
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
