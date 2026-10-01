import { afterEach, expect, it, vi } from 'vitest';
import { LlmInterceptor } from '../llm-interceptor';
import { createMockKV } from './helpers/mock-kv';
import { SETUP_KEYS } from '../lib/kv-keys';
import type { Env } from '../types';

const owner = { bucket: 'owner-bucket', sessionId: 'owner-session', user: 'owner@example.test' };
const issuer = 'https://personal-pi.cloudflareaccess.com';
afterEach(() => vi.restoreAllMocks());
function fixture(strict = false, operator = false) {
  const kv = createMockKV();
  const policy = (permission: boolean) => kv._set(SETUP_KEYS.GROUP_ROUTING, { Engineering: { routes: [], defaultRoute: '', reasoning: 'off', allowPersonalPiProviders: permission } });
  policy(true);
  kv._set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, ['Engineering']);
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
  const env = { ENTERPRISE_MODE: 'active', KV: kv, CONTAINER: { getByName: () => ({ openReviewHuman: async (ref: { bucket: string; sessionId: string; email: string }) => {
    if (ref.bucket !== owner.bucket || ref.sessionId !== owner.sessionId || ref.email !== owner.user) throw Error('wrong owner');
    return { human, accessJwt: 'synthetic-sealed-assertion' };
  } }) }, EGRESS: strict ? { fetch: async (request: Request) => { egressRequests.push(request); return new Response('inspected-response'); } } : undefined } as unknown as Env;
  const props = { user: owner.user, sessionId: owner.sessionId, personalPi: owner, strict, ...(operator ? { operatorInference: { activityId: 'operator' } } : {}) };
  const interceptor = new LlmInterceptor({ props } as unknown as ExecutionContext, env);
  const send = (url = 'https://api.anthropic.com/v1/messages') => interceptor.fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-personal-key', 'cf-aig-authorization': 'must-not-forward' }, body: JSON.stringify({ model: 'native-personal-model', messages: [] }) }));
  return { send, requests, egressRequests, policy, env, human, identity: (value: unknown) => { identity = value; } };
}
it('REQ-ENTERPRISE-088 AC5: bound native requests preserve wire auth and warm revocation prevents provider I/O', async () => {
  const f = fixture();
  expect((await f.send()).status).toBe(200);
  expect(f.requests.map(request => request.url)).toEqual(['https://api.anthropic.com/v1/messages']);
  expect(f.requests[0].headers.get('authorization')).toBe('Bearer synthetic-personal-key');
  expect(f.requests[0].headers.has('cf-aig-authorization')).toBe(false);
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
  (f.env.KV as unknown as ReturnType<typeof createMockKV>)._set(SETUP_KEYS.STRICT_EGRESS, 'active');
  expect((await f.send()).status).toBe(503);
  expect(f.requests.map(request => request.url)).toEqual(['https://api.anthropic.com/v1/messages']);
});

it('REQ-ENTERPRISE-088 AC6: malformed live transport policy denies personal provider I/O', async () => {
  const f = fixture();
  (f.env.KV as unknown as ReturnType<typeof createMockKV>)._set(SETUP_KEYS.STRICT_EGRESS, 'malformed');
  expect((await f.send()).status).toBe(503);
  expect(f.requests).toEqual([]);
});
