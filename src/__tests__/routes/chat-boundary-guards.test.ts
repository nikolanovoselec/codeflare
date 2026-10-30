import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../index';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import type { Env } from '../../types';

// Additional first-party ingress contracts not covered by chat-integration.
const boundary = vi.hoisted(() => ({
  forbidContainer: false, upstreamUnavailable: false, hanging: false, realUpgrade: false,
  wire: [] as Request[],
}));
vi.mock('../../lib/access', async original => ({
  ...await original<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({ user: { email: 'owner@example.test', authenticated: true,
    accessTier: 'standard' }, bucketName: 'chat-owner' }),
}));
vi.mock('../../lib/cors-cache', async original => ({
  ...await original<typeof import('../../lib/cors-cache')>(), isAllowedOrigin: async () => true,
}));
vi.mock('../../lib/rate-limit-core', async original => ({
  ...await original<typeof import('../../lib/rate-limit-core')>(),
  checkRateLimit: async () => ({ allowed: true, count: 1, retryAfterSec: 60 }),
}));
vi.mock('@cloudflare/containers', async original => ({
  ...await original<typeof import('@cloudflare/containers')>(),
  getContainer: () => {
    if (boundary.forbidContainer) throw Error('Stopped compute must not be resolved');
    const forward = async (request: Request) => {
      boundary.wire.push(request.clone());
      if (boundary.hanging) return new Promise<Response>(() => {});
      if (boundary.upstreamUnavailable) return new Response('Unavailable', { status: 503 });
      if (boundary.realUpgrade) {
        const pair = new WebSocketPair();
        pair[1].accept(); pair[1].close(1000, 'fixture');
        return new Response(null, { status: 101, webSocket: pair[0],
          headers: { 'Set-Cookie': 'private_backend=must-not-reach-browser' } });
      }
      // Transport fixture only: it observes the handshake sent by our Worker,
      // not the upstream protocol or its reducers.
      return Response.json({ sessionId: 'live-primary-pi', generation: 7 }, {
        headers: { 'Set-Cookie': 'private_backend=must-not-reach-browser' },
      });
    };
    return { forwardExisting: forward, fetch: forward,
      start: () => { throw Error('No start allowed'); } };
  },
}));

describe('REQ-AGENT-224: strict Worker ingress and private-hop authority', () => {
  const sid = 'abcdef0123456789';
  let kv: ReturnType<typeof createMockKV>;
  let env: Env;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const store = (change: Record<string, unknown> = {}) => kv._set(`session:chat-owner:${sid}`, {
    id: sid, userId: 'chat-owner', name: 'Pi', agentType: 'pi', status: 'running',
    workspace: 'terminal', terminalMode: 'classic', lifecycleGeneration: 7,
    createdAt: '2026-10-29T00:00:00Z', lastAccessedAt: '2026-10-29T00:00:00Z', ...change,
  });
  beforeEach(() => {
    Object.assign(boundary, { forbidContainer: false, upstreamUnavailable: false, hanging: false, realUpgrade: false });
    boundary.wire.length = 0;
    kv = createMockKV();
    env = { KV: kv, USAGE_DB: createMockSessionD1(kv), CONTAINER: {}, SAAS_MODE: 'active' } as unknown as Env;
    store();
  });
  const request = (path: string, init: RequestInit = {}) => new Request(`https://codeflare.ch/api/chat/${sid}${path}`, {
    ...init, headers: { Origin: 'https://codeflare.ch', 'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest', ...Object.fromEntries(new Headers(init.headers)) },
  });
  const send = (path: string, init: RequestInit = {}) => worker.fetch(request(path, init), env, ctx);

  it('replaces browser generation authority and strips browser credentials on explicit Standard Pi entry', async () => {
    const result = await send('/attach', { method: 'POST', body: '{"generation":7}', headers: {
      'X-Codeflare-Chat-Generation': '900', Authorization: 'Bearer browser-secret',
      Cookie: 'codeflare_session=browser-secret', 'Cf-Access-Jwt-Assertion': 'browser-secret',
      Forwarded: 'for=evil', 'X-Forwarded-For': 'evil',
    } });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ sessionId: 'live-primary-pi', generation: 7 });
    expect(result.headers.get('Set-Cookie')).toBeNull();
    const wire = boundary.wire.find(r => new URL(r.url).pathname.endsWith('/attach'))!;
    expect(wire.headers.get('X-Codeflare-Chat-Generation')).toBe('7');
    for (const name of ['Authorization', 'Cookie', 'Cf-Access-Jwt-Assertion', 'Forwarded', 'X-Forwarded-For']) {
      expect(wire.headers.get(name)).toBeNull();
    }
    expect(wire.headers.get('X-Forwarded-Host')).toBe('codeflare.ch');
    expect(wire.headers.get('X-Forwarded-Proto')).toBe('https');
    expect(wire.headers.get('Origin')).toBe('https://codeflare.ch');
    expect(await wire.json()).toEqual({ generation: 7 });
  });

  it('forwards an admitted reconnect handshake with D1 authority and without changing activity', async () => {
    const result = await send('/ws?generation=7', { headers: {
      Upgrade: 'websocket', 'X-Codeflare-Chat-Generation': '900', Cookie: 'browser-secret',
    } });
    expect(result.status).toBe(200); // Fixture response, not a simulated upstream protocol.
    const wire = boundary.wire.find(r => new URL(r.url).pathname.endsWith('/ws'))!;
    expect(wire.method).toBe('GET');
    expect(wire.headers.get('Upgrade')).toBe('websocket');
    expect(wire.headers.get('X-Codeflare-Chat-Generation')).toBe('7');
    expect(wire.headers.get('Cookie')).toBeNull();
    expect(await kv.get(`session:chat-owner:${sid}`, 'json')).toMatchObject({
      status: 'running', lastAccessedAt: '2026-10-29T00:00:00Z',
    });
  });

  it('preserves the native socket but not private cookies on a successful upgrade', async () => {
    boundary.realUpgrade = true;
    const result = await send('/ws?generation=7', { headers: { Upgrade: 'websocket' } });
    expect(result.status).toBe(101);
    expect(result.webSocket).toBeTruthy();
    expect(result.headers.get('Set-Cookie')).toBeNull();
  });

  it.each(['stopped', 'stopping'])('rejects %s without resolving a container', async status => {
    store({ status }); boundary.forbidContainer = true;
    expect((await send('/attach', { method: 'POST', body: '{"generation":7}' })).status).toBe(409);
  });
  it.each([{ terminalMode: 'unknown' }, { workspace: 'unknown' }])('rejects ineligible persisted surface stamps %j', async change => {
    store(change);
    expect((await send('/attach', { method: 'POST', body: '{"generation":7}' })).status).toBe(409);
    expect(boundary.wire).toEqual([]);
  });
  it.each(['', '?generation=-1', '?generation=1.5', '?generation=7e0', '?generation=9007199254740992',
    '?generation=7&generation=7', '?generation=7&sessionId=foreign'])('rejects malformed reconnect generation %s', async query => {
    expect((await send(`/ws${query}`, { headers: { Upgrade: 'websocket' } })).status).toBe(400);
    expect(boundary.wire).toEqual([]);
  });
  it.each([
    ['/ws?generation=7', 'POST'], ['/ws?generation=7', 'GET'],
    ['/api/questions/q?generation=7', 'DELETE'], ['/api/questions/q/answer?generation=7', 'GET'],
    ['/attach', 'HEAD'],
  ])('rejects unsafe method or absent upgrade: %s %s', async (path, method) => {
    expect((await send(path, { method })).status).toBe(method === 'GET' && path.startsWith('/ws') ? 400 : 405);
    expect(boundary.wire).toEqual([]);
  });
  it('requires Origin on browser WebSocket handshakes', async () => {
    const req = request('/ws?generation=7', { headers: {
      Upgrade: 'websocket', 'Sec-WebSocket-Key': 'browser-key', 'Sec-Fetch-Mode': 'websocket',
    } });
    req.headers.delete('Origin');
    expect((await worker.fetch(req, env, ctx)).status).toBe(403);
    expect(boundary.wire).toEqual([]);
  });
  it.each([{}, { answer: 'a', cancelled: true }, { answer: 1 }, { cancelled: false },
    { answer: 'a', automatic: true }, { answer: 'a', source: 'timeout' }, { cancelled: true, sessionId: 'foreign' }, null])(
    'rejects non-upstream or authority-bearing answer envelopes %j', async body => {
      expect((await send('/api/questions/q/answer?generation=7', {
        method: 'POST', body: JSON.stringify(body),
      })).status).toBe(400);
      expect(boundary.wire).toEqual([]);
    });
  it('bounds a streamed answer even without Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ answer: 'x'.repeat(64 * 1024) })));
      controller.close();
    } });
    expect((await send('/api/questions/q/answer?generation=7', { method: 'POST', body: stream })).status).toBe(413);
    expect(boundary.wire).toEqual([]);
  });
  it('rejects invalid JSON rather than sending it to the Host', async () => {
    expect((await send('/attach', { method: 'POST', body: '{' })).status).toBe(400);
    expect(boundary.wire).toEqual([]);
  });
  it('fails closed when the existing private Host is unavailable', async () => {
    boundary.upstreamUnavailable = true;
    expect((await send('/attach', { method: 'POST', body: '{"generation":7}' })).status).toBe(503);
  });
  it('bounds an unresponsive existing transport without starting replacement compute', async () => {
    vi.useFakeTimers();
    try {
      boundary.hanging = true;
      const result = send('/attach', { method: 'POST', body: '{"generation":7}' });
      await vi.runAllTimersAsync();
      expect((await result).status).toBe(503);
    } finally { vi.useRealTimers(); }
  });
});
