import { afterEach, expect, it, vi } from 'vitest';
import { LlmInterceptor } from '../llm-interceptor';
import { wireContainerInterception, type InterceptionHost } from '../container/container-interception';
import { createMockKV } from './helpers/mock-kv';
import { SETUP_KEYS } from '../lib/kv-keys';
import { createMockSessionD1 } from './helpers/mock-session-d1';
import type { Env } from '../types';
import { bindReviewSessionHuman, discardReviewSessionHuman, openReviewSessionHuman } from '../container/review-session-human';

const owner = { bucket: 'owner-bucket', sessionId: 'ownersession1', user: 'owner@example.test' };
const issuer = 'https://personal-pi.cloudflareaccess.com';
afterEach(() => vi.restoreAllMocks());
function fixture(strict = false, operator = false) {
  const kv = createMockKV();
  const policy = (permission: boolean) => kv._set(SETUP_KEYS.GROUP_ROUTING, { Engineering: { routes: [], defaultRoute: '', reasoning: 'off', allowPersonalPiProviders: permission } });
  policy(true);
  kv._set(`session:${owner.bucket}:${owner.sessionId}`, { id: owner.sessionId, userId: owner.bucket,
    status: 'running', lifecycleGeneration: 1 });
  const nativeSession = { generation: 1, groups: ['Engineering'] };
  kv._store.set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'Engineering');
  kv._set(SETUP_KEYS.REASONING_CONFIGURATION, { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {}, fallbackRouting: { enabled: false } });
  const requests: Request[] = [];
  let identity: unknown = { user_uuid: 'owner-id', email: owner.user, groups: [{ id: 'group-id', name: 'Engineering' }] };
  const human = { subject: 'owner-id', email: owner.user, issuer, audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 1, expiresAt: Math.floor(Date.now() / 1000) + 300 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === `${issuer}/cdn-cgi/access/get-identity`) return identity === null ? new Response('', { status: 503 }) : Response.json(identity);
    requests.push(request);
    return new Response('personal-response', { status: 200 });
  });
  const egressRequests: Request[] = [];
  const env = { ENTERPRISE_MODE: 'active', KV: kv, USAGE_DB: createMockSessionD1(kv), CONTAINER: { getByName: () => ({
    getPersonalPiSession: async (ref: { bucket: string; sessionId: string; email: string }) => {
      if (ref.bucket !== owner.bucket || ref.sessionId !== owner.sessionId || ref.email !== owner.user) throw Error('wrong owner');
      return { generation: nativeSession.generation, groups: [...nativeSession.groups] };
    },
    openReviewHuman: async (ref: { bucket: string; sessionId: string; email: string }) => {
    if (ref.bucket !== owner.bucket || ref.sessionId !== owner.sessionId || ref.email !== owner.user) throw Error('wrong owner');
    return { human, accessJwt: 'synthetic-sealed-assertion', generation: 1 };
  } }) }, EGRESS: strict ? { fetch: async (request: Request) => { egressRequests.push(request); return new Response('inspected-response'); } } : undefined } as unknown as Env;
  const props = { user: owner.user, sessionId: owner.sessionId, personalPi: { ...owner, generation: 1 }, strict, ...(operator ? { operatorInference: { activityId: 'operator' } } : {}) };
  const interceptor = new LlmInterceptor({ props } as unknown as ExecutionContext, env);
  const send = (url = 'https://api.anthropic.com/v1/messages') => interceptor.fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-personal-key', 'cf-aig-authorization': 'must-not-forward', 'x-codeflare-context': 'private-platform-context', 'x-codeflare-session': 'private-platform-session' }, body: JSON.stringify({ model: 'native-personal-model', messages: [] }) }));
  return { send, requests, egressRequests, policy, env, human, nativeSession, identity: (value: unknown) => { identity = value; } };
}
it('REQ-ENTERPRISE-088 AC5: bound native requests preserve wire auth and warm revocation prevents provider I/O', async () => {
  const f = fixture();
  expect((await f.send()).status).toBe(200);
  expect(f.requests.map(request => request.url)).toEqual(['https://api.anthropic.com/v1/messages']);
  expect(f.requests[0].headers.get('authorization')).toBe('Bearer synthetic-personal-key');
  expect(f.requests[0].headers.has('cf-aig-authorization')).toBe(false);
  expect(f.requests[0].headers.has('x-codeflare-context')).toBe(false);
  expect(f.requests[0].headers.has('x-codeflare-session')).toBe(false);
  expect(await f.requests[0].text()).toBe(JSON.stringify({ model: 'native-personal-model', messages: [] }));
  f.policy(false);
  expect((await f.send()).status).toBe(403);
  expect(f.requests.map(request => request.url)).toEqual(['https://api.anthropic.com/v1/messages']);
});
it('REQ-ENTERPRISE-088 AC5: failed identity expiry and membership revocation fail closed even with fallback', async () => {
  for (const reason of ['identity', 'expiry', 'membership', 'owner', 'malformed']) {
    const f = fixture();
    if (reason !== 'membership') (f.env.KV as unknown as ReturnType<typeof createMockKV>)._set(SETUP_KEYS.REASONING_CONFIGURATION, { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {}, fallbackRouting: { enabled: true, routes: ['route'], defaultRoute: 'route', reasoning: 'off', allowPersonalPiProviders: true } });
    if (reason === 'identity') f.identity(null);
    if (reason === 'expiry') f.human.expiresAt = 1;
    if (reason === 'owner') f.human.email = 'another-owner@example.test';
    if (reason === 'malformed') f.identity({ user_uuid: 'owner-id', email: owner.user, groups: [null] });
    if (reason === 'membership') f.identity({ user_uuid: 'owner-id', email: owner.user, groups: [] });
    expect((await f.send()).status).toBe(403);
    expect(f.requests).toEqual([]);
  }
});
it('REQ-ENTERPRISE-088 AC6: strict personal transport requires its binding and does not use platform exemption', async () => {
  const f = fixture(true);
  expect(await (await f.send()).text()).toBe('inspected-response');
  expect(f.requests).toEqual([]);
  expect(f.egressRequests[0].redirect).toBe('manual');
  f.env.EGRESS = undefined;
  expect((await f.send()).status).toBe(503);
  expect(f.requests).toEqual([]);
});
it('REQ-ENTERPRISE-088 AC7: Operator and stale managed handles never use personal transport', async () => {
  const operator = fixture(false, true);
  expect((await operator.send()).status).toBe(403);
  expect(operator.requests).toEqual([]);
  const f = fixture();
  const response = await new LlmInterceptor({ props: { user: owner.user, personalPi: owner } } as unknown as ExecutionContext, f.env).fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-personal-key' }, body: JSON.stringify({ model: 'cf-native-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', messages: [] }) }));
  expect(response.status).not.toBe(200);
  expect(f.requests).toEqual([]);
});

it.each(['application/json', 'text/plain', undefined])(
  'REQ-ENTERPRISE-088 AC7: reserved selectors cannot bypass authorization with media type %s', async contentType => {
    for (const selector of ['cf-native-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      'dynamic/cf-native-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'dynamic/codeflare-enterprise']) {
      const f = fixture();
      const headers = new Headers({ authorization: 'Bearer synthetic-personal-key' });
      if (contentType) headers.set('content-type', contentType);
      const request = new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', headers,
        body: new TextEncoder().encode(JSON.stringify({ model: selector, messages: [] })) });
      const interceptor = new LlmInterceptor({ props: { user: owner.user, personalPi: owner } } as unknown as ExecutionContext, f.env);
      expect((await interceptor.fetch(request)).status).not.toBe(200);
      expect(f.requests).toEqual([]);
      vi.restoreAllMocks();
    }
  },
);

it.each(['subject', 'issuedAt', 'expiresAt', 'audiences'] as const)(
  'REQ-ENTERPRISE-088 AC5: authority %s rebinding during policy resolution denies provider I/O', async field => {
    const f = fixture();
    const originalKV = f.env.KV;
    f.env.KV = { ...originalKV, get: async (key: string) => {
      const value = await originalKV.get(key);
      if (key === SETUP_KEYS.GROUP_ROUTING) {
        if (field === 'subject') f.human.subject = 'rebound-human';
        else if (field === 'audiences') f.human.audiences = ['rebound-audience'];
        else f.human[field] += 1;
      }
      return value;
    } } as KVNamespace;
    expect((await f.send()).status).toBe(403);
    expect(f.requests).toEqual([]);
  },
);

it('REQ-ENTERPRISE-088 AC5: real sealed authority cannot cross a lifecycle replacement during authorization', async () => {
  const f = fixture();
  const records = new Map<string, unknown>([['lifecycleGeneration', 1]]);
  const actions = { get: async (key: string) => records.get(key),
    put: async (key: string, value: unknown) => { records.set(key, value); },
    delete: async (key: string) => { records.delete(key); } };
  const storage = { ...actions, transaction: async <T>(run: (tx: typeof actions) => Promise<T>) => run(actions) };
  const host = { _bucketName: owner.bucket, _sessionId: owner.sessionId, _userEmail: owner.user,
    env: { ENCRYPTION_KEY: btoa('a'.repeat(32)) }, ctx: { storage } };
  const bound = { bucket: owner.bucket, sessionId: owner.sessionId, generation: 1,
    human: f.human, accessJwt: 'synthetic-sealed-assertion' };
  await bindReviewSessionHuman(host, bound);
  f.env.CONTAINER = { getByName: () => ({ openReviewHuman: (ref: { bucket: string; sessionId: string; email: string }) =>
    openReviewSessionHuman(host, ref) }) } as unknown as Env['CONTAINER'];
  const originalKV = f.env.KV;
  f.env.KV = { ...originalKV, get: async (key: string) => {
    const value = await originalKV.get(key);
    if (key === SETUP_KEYS.GROUP_ROUTING && records.get('lifecycleGeneration') === 1) {
      await discardReviewSessionHuman(host);
      records.set('lifecycleGeneration', 2);
      await bindReviewSessionHuman(host, { ...bound, generation: 2 });
    }
    return value;
  } } as KVNamespace;
  expect((await f.send()).status).toBe(403);
  expect(f.requests).toEqual([]);
  expect(await openReviewSessionHuman(host, { bucket: owner.bucket, sessionId: owner.sessionId, email: owner.user }))
    .toMatchObject({ generation: 2, human: { subject: f.human.subject } });
});

it('REQ-ENTERPRISE-088 AC6: personal credentials cannot follow a cross-origin provider redirect', async () => {
  const f = fixture();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith(issuer)) return original(input, init);
    f.requests.push(request);
    return new Response(null, { status: 302, headers: { location: 'https://different-origin.example/collect' } });
  });
  const response = await f.send();
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ code: 'PERSONAL_PI_REDIRECT_DENIED' });
  expect(f.requests.map(request => request.url)).toEqual(['https://api.anthropic.com/v1/messages']);
});

it('REQ-ENTERPRISE-088 AC5: OAuth Codex and native cloud destinations retain authorized transport', async () => {
  for (const url of ['https://chatgpt.com/backend-api/codex/responses', 'https://auth.openai.com/oauth/token',
    'https://bedrock-runtime.eu-west-1.amazonaws.com/model/native/invoke', 'https://resource.openai.azure.com/openai/v1/responses',
    'https://api.cloudflare.com/client/v4/accounts/personal/ai/v1/chat/completions']) {
    const f = fixture();
    expect((await f.send(url)).status).toBe(200);
    expect(f.requests.map(request => request.url)).toEqual([url]);
    expect(f.requests[0].headers.get('authorization')).toBe('Bearer synthetic-personal-key');
  }
});

it('REQ-ENTERPRISE-088 AC5: reused native WebSockets deny frames after warm policy revocation', async () => {
  const f = fixture();
  const provider = new WebSocketPair();
  provider[1].accept();
  const messages: unknown[] = [];
  provider[1].addEventListener('message', event => messages.push(event.data));
  const first = new Promise<void>(resolve => provider[1].addEventListener('message', () => resolve(), { once: true }));
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith(issuer)) return original(input, init);
    return new Response(null, { status: 101, webSocket: provider[0] });
  });
  const interceptor = new LlmInterceptor({ props: { user: owner.user, personalPi: owner } } as unknown as ExecutionContext, f.env);
  const response = await interceptor.fetch(new Request('https://chatgpt.com/backend-api/codex/responses', { headers: { upgrade: 'websocket', authorization: 'Bearer synthetic-personal-key' } }));
  expect(response.status).toBe(101);
  const client = (response as unknown as { webSocket: WebSocket }).webSocket;
  client.accept();
  client.send('authorized-frame');
  await first;
  f.policy(false);
  const closed = new Promise<number>(resolve => client.addEventListener('close', event => resolve(event.code), { once: true }));
  client.send('revoked-frame');
  expect(await closed).toBe(1008);
  expect(messages).toEqual(['authorized-frame']);
});


it('REQ-ENTERPRISE-088 AC6: warm strict activation cannot use a stale direct transport hint', async () => {
  const f = fixture();
  expect((await f.send()).status).toBe(200);
  (f.env.KV as unknown as ReturnType<typeof createMockKV>)._store.set(SETUP_KEYS.STRICT_EGRESS, 'active');
  expect((await f.send()).status).toBe(503);
  expect(f.requests.map(request => request.url)).toEqual(['https://api.anthropic.com/v1/messages']);
  f.env.EGRESS = { fetch: async (request: Request) => { f.egressRequests.push(request); return new Response('warm-inspected'); } } as unknown as Fetcher;
  expect(await (await f.send()).text()).toBe('warm-inspected');
  expect(f.egressRequests.map(request => request.url)).toEqual(['https://api.anthropic.com/v1/messages']);
  expect(f.requests).toHaveLength(1);
});

it('REQ-ENTERPRISE-088 AC6: malformed live transport policy denies personal provider I/O', async () => {
  const f = fixture();
  (f.env.KV as unknown as ReturnType<typeof createMockKV>)._store.set(SETUP_KEYS.STRICT_EGRESS, 'malformed');
  expect((await f.send()).status).toBe(503);
  expect(f.requests).toEqual([]);
});


it('REQ-ENTERPRISE-088 AC5: token-derived Copilot service hosts remain policy gated', async () => {
  const f = fixture();
  const url = 'https://api.regional.githubcopilot.com/chat/completions';
  expect((await f.send(url)).status).toBe(200);
  f.policy(false);
  expect((await f.send(url)).status).toBe(403);
  expect(f.requests.map(request => request.url)).toEqual([url]);
});

it('REQ-ENTERPRISE-090 AC4: registered regional Vertex transport denies revoked traffic with strict mode off', async () => {
  const f = fixture();
  const handlers = new Map<string, Fetcher>();
  await wireContainerInterception({ env: f.env, logger: { info() {}, warn() {}, error() {} },
    ctx: { exports: { LlmInterceptor: ({ props }: { props: unknown }) => new LlmInterceptor({ props } as unknown as ExecutionContext, f.env) },
      container: { interceptOutboundHttps: (name: string, handler: Fetcher) => { handlers.set(name, handler); } } },
    _bucketName: owner.bucket, _sessionId: owner.sessionId, _userEmail: owner.user, _userGroups: [], _strictEgress: false,
  } as unknown as InterceptionHost);
  // The regional-host registration is an intentional provider-origin contract.
  const handler = handlers.get('*-aiplatform.googleapis.com');
  if (!handler) throw Error('Regional Vertex interception is unavailable');
  const url = 'https://us-central1-aiplatform.googleapis.com/v1/projects/owner/locations/us-central1/publishers/google/models/native:generateContent';
  const request = () => new Request(url, { method: 'POST', headers: { authorization: 'Bearer synthetic-owner-token',
    'content-type': 'application/json' }, body: JSON.stringify({ contents: [] }) });
  expect((await handler.fetch(request())).status).toBe(200);
  expect(f.requests.map(value => value.url)).toEqual([url]);
  f.policy(false);
  expect((await handler.fetch(request())).status).toBe(403);
  expect(f.requests.map(value => value.url)).toEqual([url]);
});

it('REQ-ENTERPRISE-088 AC5: deployment-bound Copilot enterprise hosts use native credentials', async () => {
  const f = fixture();
  f.env.GITHUB_HOST = 'github.enterprise.example';
  const url = 'https://copilot-api.github.enterprise.example/chat/completions';
  expect((await f.send(url)).status).toBe(200);
  f.policy(false);
  expect((await f.send(url)).status).toBe(403);
  expect(f.requests.map(request => request.url)).toEqual([url]);
});

it('REQ-ENTERPRISE-088 AC5: an unbound native request cannot borrow the legacy gateway path', async () => {
  const f = fixture();
  const interceptor = new LlmInterceptor({ props: { user: owner.user } } as unknown as ExecutionContext, f.env);
  expect((await interceptor.fetch(new Request('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' }))).status).toBe(403);
  expect(f.requests).toEqual([]);
});


it('REQ-ENTERPRISE-088 AC5: real registry wiring binds human requests and denies unbound and Operator paths', async () => {
  for (const mode of ['human', 'unbound', 'operator']) {
    const f = fixture();
    const handlers = new Map<string, Fetcher>();
    const host = {
      env: f.env, logger: { info() {}, warn() {}, error() {} },
      ctx: { exports: { LlmInterceptor: ({ props }: { props: unknown }) => new LlmInterceptor({ props } as unknown as ExecutionContext, f.env) },
        container: { interceptOutboundHttps: (name: string, handler: Fetcher) => { handlers.set(name, handler); } } },
      _bucketName: owner.bucket, _sessionId: mode === 'unbound' ? null : owner.sessionId,
      _userEmail: owner.user, _userGroups: [], _strictEgress: false,
      ...(mode === 'operator' ? { _operatorContainerProfile: { activityId: 'operator-activity', operatorId: 'operator',
        policy: { capabilities: ['inference'] }, piProfile: { model: 'sanctioned-route', thinkingLevel: 'off' } } } : {}),
    } as unknown as InterceptionHost;
    await wireContainerInterception(host);
    for (const url of ['https://api.anthropic.com/v1/messages', 'https://api.openai.com/v1/chat/completions']) {
      const handler = handlers.get(new URL(url).hostname);
      if (!handler) throw Error('Native interception was not installed');
      const response = await handler.fetch(new Request(url, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-personal-key' },
        body: JSON.stringify({ model: 'native-personal-model', messages: [] }),
      }));
      if (mode === 'human') expect(response.status).toBe(200);
      else expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(f.requests.map(request => request.url)).toEqual(mode === 'human'
      ? ['https://api.anthropic.com/v1/messages', 'https://api.openai.com/v1/chat/completions'] : []);
    const handler = handlers.get('api.anthropic.com')!;
    if (mode === 'human') {
      f.policy(false);
      expect((await handler.fetch(new Request('https://api.anthropic.com/v1/messages'))).status).toBe(403);
      expect(f.requests.map(request => request.url)).toEqual(['https://api.anthropic.com/v1/messages', 'https://api.openai.com/v1/chat/completions']);
    }
  }
});

it.each([
  'https://auth.kimi.com/api/oauth/device_authorization', 'https://auth.kimi.com/api/oauth/token',
  'https://auth.meta.com/oidc/device/authorization/', 'https://auth.meta.com/oidc/device/token/',
  'https://auth.x.ai/oauth2/device/code', 'https://auth.x.ai/oauth2/token',
])('REQ-ENTERPRISE-088 AC6: native OAuth traffic is bound and warm-strict gated: %s', async url => {
  for (const mode of ['permitted', 'revoked', 'expired', 'warm-strict-missing', 'warm-strict-inspected']) {
    const f = fixture();
    const handlers = new Map<string, Fetcher>();
    await wireContainerInterception({ env: f.env, logger: { info() {}, warn() {}, error() {} },
      ctx: { exports: { LlmInterceptor: ({ props }: { props: unknown }) => new LlmInterceptor({ props } as unknown as ExecutionContext, f.env) },
        container: { interceptOutboundHttps: (name: string, handler: Fetcher) => { handlers.set(name, handler); } } },
      _bucketName: owner.bucket, _sessionId: owner.sessionId, _userEmail: owner.user, _userGroups: [], _strictEgress: false,
    } as unknown as InterceptionHost);
    if (mode === 'revoked') f.policy(false);
    if (mode === 'expired') f.human.expiresAt = 1;
    if (mode.startsWith('warm-strict')) (f.env.KV as unknown as ReturnType<typeof createMockKV>)._store.set(SETUP_KEYS.STRICT_EGRESS, 'active');
    if (mode === 'warm-strict-inspected') f.env.EGRESS = { fetch: async (request: Request) => {
      f.egressRequests.push(request); return new Response('inspected-oauth');
    } } as unknown as Fetcher;
    const handler = handlers.get(new URL(url).hostname);
    if (!handler) throw Error('Native OAuth interception is unavailable');
    const body = 'grant_type=refresh_token&refresh_token=synthetic-owner-refresh';
    const response = await handler.fetch(new Request(url, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Bearer synthetic-owner-token' }, body }));
    expect(response.status).toBe(mode === 'permitted' || mode === 'warm-strict-inspected' ? 200 : mode === 'warm-strict-missing' ? 503 : 403);
    expect(f.requests.map(request => request.url)).toEqual(mode === 'permitted' ? [url] : []);
    expect(f.egressRequests.map(request => request.url)).toEqual(mode === 'warm-strict-inspected' ? [url] : []);
    const forwarded = [...f.requests, ...f.egressRequests][0];
    if (forwarded) {
      expect(await forwarded.text()).toBe(body);
      expect(forwarded.headers.get('authorization')).toBe('Bearer synthetic-owner-token');
    }
  }
});

it.each([
  'https://auth.openai.com/api/accounts/oauth/token',
  'https://auth.openai.com/oauth/token',
  'https://auth.openai.com/api/accounts/deviceauth/usercode',
  'https://auth.x.ai/oauth2/device/code',
  'https://auth.x.ai/oauth2/token',
  'https://api.openai.com/v1/responses',
  'https://chatgpt.com/backend-api/codex/responses',
  'https://api.x.ai/v1/chat/completions',
  'https://api.anthropic.com/v1/messages',
])('REQ-ENTERPRISE-090 AC3: Administration-enabled native transport does not depend on browser authority: %s', async url => {
  for (const browser of ['missing', 'expired', 'identity-unavailable']) {
    const f = fixture();
    if (browser === 'expired') f.human.expiresAt = 1;
    if (browser === 'identity-unavailable') f.identity(null);
    if (browser === 'missing') f.env.CONTAINER = { getByName: () => ({
      getPersonalPiSession: async () => ({ generation: 1, groups: ['Engineering'] }),
      openReviewHuman: async () => { throw Error('No browser authority'); },
    }) } as unknown as Env['CONTAINER'];
    const response = await f.send(url);
    expect(response.status).toBe(200);
    expect(f.requests.map(request => request.url)).toEqual([url]);
    expect(f.requests[0].headers.get('authorization')).toBe('Bearer synthetic-personal-key');
    f.policy(false);
    expect((await f.send(url)).status).toBe(403);
    expect(f.requests.map(request => request.url)).toEqual([url]);
    vi.restoreAllMocks();
  }
});

it('REQ-ENTERPRISE-090 AC1: enabled fallback grants native transport without a browser lease or sanctioned routes', async () => {
  const f = fixture();
  f.nativeSession.groups = [];
  f.human.expiresAt = 1;
  (f.env.KV as unknown as ReturnType<typeof createMockKV>)._set(SETUP_KEYS.REASONING_CONFIGURATION,
    { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {},
      fallbackRouting: { enabled: true, routes: ['unverified-route'], defaultRoute: 'unverified-route', reasoning: 'off', allowPersonalPiProviders: true } });
  expect((await f.send()).status).toBe(200);
  expect(f.requests.map(request => request.url)).toEqual(['https://api.anthropic.com/v1/messages']);
});

it.each(['initial', 'during-policy'])('REQ-ENTERPRISE-090 AC3: a stale parent-bound generation denies native effects: %s', async when => {
  const f = fixture();
  if (when === 'initial') f.nativeSession.generation = 2;
  else {
    const kv = f.env.KV;
    f.env.KV = { ...kv, get: async (key: string) => {
      const value = await kv.get(key);
      if (key === SETUP_KEYS.GROUP_ROUTING) f.nativeSession.generation = 2;
      return value;
    } } as KVNamespace;
  }
  expect((await f.send()).status).toBe(403);
  expect(f.requests).toEqual([]);
});

it('REQ-ENTERPRISE-091 AC2: enabling personal providers does not redirect Dynamic or Native Route selectors to personal transport', async () => {
  const f = fixture();
  const kv = f.env.KV as unknown as ReturnType<typeof createMockKV>;
  kv._set(SETUP_KEYS.DYNAMIC_ROUTES, ['managed-dynamic']);
  for (const model of ['managed-dynamic', 'dynamic/managed-dynamic',
    'cf-native-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'codeflare-enterprise']) {
    const response = await new LlmInterceptor({ props: { user: owner.user, personalPi: { ...owner, generation: 1 } } } as unknown as ExecutionContext, f.env)
      .fetch(new Request('https://api.openai.com/v1/chat/completions', { method: 'POST',
        headers: { authorization: 'Bearer synthetic-personal-key', 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [] }) }));
    // The managed catalog is deliberately unavailable: managed requests must fail
    // closed rather than borrowing an enabled personal-provider exception.
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
  expect(f.requests).toEqual([]);
});

it('REQ-ENTERPRISE-090 AC4: a reused native WebSocket outlives browser expiry but not Administration revocation', async () => {
  const f = fixture();
  const pair = new WebSocketPair();
  pair[1].accept();
  const received: unknown[] = [];
  pair[1].addEventListener('message', event => received.push(event.data));
  const next = () => new Promise<void>((resolve, reject) => {
    pair[1].addEventListener('message', () => resolve(), { once: true });
    pair[1].addEventListener('close', () => reject(new Error('Native transport closed before delivery')), { once: true });
  });
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith(issuer)) return original(input, init);
    return new Response(null, { status: 101, webSocket: pair[0] });
  });
  const interceptor = new LlmInterceptor({ props: { user: owner.user, personalPi: { ...owner, generation: 1 } } } as unknown as ExecutionContext, f.env);
  const response = await interceptor.fetch(new Request('https://chatgpt.com/backend-api/codex/responses',
    { headers: { upgrade: 'websocket', authorization: 'Bearer synthetic-personal-key' } }));
  expect(response.status).toBe(101);
  const client = (response as unknown as { webSocket: WebSocket }).webSocket;
  client.accept();
  try {
    let delivered = next();
    client.send('before-expiry');
    await delivered;
    f.human.expiresAt = 1;
    delivered = next();
    client.send('after-browser-expiry');
    await delivered;
    f.policy(false);
    const closed = new Promise<number>(resolve => client.addEventListener('close', event => resolve(event.code), { once: true }));
    client.send('after-revocation');
    expect(await closed).toBe(1008);
    expect(received).toEqual(['before-expiry', 'after-browser-expiry']);
  } finally {
    client.close();
    pair[1].close();
  }
});
