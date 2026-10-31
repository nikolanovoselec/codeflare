import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import { createTestApp } from '../helpers/test-app';
import { D1SessionRepository } from '../../lib/session-repository';
import { getBucketName, resetAuthConfigCache } from '../../lib/access';
import { signSessionJWT, SESSION_JWT_AUD } from '../../lib/session-jwt';

const gateway = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  beforeDispatch: undefined as (() => void) | undefined,
  unavailable: false,
}));

// Real routes, authentication, mutation protection, rate limiter, D1 repository,
// DO and lifecycle logic. Only the SDK/native transport is modeled. The public
// SDK 0.3.7 destroy method awaits native destroy; never stub the DO override.
vi.mock('@cloudflare/containers', () => ({
  getContainer: (_namespace: unknown, address: string) => {
    if (gateway.unavailable) throw Error('DO transport unavailable before acceptance');
    gateway.beforeDispatch?.();
    const instance = gateway.sessions.get(address);
    if (!instance) throw Error('No native session at this address');
    return instance;
  },
  Container: class {
    constructor(public ctx: DurableObjectState, public env: Env) {}
    async destroy() { await this.ctx.container!.destroy(); }
    async stop(signal: string | number = 'SIGTERM') { this.ctx.container!.signal(signal === 'SIGTERM' ? 15 : Number(signal)); }
    async schedule(delay: number, callback: string) {
      return { taskId: crypto.randomUUID(), callback, type: 'delayed',
        time: Math.floor(Date.now() / 1000) + delay, delayInSeconds: delay };
    }
    deleteSchedules() {}
    renewActivityTimeout() {}
  },
}));

import sessionRoutes from '../../routes/session/index';
import { container as SessionContainer } from '../../container/index';

const id = 'session12345678';
const email = 'owner@example.test';
const otherEmail = 'other@example.test';
// Test-only signing material, unrelated to deployed credentials.
const jwtSecret = 'session-kill-route-fixture-signing-key-only';
const cleanupTasks: Array<() => Promise<void>> = [];

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

// Bound ordinary request completion with the fake clock. An accidental join of
// graceful Stop must fail an assertion, not hang until the suite timeout.
async function responseOf<T>(promise: Promise<T>): Promise<T> {
  let done = false, failed = false, value!: T, error: unknown;
  void promise.then(result => { value = result; done = true; }, reason => {
    failed = true; error = reason; done = true;
  });
  await vi.waitFor(() => expect(done).toBe(true));
  if (failed) throw error;
  return value;
}

async function fixture(status = 'running') {
  // Keep auth/rate-limit KV separate from the D1 adapter. Contradictory KV
  // session data must never become lifecycle authority at the HTTP boundary.
  const kv = createMockKV(), authority = createMockKV();
  const db = createMockSessionD1(authority), repository = new D1SessionRepository(db);
  const bucket = getBucketName(email), otherBucket = getBucketName(otherEmail);
  for (const owner of [email, otherEmail]) kv._set(`user:${owner}`, { role: 'user', subscriptionTier: 'standard' });
  const seed = (owner = bucket, sessionId = id, state = status, generation = 7) => {
    authority._set(`session:${owner}:${sessionId}`, { id: sessionId, userId: owner, name: 'Retained workspace',
      workspace: 'terminal', terminalMode: 'classic', status: state, lifecycleGeneration: generation,
      responseRevision: 4, ...(state === 'stopping' ? { terminationIntentId: 'retained-intent', terminationGeneration: generation } : {}) });
  };
  seed();
  const storage = new Map<string, unknown>([['bucketName', bucket], ['_sessionId', id],
    ['lifecycleGeneration', 7], ['containerAuthToken', 'runtime-token'], ['workspaceSyncEnabled', true]]);
  const exit = deferred();
  let nativeEntered = deferred(), enteredNative = false;
  let nativeGate: ReturnType<typeof deferred> | undefined;
  let nativeUnavailable = false, programRunning = true, gracefulShutdownRequested = false;
  let databaseUnavailable = false, providerBusy = false;
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    if (databaseUnavailable) throw Error('D1 unavailable');
    return prepare(sql);
  };
  const files = new Map([[`/${bucket}/workspace/kept.txt`, 'persistent file'], [`/${bucket}/Notes/kept.md`, 'persistent note']]);
  const originalFiles = new Map(files);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname !== 'r2.test') throw Error(`Unexpected external network: ${url.hostname}`);
    if (request.method === 'DELETE') {
      for (const path of files.keys()) if (path === url.pathname || path.startsWith(`${url.pathname}/`)) files.delete(path);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'PUT') { files.set(url.pathname, await request.text()); return new Response(null); }
    return files.has(url.pathname) ? new Response(files.get(url.pathname)) : new Response(null, { status: 404 });
  });
  const forbiddenGraceful = deferred();
  const runtime = {
    get running() { return programRunning; },
    monitor: () => exit.promise,
    signal: (_signal: number) => { gracefulShutdownRequested = true; },
    getTcpPort: (_port: number) => ({ fetch: async () => {
      await forbiddenGraceful.promise;
      return Response.json({ events: [], synced: true });
    } }),
    destroy: async () => {
      if (providerBusy) throw Error('competing native teardown');
      providerBusy = true; enteredNative = true; nativeEntered.resolve();
      try {
        await nativeGate?.promise;
        if (nativeUnavailable) throw Error('native destruction unconfirmed');
        programRunning = false;
      } finally { providerBusy = false; }
    },
  };
  const owners = new Map([[bucket, email], [otherBucket, otherEmail]]);
  const env = { KV: kv, USAGE_DB: db, R2_ACCOUNT_ID: 'test-account', R2_ENDPOINT: 'https://r2.test',
    R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret',
    ONBOARDING_LANDING_PAGE: 'active', OAUTH_CLIENT_ID: 'fixture-client', OAUTH_JWT_SECRET: jwtSecret,
    CONTAINER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (address: { toString: () => string }) => ({ claimBucketOwner: async (claimedEmail: string) =>
        owners.get(address.toString().replace(/^bucket-owner:/, '')) === claimedEmail ? 'owned' : 'conflict' }),
    },
  } as unknown as Env;
  let ready = Promise.resolve();
  const ownedWork = new Set<Promise<unknown>>();
  const store = {
    get: async (key: string | string[]) => Array.isArray(key)
      ? new Map(key.filter(k => storage.has(k)).map(k => [k, storage.get(k)])) : storage.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'string') storage.set(key, value);
      else for (const [k, v] of Object.entries(key)) storage.set(k, v);
    },
    delete: async (key: string | string[]) => {
      let deleted = 0;
      for (const k of Array.isArray(key) ? key : [key]) if (storage.delete(k)) deleted++;
      return Array.isArray(key) ? deleted : deleted > 0;
    },
    transaction: async <T>(work: (txn: unknown) => Promise<T>): Promise<T> => work(store),
    setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  const instance = new SessionContainer({ id: { toString: () => `${bucket}-${id}` }, container: runtime, storage: store,
    blockConcurrencyWhile: (work: () => Promise<void>) => { ready = ready.then(work); return ready; },
    waitUntil: (task: Promise<unknown>) => {
      ownedWork.add(task); void task.then(() => ownedWork.delete(task), () => ownedWork.delete(task));
    },
  } as unknown as DurableObjectState<Env>, env);
  await ready;
  gateway.sessions.set(`${bucket}-${id}`, instance);
  const app = createTestApp({ routes: [{ path: '/api/sessions', handler: sessionRoutes }],
    mockKV: kv, envOverrides: env });
  const token = async (owner: string) => signSessionJWT({ email: owner, sub: owner,
    ghLogin: owner.split('@')[0], aud: SESSION_JWT_AUD }, jwtSecret);
  const ownerToken = await token(email), otherToken = await token(otherEmail);
  const request = async (path = `/api/sessions/${id}/kill`, options: { owner?: 'owner' | 'other' | 'anonymous';
    mutationHeader?: boolean; method?: string; body?: Record<string, unknown>; cookie?: string } = {}) => {
    const headers = new Headers();
    if (options.owner !== 'anonymous') headers.set('Cookie', options.cookie ??
      `codeflare_session=${options.owner === 'other' ? otherToken : ownerToken}`);
    if (options.mutationHeader !== false) headers.set('X-Requested-With', 'XMLHttpRequest');
    if (options.body) headers.set('Content-Type', 'application/json');
    return app.request(`https://worker.test${path}`, { method: options.method ?? 'POST', headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  };
  cleanupTasks.push(async () => {
    nativeGate?.resolve(); forbiddenGraceful.resolve();
    await vi.advanceTimersByTimeAsync(150_000);
  });
  return { app, request, finish: (...args: Parameters<typeof request>) => responseOf(request(...args)),
    kv, authority, bucket, otherBucket, seed, repository, storage, env,
    read: () => repository.getSession(bucket, id),
    running: () => programRunning,
    gracefulShutdownRequested: () => gracefulShutdownRequested,
    files: () => new Map(files), originalFiles,
    holdNative: () => {
      nativeGate = deferred(); nativeEntered = deferred(); enteredNative = false;
      return { ...nativeGate, reached: () => enteredNative };
    },
    failNative: (fail: boolean) => { nativeUnavailable = fail; },
    failDatabase: (fail: boolean) => { databaseUnavailable = fail; },
  };
}

beforeEach(() => {
  vi.useFakeTimers(); resetAuthConfigCache();
  gateway.sessions.clear(); gateway.beforeDispatch = undefined; gateway.unavailable = false;
});
afterEach(async () => {
  try { for (const cleanup of cleanupTasks.splice(0)) await cleanup(); }
  finally { vi.unstubAllGlobals(); vi.useRealTimers(); resetAuthConfigCache(); }
});

describe('REQ-SESSION-039 / REQ-SESSION-040: owner-authenticated POST /api/sessions/:id/kill', () => {
  it.each(['starting', 'running', 'unreachable', 'stopping'])(
    'captures owner D1 generation and force-kills %s while retaining the session and files (REQ-SESSION-039 AC1-AC2/AC5-AC7 / REQ-SESSION-040 AC1)', async status => {
      const f = await fixture(status);
      // If the route reads KV instead of D1 it will incorrectly skip teardown.
      f.kv._set(`session:${f.bucket}:${id}`, { id, status: 'stopped', lifecycleGeneration: 99 });
      const response = await f.finish();
      expect(response.status).toBe(200);
      // Intentional HTTP success contract: same non-deleting stopped envelope as Stop.
      expect(await response.json()).toMatchObject({ success: true, stopped: true, id });
      expect(f.running()).toBe(false);
      expect(f.gracefulShutdownRequested()).toBe(false);
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7,
        name: 'Retained workspace', workspace: 'terminal', terminationIntentId: undefined });
      expect(await f.kv.get(`session:${f.bucket}:${id}`, 'json')).toEqual({ id, status: 'stopped', lifecycleGeneration: 99 });
      expect(f.files()).toEqual(f.originalFiles);
    },
  );

  it('does not report success until native destruction positively confirms exit (REQ-SESSION-040 AC1-AC2)', async () => {
    const f = await fixture(), gate = f.holdNative();
    let response: Response | undefined;
    const request = f.request().then(value => { response = value; });
    try {
      await vi.waitFor(async () => expect((await f.read())?.lifecycleState).toBe('stopping'));
      expect(response).toBeUndefined();
      expect(f.running()).toBe(true);
      expect((await f.read())?.terminationGeneration).toBe(7);
      expect((await f.read())?.terminationIntentId).toBeTruthy();
      expect(f.files()).toEqual(f.originalFiles);
      gate.resolve(); await responseOf(request);
      expect(response?.status).toBe(200);
      expect((await f.read())?.lifecycleState).toBe('stopped');
      expect(f.running()).toBe(false);
    } finally { gate.resolve(); }
  });

  it('returns idempotent success for a confirmed-stopped owner row even when the DO is unavailable (REQ-SESSION-040 AC5)', async () => {
    const f = await fixture('stopped'), before = await f.read();
    gateway.unavailable = true;
    const response = await f.finish();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, stopped: true, id });
    expect(await f.read()).toEqual(before);
    expect(f.running()).toBe(true);
    expect(f.files()).toEqual(f.originalFiles);
  });

  it.each(['anonymous', 'invalid-cookie'])(
    'rejects %s authentication before changing session ownership (REQ-SESSION-039 AC1)', async mode => {
      const f = await fixture(), before = await f.read();
      const response = await f.finish(undefined, mode === 'anonymous'
        ? { owner: 'anonymous' } : { cookie: 'codeflare_session=not-a-valid-signed-cookie' });
      expect(response.status).toBe(401);
      expect(await f.read()).toEqual(before);
      expect(f.running()).toBe(true);
      expect(f.storage.get('_sessionId')).toBe(id);
    },
  );

  it('enforces the existing state-changing request protection (REQ-SESSION-039 AC1)', async () => {
    const f = await fixture(), before = await f.read();
    const response = await f.finish(undefined, { mutationHeader: false });
    expect(response.status).toBe(403);
    expect(await f.read()).toEqual(before);
    expect(f.running()).toBe(true);
  });

  it('denies a blocked authenticated user under the existing access-tier policy (REQ-SESSION-039 AC1)', async () => {
    const f = await fixture(), before = await f.read();
    f.kv._set(`user:${email}`, { role: 'user', subscriptionTier: 'blocked' });
    const response = await f.finish();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'BLOCKED' });
    expect(await f.read()).toEqual(before);
    expect(f.running()).toBe(true);
  });

  it('cannot KILL another owner session even with a forged owner/generation request body (REQ-SESSION-039 AC1)', async () => {
    const f = await fixture(), before = await f.read();
    const response = await f.finish(undefined, { owner: 'other', body: { bucket: f.bucket, sessionId: id, generation: 7 } });
    expect(response.status).toBe(404);
    expect(await f.read()).toEqual(before);
    expect(await f.repository.getSession(f.otherBucket, id)).toBeNull();
    expect(f.running()).toBe(true);
    expect(f.files()).toEqual(f.originalFiles);
  });

  it('takes the target solely from the authenticated owner and URL, ignoring body authority (REQ-SESSION-039 AC1-AC2)', async () => {
    const f = await fixture();
    f.seed(f.otherBucket, 'othersession1234');
    const other = await f.repository.getSession(f.otherBucket, 'othersession1234');
    const response = await f.finish(undefined, { body: { bucket: f.otherBucket, sessionId: 'othersession1234', generation: 99 } });
    expect(response.status).toBe(200);
    expect(f.running()).toBe(false);
    expect((await f.read())?.lifecycleState).toBe('stopped');
    expect(await f.repository.getSession(f.otherBucket, 'othersession1234')).toEqual(other);
  });

  it.each(['INVALID-ID', 'short', 'a'.repeat(25)])('rejects malformed session ID %s without teardown (REQ-SESSION-039 AC1)', async invalid => {
    const f = await fixture(), before = await f.read();
    const response = await f.finish(`/api/sessions/${invalid}/kill`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await f.read()).toEqual(before);
    expect(f.running()).toBe(true);
  });

  it('returns owner-scoped not found for an absent D1 row despite a live-looking KV record (REQ-SESSION-039 AC2)', async () => {
    const f = await fixture();
    const missing = 'missing12345678';
    f.kv._set(`session:${f.bucket}:${missing}`, { id: missing, status: 'running', lifecycleGeneration: 7 });
    const response = await f.finish(`/api/sessions/${missing}/kill`);
    expect(response.status).toBe(404);
    expect(await f.repository.getSession(f.bucket, missing)).toBeNull();
    expect((await f.read())?.lifecycleState).toBe('running');
    expect(f.running()).toBe(true);
  });

  it('fails closed on owner-authority D1 outage without relying on KV (REQ-SESSION-039 AC2)', async () => {
    const f = await fixture();
    f.kv._set(`session:${f.bucket}:${id}`, { id, status: 'running', lifecycleGeneration: 7 });
    f.failDatabase(true);
    const response = await f.finish();
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(f.running()).toBe(true);
    f.failDatabase(false);
    expect(await f.read()).toMatchObject({ lifecycleState: 'running', terminationIntentId: undefined });
    expect((await f.finish()).status).toBe(200);
    expect(f.running()).toBe(false);
  });

  it('does not leave a Worker-owned stopping claim when DO acceptance fails (REQ-SESSION-039 AC3)', async () => {
    const f = await fixture(), before = await f.read();
    gateway.unavailable = true;
    const response = await f.finish();
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await f.read()).toEqual(before);
    expect(f.running()).toBe(true);
    gateway.unavailable = false;
    expect((await f.finish()).status).toBe(200);
    expect(f.running()).toBe(false);
  });

  it('rejects a generation replaced between the Worker D1 read and DO acceptance (REQ-SESSION-040 AC6)', async () => {
    const f = await fixture();
    gateway.beforeDispatch = () => { f.seed(f.bucket, id, 'running', 8); };
    const response = await f.finish();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.running()).toBe(true);
    expect(await f.read()).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 8, terminationIntentId: undefined });
    expect(f.storage.get('_sessionId')).toBe(id);
    expect(f.files()).toEqual(f.originalFiles);
  });

  it('returns failure for unconfirmed native exit and lets the owner retry the retained intent (REQ-SESSION-040 AC1-AC3)', async () => {
    const f = await fixture(); f.failNative(true);
    const failure = await f.finish();
    expect(failure.status).toBeGreaterThanOrEqual(500);
    const retained = await f.read();
    expect(retained).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7, terminationGeneration: 7 });
    expect(retained?.terminationIntentId).toBeTruthy();
    expect(f.running()).toBe(true);
    expect(f.storage.get('_sessionId')).toBeUndefined();
    expect(f.files()).toEqual(f.originalFiles);
    const status = await f.finish(`/api/sessions/${id}/status`, { method: 'GET' });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: 'stopping' });
    f.failNative(false);
    const gate = f.holdNative();
    let response: Response | undefined;
    const retry = f.request().then(value => { response = value; });
    try {
      await vi.waitFor(() => expect(gate.reached()).toBe(true));
      expect(response).toBeUndefined();
      expect((await f.read())?.terminationIntentId).toBe(retained?.terminationIntentId);
      gate.resolve(); await responseOf(retry);
      expect(response?.status).toBe(200);
      expect(f.running()).toBe(false);
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
      expect(f.files()).toEqual(f.originalFiles);
    } finally { gate.resolve(); }
  });

  it('coalesces concurrent owner KILL requests and preserves idempotency after a lost success response (REQ-SESSION-040 AC4-AC5)', async () => {
    const f = await fixture(), gate = f.holdNative();
    const first = f.request();
    try {
      await vi.waitFor(async () => expect((await f.read())?.lifecycleState).toBe('stopping'));
      const intent = (await f.read())?.terminationIntentId;
      const duplicate = f.request();
      await vi.advanceTimersByTimeAsync(100);
      expect(f.running()).toBe(true);
      expect((await f.read())?.terminationIntentId).toBe(intent);
      gate.resolve();
      const responses = await responseOf(Promise.all([first, duplicate]));
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const stopped = await f.read();
      expect(stopped?.lifecycleState).toBe('stopped');
      expect((await f.finish()).status).toBe(200);
      expect(await f.read()).toEqual(stopped);
      expect(f.running()).toBe(false);
    } finally { gate.resolve(); }
  });

  it('enforces the existing ten-per-minute owner mutation limit with HTTP retry guidance (REQ-SESSION-039 AC1)', async () => {
    const f = await fixture('stopped');
    for (let index = 0; index < 10; index++) expect((await f.finish()).status).toBe(200);
    // A blocked attempt must not kill even a currently live row.
    f.seed(f.bucket, id, 'running');
    const before = await f.read(), response = await f.finish();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMIT_ERROR' });
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(await f.read()).toEqual(before);
    expect(f.running()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await f.finish()).status).toBe(200);
    expect(f.running()).toBe(false);
  });

  it('keeps the mutation limit owner-scoped rather than allowing one owner to exhaust another (REQ-SESSION-039 AC1)', async () => {
    const f = await fixture('stopped');
    f.seed(f.otherBucket, id, 'stopped');
    for (let index = 0; index < 10; index++) expect((await f.finish()).status).toBe(200);
    expect((await f.finish()).status).toBe(429);
    const other = await f.finish(undefined, { owner: 'other' });
    expect(other.status).toBe(200);
    expect((await f.repository.getSession(f.otherBucket, id))?.lifecycleState).toBe('stopped');
    expect(f.running()).toBe(true);
  });

  it('does not expose KILL as a state-changing GET (REQ-SESSION-039 AC1)', async () => {
    const f = await fixture(), before = await f.read();
    const response = await f.finish(undefined, { method: 'GET' });
    expect(response.status).toBe(404);
    expect(await f.read()).toEqual(before);
    expect(f.running()).toBe(true);
  });
});
