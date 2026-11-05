import { afterEach, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { CloudflareBrowserInterceptor } from '../../cloudflare-browser-interceptor';
import { BROWSER_REFERENCE_KEY, browserOwnerReference, ownedBrowser, type BrowserHost, type BrowserOwnerReference } from '../../container/container-browser';
import { SHUTDOWN_REQUESTED_KEY } from '../../container/container-metrics';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { getContainerId } from '../../lib/container-helpers';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';

const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) try { socket.close(); } catch { /* already closed */ }
  vi.restoreAllMocks();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(strict = true) {
  const kv = createMockKV();
  kv._set(SETUP_KEYS.BROWSER_RENDER_TOKEN, { token: 'worker-held-browser-token' });
  kv._store.set(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID, 'account');
  kv._store.set(SETUP_KEYS.STRICT_EGRESS, strict ? 'active' : 'inactive');
  const bucket = 'owner-bucket', sessionId = 'session1234', email = 'owner@example.test';
  const sessionKey = `session:${bucket}:${sessionId}`;
  const session = { id: sessionId, userId: bucket, status: 'running', lifecycleGeneration: 7,
    createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z' };
  kv._set(sessionKey, session);
  const records = new Map<string, unknown>([['bucketName', bucket], ['_sessionId', sessionId], ['lifecycleGeneration', 7]]);
  const storage = {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
    delete: async (key: string) => records.delete(key),
    transaction: async <T>(work: (txn: unknown) => Promise<T>) => work(storage),
  };
  const created: string[] = [];
  const attached: string[] = [];
  const wire: Array<{ transport: string; url: string; method: string; auth: string | null; redirect: string; body: string }> = [];
  let createResponse: (() => Promise<Response>) | undefined;
  let attachmentFailure = false;
  const provider = async (request: Request, transport: string): Promise<Response> => {
    wire.push({ transport, url: request.url, method: request.method, auth: request.headers.get('authorization'),
      redirect: request.redirect, body: request.method === 'POST' ? await request.text() : '' });
    if (request.method === 'POST') {
      const id = `provider-${created.length + 1}`;
      created.push(id);
      if (createResponse) return createResponse();
      // A returned URL is metadata, never an authorized destination.
      return Response.json({ sessionId: id, webSocketDebuggerUrl: 'wss://foreign.example/never-follow' });
    }
    if (attachmentFailure) throw new Error('connection lost');
    const id = new URL(request.url).pathname.split('/').at(-1)!;
    if (!created.includes(id)) return new Response('unavailable', { status: 404 });
    attached.push(id);
    const pair = new WebSocketPair();
    pair[1].accept();
    sockets.push(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  };
  const direct: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    direct.push((input as Request).url);
    return provider(input as Request, 'direct');
  });
  const env = { ENTERPRISE_MODE: 'active', KV: kv, USAGE_DB: createMockSessionD1(kv),
    EGRESS: { fetch: (request: Request) => provider(request, 'gateway') } } as unknown as Env;
  const reconstruct = (): BrowserHost => ({ env, ctx: { storage },
    _bucketName: bucket, _sessionId: sessionId, _userEmail: email, _userGroups: ['owners'], _strictEgress: strict,
    _shutdownStartedAt: 0 } as unknown as BrowserHost);
  let host = reconstruct();
  const owner = (await browserOwnerReference(host)).browserOwner!;
  expect(owner).toBeDefined();
  const names: string[] = [];
  env.CONTAINER = { getByName: (name: string) => {
    names.push(name);
    if (name !== getContainerId(bucket, sessionId)) throw new Error('Wrong owning DO');
    return { getOwnedBrowser: (ref: BrowserOwnerReference, operation: 'acquire' | 'attach' | 'replace') => ownedBrowser(host, ref, operation) };
  } } as unknown as Env['CONTAINER'];
  const interceptor = new CloudflareBrowserInterceptor({ props: { browserAccountId: 'account', browserToken: 'worker-held-browser-token',
    browserOwner: owner, strict } } as unknown as ExecutionContext, env);
  const endpoint = 'https://api.cloudflare.com/client/v4/accounts/account/browser-rendering/devtools/browser';
  const send = async (path = '', auth = 'codeflare-enterprise') => {
    const response = await interceptor.fetch(new Request(`${endpoint}${path}`, { headers: { upgrade: 'websocket', authorization: `Bearer ${auth}` } }));
    if (response.webSocket) { response.webSocket.accept(); sockets.push(response.webSocket); }
    return response;
  };
  return { env, kv, owner, endpoint, records, created, attached, direct, wire, names, send, interceptor, session, sessionKey,
    get host() { return host; }, reconstruct: () => { host = reconstruct(); },
    setCreateResponse: (value: () => Promise<Response>) => { createResponse = value; },
    failAttachments: () => { attachmentFailure = true; } };
}

it.each([false, true])('REQ-BROWSER-001/006/008/009: lazy managed connections acquire once and reuse exact ID through required transport strict=%s', async strict => {
  const f = await fixture(strict);
  expect(f.created).toEqual([]);
  expect((await f.send('?keep_alive=1200000')).status).toBe(101);
  expect((await f.send()).status).toBe(101);
  expect(f.created).toEqual(['provider-1']);
  expect(f.attached).toEqual(['provider-1', 'provider-1']);
  expect(f.wire).toEqual([
    { transport: strict ? 'gateway' : 'direct', url: `${f.endpoint}?keep_alive=1200000`, method: 'POST',
      auth: 'Bearer worker-held-browser-token', redirect: 'manual', body: '{}' },
    ...[1, 2].map(() => ({ transport: strict ? 'gateway' : 'direct', url: `${f.endpoint}/provider-1`, method: 'GET',
      auth: 'Bearer worker-held-browser-token', redirect: 'manual', body: '' })),
  ]);
  expect(new Set(f.names)).toEqual(new Set([getContainerId(f.owner.bucket, f.owner.sessionId)]));
  if (strict) expect(f.direct).toEqual([]);
  // Only ownership/configuration and opaque reference are persisted, not returned URL or credentials.
  expect(f.records.get(BROWSER_REFERENCE_KEY)).toEqual({ ...f.owner, providerId: 'provider-1' });
});

it('REQ-BROWSER-008: concurrent interactive connections share acquisition and same-generation reconstruction retains identity', async () => {
  const f = await fixture();
  const started = gate(), release = gate();
  f.setCreateResponse(async () => { started.resolve(); await release.promise; return Response.json({ sessionId: 'provider-1' }); });
  const a = f.send();
  await started.promise;
  const b = f.send();
  release.resolve();
  expect((await a).status).toBe(101);
  expect((await b).status).toBe(101);
  f.reconstruct();
  expect((await f.send()).status).toBe(101);
  expect(f.created).toEqual(['provider-1']);
  expect(f.attached).toEqual(['provider-1', 'provider-1', 'provider-1']);
});

it.each(['owner', 'session', 'generation', 'token', 'account', 'strict', 'groups', 'policy', 'operator', 'termination'])(
  'REQ-BROWSER-008: changed %s authority cannot use retained browser or acquire a replacement', async change => {
    const f = await fixture();
    expect(await ownedBrowser(f.host, f.owner, 'acquire')).toBe('provider-1');
    if (change === 'owner') f.host._bucketName = 'other-owner';
    if (change === 'session') f.host._sessionId = 'other12345';
    if (change === 'generation') { f.records.set('lifecycleGeneration', 8); f.kv._set(f.sessionKey, { ...f.session, lifecycleGeneration: 8 }); }
    if (change === 'token') f.kv._set(SETUP_KEYS.BROWSER_RENDER_TOKEN, { token: 'rotated-token' });
    if (change === 'account') f.kv._store.set(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID, 'different-account');
    if (change === 'strict') f.kv._store.set(SETUP_KEYS.STRICT_EGRESS, 'inactive');
    if (change === 'groups') f.host._userGroups = ['different-policy-scope'];
    if (change === 'policy') f.host._jwtStamping = { mode: 'all', destinations: [] };
    if (change === 'operator') f.host._operatorPolicy = { schemaVersion: 1, networkHosts: ['api.cloudflare.com'], tools: [], writablePaths: [] } as BrowserHost['_operatorPolicy'];
    if (change === 'termination') f.kv._set(f.sessionKey, { ...f.session, status: 'stopping', terminationIntentId: 'stop-intent' });
    expect((await f.send()).status).toBe(503);
    expect(f.created).toEqual(['provider-1']);
    expect(f.attached).toEqual([]);
  });

it('REQ-BROWSER-008: unrelated settings saves do not invalidate identity', async () => {
  const f = await fixture();
  expect((await f.send()).status).toBe(101);
  f.kv._store.set('setup:unrelated-setting', 'changed');
  expect((await f.send()).status).toBe(101);
  expect(f.created).toEqual(['provider-1']);
});

it.each(['shutdown', 'generation', 'configuration'])('REQ-BROWSER-008: acquisition racing %s cannot commit a usable ID', async change => {
  const f = await fixture();
  const started = gate(), release = gate();
  f.setCreateResponse(async () => { started.resolve(); await release.promise; return Response.json({ sessionId: 'provider-1' }); });
  const connection = f.send();
  await started.promise;
  if (change === 'shutdown') { f.host._shutdownStartedAt = Date.now(); f.records.set(SHUTDOWN_REQUESTED_KEY, Date.now()); }
  if (change === 'generation') { f.records.set('lifecycleGeneration', 8); f.kv._set(f.sessionKey, { ...f.session, lifecycleGeneration: 8 }); }
  if (change === 'configuration') f.kv._set(SETUP_KEYS.BROWSER_RENDER_TOKEN, { token: 'rotated-token' });
  release.resolve();
  expect((await connection).status).toBe(503);
  expect(f.records.get(BROWSER_REFERENCE_KEY)).toEqual(f.owner);
  expect(f.attached).toEqual([]);
});

it.each(['timeout', 'malformed', 'envelope', 'redirect', 'failure', 'oversized', 'unsafe-id'])(
  'REQ-BROWSER-008: %s acquisition outcome is never automatically retried, including reconstruction', async outcome => {
    const f = await fixture();
    f.setCreateResponse(async () => {
      if (outcome === 'timeout') throw new DOMException('Ambiguous provider timeout', 'TimeoutError');
      if (outcome === 'malformed') return new Response('{', { headers: { 'content-type': 'application/json' } });
      if (outcome === 'envelope') return Response.json({ result: { sessionId: 'provider-1' } });
      if (outcome === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://foreign.example' } });
      if (outcome === 'failure') return new Response('unavailable', { status: 503 });
      if (outcome === 'unsafe-id') return Response.json({ sessionId: '../foreign' });
      return Response.json({ sessionId: 'provider-1', webSocketDebuggerUrl: 'x'.repeat(9000) });
    });
    expect((await f.send()).status).toBe(503);
    f.reconstruct();
    expect((await f.send()).status).toBe(503);
    expect(f.created).toEqual(['provider-1']);
    expect(f.attached).toEqual([]);
  });

it('REQ-BROWSER-008: missing strict EGRESS fails closed before acquisition with no direct fallback', async () => {
  const f = await fixture();
  f.env.EGRESS = undefined;
  const response = await f.send();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'EGRESS_UNAVAILABLE' });
  await expect(ownedBrowser(f.host, f.owner, 'acquire')).rejects.toThrow('unavailable');
  expect(f.created).toEqual([]);
  expect(f.direct).toEqual([]);
});

it('REQ-BROWSER-008: attachment failure retains reference without inventing expiry or a replacement', async () => {
  const f = await fixture();
  expect((await f.send()).status).toBe(101);
  f.failAttachments();
  expect((await f.send()).status).toBe(502);
  f.reconstruct();
  expect((await f.send()).status).toBe(502);
  expect(f.created).toEqual(['provider-1']);
  expect(f.records.get(BROWSER_REFERENCE_KEY)).toEqual({ ...f.owner, providerId: 'provider-1' });
});

it('REQ-BROWSER-008: managed foreign IDs/listing cannot borrow admin credentials; caller-owned exact-ID lane is unchanged', async () => {
  const f = await fixture();
  expect((await f.send()).status).toBe(101);
  expect((await f.send('/foreign-id')).status).toBe(403);
  const encoded = await f.interceptor.fetch(new Request(f.endpoint.replace('/devtools/browser', '/%64evtools/browser/foreign-id'), {
    headers: { upgrade: 'websocket' },
  }));
  expect(encoded.status).toBe(403);
  expect(f.attached).toEqual(['provider-1']);
  const listing = await f.interceptor.fetch(new Request(f.endpoint.replace('/devtools/browser', '/sessions')));
  expect(listing.status).toBe(403);
  // The external provider accepts this caller-owned ID; no owner RPC/admin substitution applies.
  f.created.push('caller-id');
  expect((await f.send('/caller-id', 'caller-owned-token')).status).toBe(101);
  expect(f.wire.at(-1)).toMatchObject({ url: `${f.endpoint}/caller-id`, auth: 'Bearer caller-owned-token' });
});

it('REQ-BROWSER-008: pre-start wiring binds D1 generation but acquisition waits for operational handoff', async () => {
  const f = await fixture();
  f.records.delete('lifecycleGeneration');
  f.kv._set(f.sessionKey, { ...f.session, status: 'starting', lifecycleGeneration: 8 });
  const next = (await browserOwnerReference(f.host)).browserOwner!;
  expect(next.generation).toBe(8);
  await expect(ownedBrowser(f.host, next, 'acquire')).rejects.toThrow();
  expect(f.created).toEqual([]);
  f.records.set('lifecycleGeneration', 8);
  expect(await ownedBrowser(f.host, next, 'acquire')).toBe('provider-1');
});

it('REQ-BROWSER-008: documented explicit POST creates a fresh owned reference; automatic reconnect never resets it', async () => {
  const f = await fixture();
  expect((await f.send()).status).toBe(101);
  const replacement = await f.interceptor.fetch(new Request(f.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  expect(replacement.status).toBe(200);
  expect(await replacement.json()).toEqual({ sessionId: 'provider-2', webSocketDebuggerUrl: `${f.endpoint.replace('https:', 'wss:')}/provider-2` });
  expect((await f.send()).status).toBe(101);
  expect(f.created).toEqual(['provider-1', 'provider-2']);
  expect(f.attached).toEqual(['provider-1', 'provider-2']);
});
