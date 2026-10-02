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

afterEach(() => vi.restoreAllMocks());

// The Container SDK transport is the only registration substitute. It dispatches
// exact hosts before its catch-all; every registered Worker entrypoint is real.
async function registered({ enterprise = true, strict = false, token = 'admin-browser-token',
  account = 'acc', bucket = 'user-bucket', containerToken = 'codeflare-oauth',
  upstream = undefined as Response | undefined } = {}) {
  const kv = createMockKV();
  if (token) kv._set(SETUP_KEYS.BROWSER_RENDER_TOKEN, { token });
  if (account) kv._store.set(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID, account);
  const direct: Request[] = [];
  const inspected: Request[] = [];
  const env = { KV: kv, ENTERPRISE_MODE: enterprise ? 'active' : undefined,
    EGRESS: { fetch: async (request: Request) => {
      inspected.push(request);
      return new Response('gateway-response');
    } } } as unknown as Env;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    direct.push(input as Request);
    return upstream ?? new Response('browser-response');
  });
  await storeCloudflareConnection(env, 'user-bucket', { accessToken: 'owner-oauth-token', source: 'oauth',
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
      authorization: 'Bearer codeflare-oauth', ...(upgrade ? { Upgrade: 'websocket' } : {}),
    } });
    const handler = handlers.get(new URL(request.url).hostname) ?? handlers.get('*');
    return handler ? handler.fetch(request) : Promise.resolve(new Response('unintercepted', { status: 418 }));
  };
  return { send, direct, inspected };
}

it.each([false, true])('REQ-BROWSER-008 AC2: registered Browser dispatch precedes strict catch-all with strict=%s', async strict => {
  const f = await registered({ strict });
  expect(await (await f.send('/client/v4/accounts/acc/browser-rendering/snapshot')).text()).toBe('browser-response');
  expect(f.direct.map(request => request.headers.get('authorization'))).toEqual(['Bearer admin-browser-token']);
  expect(f.inspected).toEqual([]);
  const other = await f.send('/client/v4/accounts/other/browser-rendering/snapshot');
  expect(other.status).toBe(strict ? 200 : 403);
  if (strict) {
    expect(await other.text()).toBe('gateway-response');
    expect(f.inspected.map(request => request.headers.get('authorization'))).toEqual(['Bearer codeflare-oauth']);
  }
  expect(f.direct.map(request => request.url)).toEqual(['https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/snapshot']);
});

it.each(['token', 'account'] as const)('REQ-BROWSER-008 AC2: missing %s leaves Browser traffic without admin credentials', async missing => {
  const f = await registered({ strict: true, [missing]: '' });
  // The native provider registration still claims this host when Browser is skipped.
  // With no sanctioned Gateway configured, it denies rather than injecting either token.
  const response = await f.send('/client/v4/accounts/acc/browser-rendering/snapshot');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'GATEWAY_UNAVAILABLE' });
  expect(f.direct).toEqual([]);
  expect(f.inspected).toEqual([]);
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
