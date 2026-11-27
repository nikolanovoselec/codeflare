import { env as nativeEnv, runInDurableObject } from 'cloudflare:test';
import type { DurableObject as NativeDurableObject } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, WS_RATE_LIMIT_MAX_CONNECTIONS } from '../../lib/constants';
import { SESSION_JWT_AUD, signSessionJWT } from '../../lib/session-jwt';
import { setLogLevel } from '../../lib/logger';
import { handlePiWebRequest } from '../../routes/pi-web';
import type { Env, Session } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';

vi.mock('@cloudflare/containers', async original => ({
  ...await original<typeof import('@cloudflare/containers')>(),
  getContainer: (namespace: DurableObjectNamespace, name: string) => namespace.getByName(name),
}));

const SID = 'abcdef1234567890';
const GENERATION = 7;
const ATTEMPT = 'd00c2f0c-c268-44ad-a23a-384e27941ad1';
const ORIGIN = 'https://codeflare.example:8443';
const PREFIX = `/api/pi-web/${SID}/`;
const APP = `${PREFIX}g/${GENERATION}/`;
const OWNER_EMAIL = 'owner@example.com';
const OWNER = 'codeflare-owner-example-com';
const OTHER_EMAIL = 'other@example.com';
const OTHER = 'codeflare-other-example-com';
const COOKIE_SIGNING_KEY = 'pi-web-route-fixture-signing-key';
const LAST_ACCESS = '2026-01-01T00:00:00.000Z';
const QUERY = '?v=a%2Fb&v=two+words&empty=&bare';

type StoredSession = Session & { lifecycleGeneration: number; terminationIntentId?: string; boundaryActivityId?: string };
type Ingress = { transport: 'http' | 'native' | 'wake'; container: string; request: Request };

async function loginCookie(email: string): Promise<string> {
  const token = await signSessionJWT({ email, sub: email, ghLogin: email.split('@')[0], aud: SESSION_JWT_AUD }, COOKIE_SIGNING_KEY, 3600);
  return `codeflare_session=${token}`;
}

describe('Pi web Worker proxy (REQ-AGENT-272 AC5)', () => {
  let kv: ReturnType<typeof createMockKV>;
  let env: Env;
  let cookie: string;
  let ingress: Ingress[];
  let liveNativeStub: DurableObjectStub | undefined;
  let ordinary: boolean;
  let authorityDelayMs: number;
  let upstreamStatus: number;

  function putSession(fields: Partial<StoredSession> = {}, owner = OWNER) {
    kv._set(`session:${owner}:${SID}`, {
      id: SID, userId: owner, name: 'Test Pi', status: 'running', lifecycleGeneration: GENERATION,
      agentType: 'pi', terminalMode: 'classic', workspace: 'terminal',
      createdAt: LAST_ACCESS, lastAccessedAt: LAST_ACCESS, ...fields,
    } satisfies StoredSession);
  }

  beforeEach(async () => {
    kv = createMockKV();
    cookie = await loginCookie(OWNER_EMAIL);
    ingress = [];
    liveNativeStub = undefined;
    ordinary = true;
    authorityDelayMs = 0;
    upstreamStatus = 200;
    for (const email of [OWNER_EMAIL, OTHER_EMAIL]) {
      kv._set(`user:${email}`, { addedBy: 'test', role: 'user', accessTier: 'standard', subscriptionTier: 'standard' });
    }
    putSession();

    // Signed browser cookie, real dispatcher guards, and D1-shaped storage.
    // Fake only the Cloudflare transport boundary; refused traffic must leave
    // no request at the private port and cannot launch any replacement.
    const push = (transport: Ingress['transport'], container: string, request: Request) => {
      ingress.push({ transport, container, request });
    };
    const namespace = {
      idFromName: (name: string) => name,
      get: (id: string) => ({ claimBucketOwner: async () => id.startsWith('bucket-owner:') ? 'owned' : 'conflict' }),
      getByName: (name: string) => ({
        getPersonalPiSession: async () => {
          if (!ordinary) throw new Error('Ordinary session authority unavailable');
          if (authorityDelayMs) await new Promise(resolve => setTimeout(resolve, authorityDelayMs));
          return { generation: GENERATION, groups: [] };
        },
        forwardPiWebRead: async (request: Request, owner: { bucket: string; sessionId: string; email: string; generation: number }) => {
          if (!ordinary || owner.bucket !== OWNER || owner.sessionId !== SID || owner.email !== OWNER_EMAIL || owner.generation !== GENERATION) {
            return Response.json({ error: 'Pi web session is not authorized' }, { status: 403 });
          }
          if (authorityDelayMs) await new Promise(resolve => setTimeout(resolve, authorityDelayMs));
          push('http', name, request);
          return new Response('pi-web private port', { status: upstreamStatus });
        },
        getState: async () => ({ status: 'running' }),
        startSession: async () => { throw new Error('Proxy must not start a container'); },
        forwardExisting: async (request: Request) => {
          if (new URL(request.url).pathname === '/health') return Response.json({ status: 'healthy', terminalServiceReady: true });
          push('http', name, request);
          return new Response('pi-web private port', { status: upstreamStatus });
        },
        fetch: async (request: Request) => {
          push(request.headers.get('Upgrade')?.toLowerCase() === 'websocket' ? 'native' : 'wake', name, request);
          if (liveNativeStub && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
            return liveNativeStub.fetch(request);
          }
          return new Response('Unexpected native request', { status: 502 });
        },
      }),
    };
    env = {
      KV: kv,
      USAGE_DB: createMockSessionD1(kv),
      CONTAINER: namespace,
      ALLOWED_ORIGINS: 'codeflare.example',
      SAAS_MODE: 'active', OAUTH_CLIENT_ID: 'fixture-oauth-client', OAUTH_JWT_SECRET: COOKIE_SIGNING_KEY,
    } as unknown as Env;
  });

  function request(path: string, options: { upgrade?: boolean; body?: unknown; headers?: HeadersInit } = {}) {
    const headers = new Headers({ Origin: ORIGIN, Cookie: cookie });
    if (options.upgrade) {
      headers.set('Upgrade', 'websocket');
      headers.set('Connection', 'Upgrade');
      headers.set('Sec-WebSocket-Key', 'dGVzdC13ZWJzb2NrZXQta2V5');
      headers.set('Sec-WebSocket-Version', '13');
    }
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      headers.set('X-Requested-With', 'XMLHttpRequest');
    }
    new Headers(options.headers).forEach((value, name) => headers.set(name, value));
    return new Request(`${ORIGIN}${path}`, {
      headers, method: options.body === undefined ? 'GET' : 'POST',
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    });
  }

  it('REQ-AGENT-272/274: only a current owned attachment can submit a valid transcript intent', async () => {
    const scoped = `${APP}a/${ATTEMPT}/_intent`;
    const body = { generation: GENERATION, cwd: '/home/user/workspace', action: 'select', id: ATTEMPT };
    expect((await handlePiWebRequest(request(scoped, { body }), env)).status).toBe(200);
    expect(ingress).toHaveLength(1);
    expect(await ingress[0].request.json()).toEqual(body);
    expect((await handlePiWebRequest(request(scoped, { body: { ...body, generation: GENERATION - 1 } }), env)).status).toBe(409);
    expect((await handlePiWebRequest(request(scoped, { body: { ...body, id: '../escape' } }), env)).status).toBe(400);
    expect((await handlePiWebRequest(request(scoped), env)).status).toBe(405);
    expect((await handlePiWebRequest(request(scoped, { body, headers: { Origin: 'https://other.example' } }), env)).status).toBe(403);
    expect(ingress).toHaveLength(1);
  });

  it('REQ-AGENT-272 AC5: keeps an owned app fetch passive while preserving the exact scoped path, query, and canonical browser origin', async () => {
    const path = `${APP}assets/main.js${QUERY}`;
    const response = await handlePiWebRequest(request(path, {
      headers: {
        Authorization: 'Bearer browser-only', 'Cf-Access-Jwt-Assertion': 'browser-only',
        'X-Forwarded-Host': 'untrusted.example', 'X-Forwarded-Proto': 'http',
        Forwarded: 'host=untrusted.example;proto=http',
      },
    }), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('pi-web private port');
    // This observes the public-to-private transport contract, not calls to an internal helper.
    expect(ingress.map(({ transport, container }) => [transport, container])).toEqual([['http', `${OWNER}-${SID}`]]);
    const forwarded = ingress[0].request;
    const url = new URL(forwarded.url);
    expect(`${url.pathname}${url.search}`).toBe(path);
    expect(forwarded.headers.get('Origin')).toBe(ORIGIN);
    expect(forwarded.headers.get('Host') ?? url.host).toBe(new URL(ORIGIN).host);
    expect(forwarded.headers.get('Forwarded')).toBeNull();
    const forwardedHost = forwarded.headers.get('X-Forwarded-Host');
    if (forwardedHost !== null) expect(forwardedHost).toBe(new URL(ORIGIN).host);
    const forwardedProto = forwarded.headers.get('X-Forwarded-Proto');
    if (forwardedProto !== null) expect(forwardedProto).toBe('https');
    for (const header of ['Cookie', 'Authorization', 'Cf-Access-Jwt-Assertion']) {
      expect(forwarded.headers.get(header)).toBeNull();
    }
    expect(await kv.get(`session:${OWNER}:${SID}`, 'json')).toMatchObject({ lifecycleGeneration: GENERATION, lastAccessedAt: LAST_ACCESS });
  });

  it('reports bounded proxy timings only for a successful authorized document', async () => {
    const logs: { message: string; data?: Record<string, unknown> }[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((output: string) => {
      if (output.includes('Pi Web proxy timing')) logs.push(JSON.parse(output));
    });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    setLogLevel('info');
    try {
      authorityDelayMs = 50;
      const response = await handlePiWebRequest(request(`${APP}${QUERY}`), env);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('pi-web private port');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.has('Server-Timing')).toBe(false);
      ordinary = false;
      expect((await handlePiWebRequest(request(APP), env)).ok).toBe(false);
      expect(logs).toHaveLength(1);
      expect(logs[0].data).toEqual({ kind: 'document', authMs: expect.any(Number), eligibilityMs: expect.any(Number),
        dispatchMs: expect.any(Number) });
      expect(logs[0].data?.dispatchMs).toBeGreaterThanOrEqual(49);
    } finally {
      setLogLevel('silent');
      random.mockRestore();
      log.mockRestore();
    }
  });

  it('samples successful stock GETs but does not time non-success responses', async () => {
    const records: { data: Record<string, unknown> }[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((output: string) => {
      if (output.includes('Pi Web proxy timing')) records.push(JSON.parse(output));
    });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const asset = `${APP}assets/main.js`;
    setLogLevel('info');
    try {
      const sampled = await handlePiWebRequest(request(asset), env);
      expect(sampled.status).toBe(200);
      expect(sampled.headers.get('Cache-Control')).toBe('no-store');
      expect(sampled.headers.has('Server-Timing')).toBe(false);
      expect(records.map(record => record.data)).toEqual([
        { kind: 'asset', authMs: expect.any(Number), eligibilityMs: expect.any(Number),
          dispatchMs: expect.any(Number) },
      ]);

      random.mockReturnValue(0.99);
      expect((await handlePiWebRequest(request(asset), env)).status).toBe(200);
      expect(records).toHaveLength(1);

      random.mockReturnValue(0);
      upstreamStatus = 503;
      const unavailable = await handlePiWebRequest(request(APP), env);
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get('Cache-Control')).toBe('no-store');
      expect(unavailable.headers.has('Server-Timing')).toBe(false);
      expect(records).toHaveLength(1);
    } finally {
      setLogLevel('silent');
      random.mockRestore();
      log.mockRestore();
    }
  });

  it('REQ-AGENT-272 AC5: submits, reads, and cancels only the owned generation’s exact handoff request', async () => {
    const start = { generation: GENERATION, target: 'terminal', requestId: ATTEMPT };
    const cancel = { generation: GENERATION, requestId: ATTEMPT };
    const statusPath = `${PREFIX}_switch?generation=${GENERATION}&requestId=${ATTEMPT}`;
    for (const input of [request(`${PREFIX}_switch`, { body: start }), request(statusPath), request(`${PREFIX}_cancel`, { body: cancel })]) {
      const result = await handlePiWebRequest(input, env);
      expect(result.ok).toBe(true);
      expect(await result.text()).toBe('pi-web private port');
    }
    const observed = await Promise.all(ingress.map(async ({ transport, container, request: forwarded }) => {
      const url = new URL(forwarded.url);
      return [transport, container, forwarded.method, `${url.pathname}${url.search}`,
        forwarded.method === 'POST' ? await forwarded.json() : null];
    }));
    expect(observed).toEqual([
      ['http', `${OWNER}-${SID}`, 'POST', `${PREFIX}_switch`, start],
      ['http', `${OWNER}-${SID}`, 'GET', statusPath, null],
      ['http', `${OWNER}-${SID}`, 'POST', `${PREFIX}_cancel`, cancel],
    ]);
  });

  it.each(['_switch', '_cancel', '_switch status'] as const)(
    'REQ-AGENT-272 AC5: rejects stale %s after Start advances the lifecycle', async action => {
      const stale = { generation: GENERATION - 1, requestId: ATTEMPT };
      const input = action === '_switch status'
        ? request(`${PREFIX}_switch?generation=${stale.generation}&requestId=${ATTEMPT}`)
        : request(`${PREFIX}${action}`, { body: { ...stale, ...(action === '_switch' && { target: 'chat' }) } });
      const result = await handlePiWebRequest(input, env);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(ingress).toEqual([]);
    },
  );

  it('REQ-AGENT-272 AC5: stale stock prompts and reconnects cannot attach to a replacement writer', async () => {
    const previous = `${PREFIX}g/${GENERATION - 1}/`;
    const transcript = 'same-native-transcript';
    for (const scope of [previous, PREFIX]) {
      const result = await handlePiWebRequest(request(`${scope}api/sessions/${transcript}/prompt`, {
        body: { cwd: '/home/user/workspace', text: 'stale input' },
        headers: { 'X-Codeflare-Pi-Generation': String(GENERATION) },
      }), env);
      const events = await handlePiWebRequest(request(`${scope}api/sessions/${transcript}/events`, { upgrade: true }), env);
      const upload = await handlePiWebRequest(request(`${scope}api/sessions/${transcript}/attachments`, {
        body: { cwd: '/home/user/workspace', attachments: [{ kind: 'file', name: 'test.txt', mimeType: 'text/plain', data: 'dGVzdA==' }] },
        headers: { 'X-Codeflare-Pi-Generation': String(GENERATION) },
      }), env);
      expect(result.status).toBe(409);
      expect(upload.status).toBe(409);
      expect(events.status).toBe(409);
      expect(events.webSocket).toBeNull();
    }
    expect(ingress).toEqual([]);
    const current = await handlePiWebRequest(request(`${APP}api/sessions/${transcript}/prompt`, {
      body: { cwd: '/home/user/workspace', text: 'current input' },
    }), env);
    expect(current.status).toBe(200);
    expect(await ingress[0].request.json()).toMatchObject({ text: 'current input' });
  });

  it.each([false, true])('REQ-AGENT-272 AC5: unauthenticated and other-owner requests (upgrade=%s) never reach the private port', async upgrade => {
    const path = `${APP}${upgrade ? 'ws' : 'assets/main.js'}`;
    const unauthenticated = await handlePiWebRequest(request(path, { upgrade, headers: { Cookie: '' } }), env);
    const other = await handlePiWebRequest(request(path, { upgrade, headers: { Cookie: await loginCookie(OTHER_EMAIL) } }), env);
    expect(unauthenticated.status).toBe(401);
    expect(other.status).toBe(404);
    expect(await kv.get(`session:${OTHER}:${SID}`, 'json')).toBeNull();
    expect(ingress).toEqual([]);
  });

  it('REQ-AGENT-272 AC5: rejects cross-origin mutations/upgrades and an authenticated mutation with a mismatched CSRF token', async () => {
    const body = { generation: GENERATION, target: 'terminal', requestId: ATTEMPT };
    const crossOrigin = { Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'cross-site' };
    for (const input of [
      request(`${PREFIX}_switch`, { body, headers: crossOrigin }),
      request(`${APP}ws`, { upgrade: true, headers: crossOrigin }),
      request(`${PREFIX}_switch`, {
        body, headers: { Cookie: `${cookie}; ${CSRF_COOKIE_NAME}=real-token`, [CSRF_HEADER_NAME]: 'wrong-token' },
      }),
    ]) {
      expect((await handlePiWebRequest(input, env)).status).toBe(403);
    }
    expect(ingress).toEqual([]);
  });

  it.each([
    { status: 'stopped' }, { status: 'stopping', terminationIntentId: 'user-stop' },
  ] satisfies Partial<StoredSession>[])('REQ-AGENT-272 AC5: $status traffic and switch polling cannot wake the session', async fields => {
    putSession(fields);
    for (const input of [
      request(APP), request(`${APP}ws`, { upgrade: true }),
      request(`${PREFIX}_switch?generation=${GENERATION}&requestId=${ATTEMPT}`),
      request(`${PREFIX}_switch`, { body: { generation: GENERATION, target: 'chat', requestId: ATTEMPT } }),
    ]) {
      const result = await handlePiWebRequest(input, env);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.webSocket).toBeNull();
    }
    expect(ingress).toEqual([]);
    expect(await kv.get(`session:${OWNER}:${SID}`, 'json')).toMatchObject(fields);
  });

  it.each([
    { agentType: 'bash' }, { workspace: 'vscode' },
    { terminalMode: 'herdr' },
    { terminalMode: 'classic', tabConfig: [{ id: '1', command: '', label: 'Terminal 1' }] },
  ] satisfies Partial<StoredSession>[])('REQ-AGENT-272 AC5: rejects ineligible workspace or primary agent %j', async fields => {
    putSession(fields);
    const result = await handlePiWebRequest(request(APP), env);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(ingress).toEqual([]);
  });

  it('REQ-AGENT-272 AC5: refuses non-ordinary Pi sessions and inactive SaaS users', async () => {
    ordinary = false;
    putSession({ boundaryActivityId: 'boundary-activity-fixture' });
    expect((await handlePiWebRequest(request(APP), env)).status).toBeGreaterThanOrEqual(400);
    ordinary = true;
    putSession();
    kv._set(`user:${OWNER_EMAIL}`, { addedBy: 'test', role: 'user', accessTier: 'pending', subscriptionTier: 'pending' });
    expect((await handlePiWebRequest(request(APP), env)).status).toBe(403);
    expect(ingress).toEqual([]);
  });

  it.each([`/api/pi-web/${SID}`, `/api/pi-web/${SID}%2Fws`, `/api/pi-web/${SID}-extra/ws`, `/api/pi-web-extra/${SID}/ws`])(
    'REQ-AGENT-272 AC5: never proxies outside the exact trailing-slash session prefix (%s)', async path => {
      const result = await handlePiWebRequest(request(path, { upgrade: true }), env);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(ingress).toEqual([]);
    },
  );

  it('REQ-AGENT-272 AC5: applies the existing WebSocket limit per authenticated user but leaves HTTP usable', async () => {
    kv._set(`ws-connect:${OWNER_EMAIL}`, { count: WS_RATE_LIMIT_MAX_CONNECTIONS, windowStart: Date.now() });
    const result = await handlePiWebRequest(request(`${APP}ws`, { upgrade: true }), env);
    expect(result.status).toBe(429);
    expect(Number(result.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(ingress).toEqual([]);
    expect((await handlePiWebRequest(request(APP), env)).status).toBe(200);
  });

  it('REQ-AGENT-272 AC5: a current owner’s WebSocket reaches the native DO fetch with the exact session scope', async () => {
    const namespace = (nativeEnv as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
    liveNativeStub = namespace.get(namespace.newUniqueId());
    await runInDurableObject<NativeDurableObject, void>(liveNativeStub as DurableObjectStub<NativeDurableObject>, async instance => {
      instance.fetch = async (forwarded: Request) => {
        const url = new URL(forwarded.url);
        if (`${url.pathname}${url.search}` !== `${APP}ws${QUERY}` || forwarded.headers.get('Origin') !== ORIGIN
          || forwarded.headers.has('Cookie') || forwarded.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('Invalid forwarded handshake', { status: 400 });
        }
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].addEventListener('message', event => pair[1].send(`private port:${event.data}`));
        return new Response(null, { status: 101, webSocket: pair[0] });
      };
    });

    const response = await handlePiWebRequest(request(`${APP}ws${QUERY}`, { upgrade: true }), env);
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error('Native DO did not return an upgraded socket');
    socket.accept();
    try {
      let echoed: unknown;
      socket.addEventListener('message', event => { echoed = event.data; });
      socket.send('browser probe');
      await vi.waitFor(() => expect(echoed).toBe('private port:browser probe'), { timeout: 1000 });
      expect(ingress.map(({ transport, container }) => [transport, container])).toEqual([['native', `${OWNER}-${SID}`]]);
    } finally {
      socket.close(1000);
    }
  });
});
