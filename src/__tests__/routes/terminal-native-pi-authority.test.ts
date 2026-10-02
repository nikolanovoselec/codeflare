import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only platform authentication/verification and external transports are replaced.
// Human extraction, live identity/policy resolution, sealing and interception are real.
const authentication = vi.hoisted(() => ({
  email: 'owner@example.test', bucket: 'owner-bucket',
  verified: new Map<string, import('../../lib/jwt').VerifiedHumanAccessClaims>(),
}));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({
    user: { email: authentication.email, authenticated: true }, bucketName: authentication.bucket,
  }),
}));
vi.mock('../../lib/jwt', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/jwt')>(),
  verifyHumanAccessJWT: async (token: string, domain: string, audience: string) => {
    const human = authentication.verified.get(token);
    return human?.issuer === `https://${domain}` && human.audiences.includes(audience)
      ? structuredClone(human) : null;
  },
}));
vi.mock('../../lib/cors-cache', () => ({ isAllowedOrigin: async () => true }));
vi.mock('../../lib/circuit-breakers', () => ({
  getContainerHealthCB: () => ({ execute: (work: () => Promise<unknown>) => work() }),
  getContainerSessionsCB: () => ({ execute: (work: () => Promise<unknown>) => work() }),
}));
vi.mock('@cloudflare/containers', () => ({
  getContainer: (namespace: { getByName(name: string): unknown }, name: string) => namespace.getByName(name),
}));

import { handleWebSocketUpgrade, validateWebSocketRoute } from '../../routes/terminal';
import { resetAuthConfigCache } from '../../lib/access';
import { bindReviewSessionHuman, discardReviewSessionHuman, openReviewSessionHuman } from '../../container/review-session-human';
import { confirmMonitoredExit, destroy, onStart, type LifecycleHost } from '../../container/container-lifecycle';
import { setBucketName } from '../../container/container-config';
import { SHUTDOWN_REQUESTED_KEY } from '../../container/container-metrics';
import { createLogger, setLogLevel } from '../../lib/logger';
import { LlmInterceptor } from '../../llm-interceptor';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { D1SessionRepository } from '../../lib/session-repository';
import type { VerifiedHumanAccessClaims } from '../../lib/jwt';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';

const owner = { bucket: 'owner-bucket', sessionId: 'ownersession1', user: 'owner@example.test' };
const ref = { bucket: owner.bucket, sessionId: owner.sessionId, email: owner.user };
const domain = 'native-pi.cloudflareaccess.com';
const issuer = `https://${domain}`;
const oldJwt = 'synthetic-old-human-access-jwt';
const freshJwt = 'synthetic-fresh-human-access-jwt';
const providerCredential = 'synthetic-personal-provider-token';
const bindingTransportError = `Synthetic binding transport unavailable: ${freshJwt} ${providerCredential} ${owner.bucket}/${owner.sessionId} ${owner.user}`;
// Native OpenAI OAuth/device login and Codex, plus the legacy GitHub device-code path.
const destinations = [
  'https://auth.openai.com/oauth/token',
  'https://auth.openai.com/api/accounts/oauth/token',
  'https://auth.openai.com/api/accounts/deviceauth/usercode',
  'https://chatgpt.com/backend-api/codex/responses',
  'https://github.com/login/device/code',
];

// Pinned Pi 0.99.1 OAuth and legacy device initialization are unauthenticated
// native login wires; neither carries the personal provider Bearer token.
const nativeLogins: { url: string; headers: Record<string, string>; body: string }[] = [
  { url: 'https://auth.openai.com/api/accounts/oauth/token',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: 'synthetic-oauth-code',
      code_verifier: 'synthetic-pkce-verifier', client_id: 'synthetic-client-id',
      redirect_uri: 'http://127.0.0.1:1455/auth/callback', resource: 'https://api.openai.com/v1' }).toString() },
  { url: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'synthetic-client-id' }) },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
  authentication.email = owner.user;
  authentication.bucket = owner.bucket;
  authentication.verified.clear();
  resetAuthConfigCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel('silent');
  vi.useRealTimers();
  resetAuthConfigCache();
});

async function fixture(initial: 'missing' | 'expired' | 'valid' = 'missing') {
  const kv = createMockKV();
  kv._store.set(SETUP_KEYS.AUTH_DOMAIN, domain);
  kv._store.set(SETUP_KEYS.ACCESS_AUD, 'native-pi-audience');
  kv._store.set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'Engineering');
  // Enabled fallback deliberately cannot rescue an explicitly revoked matching group.
  kv._set(SETUP_KEYS.REASONING_CONFIGURATION, {
    schemaVersion: 1, customProfileRevisions: [], routeAssignments: {},
    fallbackRouting: { enabled: true, routes: ['sanctioned-route'], defaultRoute: 'sanctioned-route',
      reasoning: 'off', allowPersonalPiProviders: true },
  });
  const policy = (allowed: boolean) => kv._set(SETUP_KEYS.GROUP_ROUTING, {
    Engineering: { routes: [], defaultRoute: '', reasoning: 'off', allowPersonalPiProviders: allowed },
  });
  policy(true);
  kv._set(`session:${owner.bucket}:${owner.sessionId}`, {
    id: owner.sessionId, name: 'Warm Pi', userId: owner.bucket, status: 'running', lifecycleGeneration: 1,
    createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
  });

  const now = Math.floor(Date.now() / 1000);
  const oldHuman: VerifiedHumanAccessClaims = {
    subject: 'owner-subject', email: owner.user, issuer, audiences: ['native-pi-audience'],
    issuedAt: now - 10, expiresAt: now + 60, groups: ['engineering-id'],
  };
  const verifiedHuman: VerifiedHumanAccessClaims = {
    ...oldHuman, issuedAt: now, expiresAt: now + 3600, groups: ['stale-signed-group'],
  };
  authentication.verified.set(freshJwt, verifiedHuman);
  const freshHuman = { ...verifiedHuman, groups: ['engineering-id'] };
  const records = new Map<string, unknown>([['lifecycleGeneration', 1]]);
  let authorityDeletionFailure: 'credential' | 'principal' | null = null;
  const actions = {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: unknown) => { records.set(key, value); },
    delete: async (key: string | string[]) => {
      for (const name of Array.isArray(key) ? key : [key]) {
        if ((authorityDeletionFailure === 'credential' && name === 'review:session-human')
          || (authorityDeletionFailure === 'principal' && name === 'review:session-principal')) {
          throw Error('Synthetic authority cleanup unavailable');
        }
        records.delete(name);
      }
    },
  };
  const storage = { ...actions,
    transaction: async <T>(work: (tx: typeof actions) => Promise<T>) => {
      const before = new Map(records);
      try { return await work(actions); }
      catch (error) {
        records.clear();
        for (const [key, value] of before) records.set(key, value);
        throw error;
      }
    },
  };
  const env = {
    ENTERPRISE_MODE: 'active', ENCRYPTION_KEY: btoa('a'.repeat(32)), KV: kv,
    USAGE_DB: createMockSessionD1(kv),
    CONTAINER: { getByName: (name: string) => {
      if (name !== `${owner.bucket}-${owner.sessionId}`) throw Error('Foreign container');
      return container;
    } },
  } as unknown as Env;
  // Only the process transport and SDK callbacks are synthetic. Lifecycle,
  // reconfiguration, authority sealing and repository mutations remain real.
  const process = {
    running: true,
    getTcpPort: () => ({ fetch: async (url: string) => {
      if (url.endsWith('/internal/agent-events/drain')) return Response.json({ hostNow: Date.now(), events: [] });
      if (url.endsWith('/internal/final-sync')) return Response.json({ synced: true });
      throw Error('Unexpected process request');
    } }),
  };
  const host: LifecycleHost = {
    _bucketName: owner.bucket, _sessionId: owner.sessionId, _userEmail: owner.user,
    _r2AccountId: null, _r2Endpoint: null, _r2AccessKeyId: null, _r2SecretAccessKey: null,
    _workspaceSyncEnabled: false, _fastStartEnabled: false, _tabConfig: null,
    _openaiApiKey: null, _geminiApiKey: null, _githubToken: null,
    _cloudflareApiToken: null, _cloudflareAccountId: null, _encryptionKey: null,
    _sessionMode: 'default', _sessionWorkspace: 'terminal', _terminalMode: 'classic',
    _containerAuthToken: 'synthetic-container-token', _vaultKey: null,
    _userGroups: [], _routeCatalog: [], _defaultRoute: null, _defaultReasoning: null,
    _routeContextWindows: {}, _routeReasoningLevels: {}, _modelDisplayNames: {},
    _userTimezone: null, _gitCloneRepo: null, _gitCloneRef: null,
    containerStartedAt: Date.now(), lastSeenInputAt: null, _usageSeconds: 0, _shutdownStartedAt: 0,
    idleTimeoutPref: '4h', envVars: {}, logger: createLogger('native-authority-test'), env,
    ctx: { storage, container: process, waitUntil: () => {} } as unknown as LifecycleHost['ctx'],
    stop: async () => { process.running = false; },
    superDestroy: async () => { process.running = false; },
    schedule: async () => {}, deleteSchedules: () => {},
  };
  const repository = new D1SessionRepository(env.USAGE_DB);
  const startReplacement = async () => {
    const claimed = await repository.start(owner.bucket, owner.sessionId, new Date().toISOString());
    if (!claimed) throw Error('Replacement Start not claimed');
    await setBucketName(host, owner.bucket, { sessionId: owner.sessionId, userEmail: owner.user,
      userGroups: ['Engineering'], routeCatalog: [], allowPersonalPiProviders: true,
      r2AccountId: 'synthetic-account', r2Endpoint: 'https://synthetic-account.r2.cloudflarestorage.com',
      workspaceSyncEnabled: false, fastStartEnabled: false, sessionWorkspace: 'terminal', terminalMode: 'classic' });
    process.running = true;
    bootId = 'restarted-compute';
    await onStart(host);
  };
  if (initial !== 'missing') {
    await bindReviewSessionHuman(host, { bucket: owner.bucket, sessionId: owner.sessionId,
      generation: 1, human: oldHuman, accessJwt: oldJwt });
  }
  if (initial === 'expired') vi.setSystemTime(Date.now() + 120_000);

  let bootId = 'already-running-compute';
  let terminalReady = true;
  let bindingFailure: 'renew' | 'revoke' | null = null;
  const restart = async () => {
    bootId = 'restarted-compute';
    records.set('lifecycleGeneration', Number(records.get('lifecycleGeneration')) + 1);
  };
  const containerFetch = async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ terminalServiceReady: terminalReady, prewarmReady: terminalReady, bootId });
    if (url.pathname !== '/terminal') throw Error('Unexpected compute request');
    // As in terminal-ws.test.ts, 200 stands in for the platform's 101 forward.
    return Response.json({ terminal: url.searchParams.get('session'), bootId,
      generation: records.get('lifecycleGeneration') });
  };
  const container = {
    fetch: containerFetch, forwardExisting: containerFetch,
    getState: async () => ({ status: 'running' }),
    start: restart, startAndWait: restart, destroy: restart,
    bindReviewHuman: (input: Parameters<typeof bindReviewSessionHuman>[1], expected?: Parameters<typeof bindReviewSessionHuman>[2]) => {
      if ((input && bindingFailure === 'renew') || (!input && bindingFailure === 'revoke')) {
        throw Error(bindingTransportError);
      }
      return bindReviewSessionHuman(host, input, expected);
    },
    openReviewHuman: (input: typeof ref) => openReviewSessionHuman(host, input),
  };
  const providerRequests: Request[] = [];
  let identity: unknown = { user_uuid: oldHuman.subject, email: owner.user,
    groups: [{ id: 'engineering-id', name: 'Engineering' }] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === `${issuer}/cdn-cgi/access/get-identity`) {
      if (identity === null) return new Response(null, { status: 503 });
      const cookie = request.headers.get('cookie');
      if (request.redirect !== 'manual' || ![oldJwt, freshJwt].some(jwt => cookie === `CF_Authorization=${jwt}`)) {
        return new Response(null, { status: 401 });
      }
      return Response.json(identity);
    }
    providerRequests.push(request);
    return Response.json({ upstream: 'native-provider-ok' });
  });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (work: Promise<unknown>) => { pending.push(work); },
    passThroughOnException() {} } as unknown as ExecutionContext;
  const reconnect = async (assertion: string | null = freshJwt) => {
    const headers = new Headers({ upgrade: 'websocket', origin: 'https://enterprise.example.test' });
    if (assertion !== null) headers.set('cf-access-jwt-assertion', assertion);
    const request = new Request(`https://enterprise.example.test/api/terminal/${owner.sessionId}-1/ws`, { headers });
    const response = await handleWebSocketUpgrade(request, env, ctx, validateWebSocketRoute(request));
    await Promise.all(pending.splice(0));
    return response;
  };
  const body = JSON.stringify({ model: 'native-personal-model', messages: [], device_code: 'synthetic-device-code' });
  const send = (url = destinations[0], props: Record<string, unknown> = {}, native?: { headers: Record<string, string>; body: string }) => {
    const interceptor = new LlmInterceptor({ props: { user: owner.user, sessionId: owner.sessionId,
      personalPi: owner, ...props } } as unknown as ExecutionContext, env);
    return interceptor.fetch(new Request(url, { method: 'POST', headers: {
      ...(native?.headers ?? { authorization: `Bearer ${providerCredential}`, 'content-type': 'application/json' }),
      'cf-access-jwt-assertion': 'must-not-forward-human-assertion',
      'cf-aig-authorization': 'must-not-forward-gateway-key',
      'x-codeflare-context': 'must-not-forward-platform-context',
      'x-codeflare-session': 'must-not-forward-platform-session',
    }, body: native?.body ?? body }));
  };
  return { kv, env, host, storage, repository, startReplacement, records, oldHuman, freshHuman, verifiedHuman, policy, reconnect, send, body,
    providerRequests, identity: (value: unknown) => { identity = value; },
    readiness: (ready: boolean) => { terminalReady = ready; },
    authorityDeletionFailure: (failure: 'credential' | 'principal' | null) => { authorityDeletionFailure = failure; },
    bindingFailure: (failure: 'renew' | 'revoke') => { bindingFailure = failure; },
  };
}

async function expectDenied(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ code: 'PERSONAL_PI_DENIED', error: 'Native Pi provider access is not permitted' });
}
function captureRenewalDiagnostics() {
  const entries: Record<string, unknown>[] = [];
  setLogLevel('warn');
  vi.spyOn(console, 'warn').mockImplementation((output: string) => { entries.push(JSON.parse(output)); });
  return entries;
}
function expectRenewalDiagnostic(entries: Record<string, unknown>[], stage: 'human-context' | 'parent-bind',
  reason: 'principal-mismatch' | 'shutdown' | 'unclassified') {
  const diagnostics = entries.filter(entry => entry.message === 'Native Pi human authority unavailable on terminal reconnect');
  // Intentional closed audit wire/security allowlist: never emit arbitrary
  // errors, claims or owner identifiers in this existing warning entry.
  expect(diagnostics).toEqual([{ timestamp: new Date().toISOString(), level: 'warn', module: 'terminal',
    message: 'Native Pi human authority unavailable on terminal reconnect', data: { stage, reason } }]);
  const wire = JSON.stringify(diagnostics);
  for (const secret of [oldJwt, freshJwt, providerCredential, owner.bucket, owner.sessionId, owner.user,
    'owner-subject', 'different-human', 'engineering-id', issuer, 'Synthetic binding transport unavailable']) {
    expect(wire).not.toContain(secret);
  }
}
async function expectReplacementAuthority(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await openReviewSessionHuman(f.host, ref)).toEqual({ human: f.freshHuman, accessJwt: freshJwt, generation: 2 });
  for (const url of destinations) {
    const response = await f.send(url, {}, nativeLogins.find(login => login.url === url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ upstream: 'native-provider-ok' });
  }
  expect(f.providerRequests.map(request => request.url)).toEqual(destinations);
  for (const request of f.providerRequests) {
    const login = nativeLogins.find(login => login.url === request.url);
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe(login ? null : `Bearer ${providerCredential}`);
    expect(await request.text()).toBe(login?.body ?? f.body);
    if (login) {
      for (const [name, value] of Object.entries(login.headers)) expect(request.headers.get(name)).toBe(value);
    }
    expect(request.redirect).toBe('manual');
    for (const header of ['cf-access-jwt-assertion', 'cf-aig-authorization', 'x-codeflare-context', 'x-codeflare-session']) {
      expect(request.headers.has(header)).toBe(false);
    }
  }
  for (const jwt of [oldJwt, freshJwt]) expect(JSON.stringify([...f.records])).not.toContain(jwt);
}
async function closeCode(response: Response) {
  const socket = response.webSocket!;
  const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code), { once: true }));
  socket.accept();
  return closed;
}

// Native provider authority formerly lived under REQ-ENTERPRISE-088 AC5/7;
// this HEAD splits it into REQ-ENTERPRISE-090 and REQ-ENTERPRISE-091.
describe('warm terminal native Pi authority', () => {
  it.each(['missing', 'expired'] as const)(
    'REQ-ENTERPRISE-090: %s sealed authority denies OAuth and device code before provider I/O', async initial => {
      const f = await fixture(initial);
      for (const url of destinations) await expectDenied(await f.send(url));
      expect(f.providerRequests.map(request => request.url)).toEqual([]);
      await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
    },
  );

  it.each(['missing', 'expired', 'valid'] as const)(
    'REQ-TERM-002: same-owner warm reconnect refreshes %s authority without restarting compute', async initial => {
      const f = await fixture(initial);
      const response = await f.reconnect();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ terminal: `${owner.sessionId}-1`, bootId: 'already-running-compute', generation: 1 });
      expect(await openReviewSessionHuman(f.host, ref)).toEqual({ human: f.freshHuman, accessJwt: freshJwt, generation: 1 });
      const session = await new D1SessionRepository(f.env.USAGE_DB).getSession(owner.bucket, owner.sessionId);
      expect(session).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 1 });
      for (const url of destinations) {
        const upstream = await f.send(url);
        expect(upstream.status).toBe(200);
        expect(await upstream.json()).toEqual({ upstream: 'native-provider-ok' });
      }
      expect(f.providerRequests.map(request => request.url)).toEqual(destinations);
    },
  );

  it('REQ-TERM-002: monitored exit permits next-generation reconnect and native OAuth/device forwarding without manual authority discard', async () => {
    const f = await fixture('valid');
    expect(await confirmMonitoredExit(f.host.ctx, f.env, owner.bucket, owner.sessionId, 1)).toBe(true);
    await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
    await expectDenied(await f.send());
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
    await f.startReplacement();
    const terminal = await f.reconnect();
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toEqual({ terminal: `${owner.sessionId}-1`, bootId: 'restarted-compute', generation: 2 });
    expect(await f.repository.getSession(owner.bucket, owner.sessionId)).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 2 });
    await expectReplacementAuthority(f);
  });

  it('REQ-ENTERPRISE-090: monitored replacement renews authority while old cleanup waits after fence commit', async () => {
    const f = await fixture('valid');
    let entered!: () => void;
    let release!: () => void;
    const cleanupEntered = new Promise<void>(resolve => { entered = resolve; });
    const cleanupReleased = new Promise<void>(resolve => { release = resolve; });
    const transaction = f.storage.transaction;
    f.storage.transaction = async work => {
      if (f.records.has(SHUTDOWN_REQUESTED_KEY)) {
        f.storage.transaction = transaction;
        entered();
        await cleanupReleased;
      }
      return await transaction(work);
    };
    const oldExit = confirmMonitoredExit(f.host.ctx, f.env, owner.bucket, owner.sessionId, 1);
    await cleanupEntered;
    try {
      await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
      await f.startReplacement();
      expect((await f.reconnect()).status).toBe(200);
      expect(await openReviewSessionHuman(f.host, ref)).toEqual({ human: f.freshHuman, accessJwt: freshJwt, generation: 2 });
    } finally {
      release();
      await oldExit;
    }
    await expectReplacementAuthority(f);
  });

  it.each(['credential', 'principal'] as const)(
    'REQ-ENTERPRISE-090: confirmed exit still denies provider access when %s cleanup rolls back', async failure => {
      const f = await fixture('valid');
      f.authorityDeletionFailure(failure);
      expect(await confirmMonitoredExit(f.host.ctx, f.env, owner.bucket, owner.sessionId, 1)).toBe(true);
      f.authorityDeletionFailure(null);
      await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
      await expect(bindReviewSessionHuman(f.host, { bucket: owner.bucket, sessionId: owner.sessionId,
        generation: 1, human: f.freshHuman, accessJwt: freshJwt })).rejects.toThrow();
      for (const login of nativeLogins) await expectDenied(await f.send(login.url, {}, login));
      expect(f.providerRequests.map(request => request.url)).toEqual([]);
    },
  );

  it('REQ-TERM-002: actual destroy and fresh Start on the surviving host permit same-owner native provider renewal', async () => {
    const f = await fixture('valid');
    await f.repository.claimStop(owner.bucket, owner.sessionId, 'deliberate-stop', new Date().toISOString(), 1);
    await destroy(f.host);
    expect(await f.repository.confirmStopped(owner.bucket, owner.sessionId, 1, 'deliberate-stop', new Date().toISOString())).toBe(true);
    await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
    await expectDenied(await f.send());
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
    await f.startReplacement();
    const terminal = await f.reconnect();
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toEqual({ terminal: `${owner.sessionId}-1`, bootId: 'restarted-compute', generation: 2 });
    await expectReplacementAuthority(f);
  });

  it('REQ-SESSION-018: delayed old-exit cleanup preserves replacement-generation sealed authority and provider access', async () => {
    const f = await fixture('valid');
    let entered!: () => void;
    let release!: () => void;
    const cleanupEntered = new Promise<void>(resolve => { entered = resolve; });
    const cleanupReleased = new Promise<void>(resolve => { release = resolve; });
    const transaction = f.storage.transaction;
    // Delay only the platform storage boundary after D1 confirms exit. The
    // replacement can be destroyed/reconfigured before old cleanup resumes.
    f.storage.transaction = async work => {
      f.storage.transaction = transaction;
      entered();
      await cleanupReleased;
      return transaction(work);
    };
    const oldExit = confirmMonitoredExit(f.host.ctx, f.env, owner.bucket, owner.sessionId, 1);
    await cleanupEntered;
    try {
      // Real teardown retires generation 1 while its monitor cleanup is delayed.
      await destroy(f.host);
      await f.startReplacement();
      expect((await f.reconnect()).status).toBe(200);
      expect(await openReviewSessionHuman(f.host, ref)).toEqual({ human: f.freshHuman, accessJwt: freshJwt, generation: 2 });
    } finally {
      release();
      await oldExit;
    }
    await expectReplacementAuthority(f);
  });

  it('REQ-SESSION-033: fresh-start completion preserves a newer shutdown when durable fencing fails', async () => {
    const f = await fixture('valid');
    const key = `session:${owner.bucket}:${owner.sessionId}`;
    const session = await f.kv.get(key, 'json') as Record<string, unknown>;
    f.kv._set(key, { ...session, status: 'starting' });
    let projected!: () => void;
    let releaseProjection!: () => void;
    let cleanupEntered!: () => void;
    let releaseCleanup!: () => void;
    const projectionCommitted = new Promise<void>(resolve => { projected = resolve; });
    const projectionReleased = new Promise<void>(resolve => { releaseProjection = resolve; });
    const cleanupWaiting = new Promise<void>(resolve => { cleanupEntered = resolve; });
    const cleanupReleased = new Promise<void>(resolve => { releaseCleanup = resolve; });
    // Delay the external database response after its first write commits.
    const prepare = f.env.USAGE_DB.prepare.bind(f.env.USAGE_DB);
    let delayResponse = true;
    f.env.USAGE_DB.prepare = sql => {
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        const run = bound.run.bind(bound);
        bound.run = async <T>() => {
          const result = await run<T>();
          if (delayResponse) {
            delayResponse = false;
            projected();
            await projectionReleased;
          }
          return result;
        };
        return bound;
      };
      return statement;
    };
    const starting = onStart(f.host);
    let stopping: Promise<void> | undefined;
    try {
      await projectionCommitted;
      expect(await f.repository.getSession(owner.bucket, owner.sessionId)).toMatchObject({
        lifecycleState: 'running', lifecycleGeneration: 1,
      });
      const put = f.storage.put;
      const remove = f.storage.delete;
      f.storage.put = async (name, value) => {
        if (name === SHUTDOWN_REQUESTED_KEY) throw Error('Synthetic shutdown storage unavailable');
        await put(name, value);
      };
      f.storage.delete = async name => {
        if (name === 'review:session-human') {
          cleanupEntered();
          await cleanupReleased;
        }
        await remove(name);
      };
      stopping = destroy(f.host);
      await cleanupWaiting;
      releaseProjection();
      await starting;
      await expect(bindReviewSessionHuman(f.host, { bucket: owner.bucket, sessionId: owner.sessionId,
        generation: 1, human: f.freshHuman, accessJwt: freshJwt })).rejects.toThrow();
      await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
      for (const login of nativeLogins) await expectDenied(await f.send(login.url, {}, login));
      expect(f.providerRequests.map(request => request.url)).toEqual([]);
    } finally {
      releaseProjection();
      releaseCleanup();
      await Promise.all([starting, stopping]);
    }
  });

  it('REQ-SESSION-033: stale fresh-start handoff cannot clear an assigned generation shutdown fence', async () => {
    const f = await fixture('valid');
    const key = `session:${owner.bucket}:${owner.sessionId}`;
    const session = await f.kv.get(key, 'json') as Record<string, unknown>;
    f.kv._set(key, { ...session, status: 'initializing' });
    f.records.set('lifecycleGeneration', 2);
    await f.storage.put(SHUTDOWN_REQUESTED_KEY, Date.now());
    f.host._shutdownStartedAt = Date.now();
    await expect(onStart(f.host)).rejects.toThrow();
    f.host._shutdownStartedAt = 0;
    await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
    for (const login of nativeLogins) await expectDenied(await f.send(login.url, {}, login));
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
    await f.storage.delete(SHUTDOWN_REQUESTED_KEY);
    f.records.set('lifecycleGeneration', 1);
    expect(await openReviewSessionHuman(f.host, ref)).toEqual({ human: f.oldHuman, accessJwt: oldJwt, generation: 1 });
  });

  it.each([
    ['running-replay', 'durable'], ['running-replay', 'memory'],
    ['stale-replay', 'durable'], ['stale-replay', 'memory'],
    ['stopping', 'durable'], ['stopping', 'memory'],
  ] as const)('REQ-SESSION-033: %s onStart preserves the %s shutdown fence and sealed principal', async (callback, fence) => {
    const f = await fixture('valid');
    if (fence === 'durable') await f.storage.put(SHUTDOWN_REQUESTED_KEY, Date.now());
    else f.host._shutdownStartedAt = Date.now();
    if (callback === 'stale-replay') f.records.set('lifecycleGeneration', 2);
    if (callback === 'stopping') await f.repository.claimStop(owner.bucket, owner.sessionId, 'pending-stop', new Date().toISOString(), 1);
    if (callback === 'running-replay') await onStart(f.host);
    else await expect(onStart(f.host)).rejects.toThrow();
    await expect(bindReviewSessionHuman(f.host, { bucket: owner.bucket, sessionId: owner.sessionId,
      generation: 1, human: f.freshHuman, accessJwt: freshJwt })).rejects.toThrow();
    await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
    await expectDenied(await f.send());
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
    // Inspect the original sealed authority after lifting only the synthetic
    // test fence; neither replay nor rejection may have replaced its principal.
    await f.storage.delete(SHUTDOWN_REQUESTED_KEY);
    f.host._shutdownStartedAt = 0;
    f.records.set('lifecycleGeneration', 1);
    expect(await openReviewSessionHuman(f.host, ref)).toEqual({ human: f.oldHuman, accessJwt: oldJwt, generation: 1 });
  });

  it.each(['missing-assertion', 'unverified', 'expired', 'foreign-email', 'identity-outage'] as const)(
    'REQ-ENTERPRISE-090: %s human reconnect cannot retain a previously valid sealed credential', async invalid => {
      const f = await fixture('valid');
      const diagnostics = captureRenewalDiagnostics();
      let assertion: string | null = freshJwt;
      if (invalid === 'missing-assertion') assertion = null;
      if (invalid === 'unverified') authentication.verified.delete(freshJwt);
      if (invalid === 'expired') authentication.verified.set(freshJwt, { ...f.verifiedHuman, expiresAt: 1 });
      if (invalid === 'foreign-email') authentication.verified.set(freshJwt, { ...f.verifiedHuman, email: 'foreign@example.test' });
      if (invalid === 'identity-outage') f.identity(null);
      const terminal = await f.reconnect(assertion);
      // Ordinary terminal access is independent of optional native provider authority.
      expect(terminal.status).toBe(200);
      expect(await terminal.json()).toMatchObject({ bootId: 'already-running-compute', generation: 1 });
      await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
      await expectDenied(await f.send());
      expect(f.providerRequests.map(request => request.url)).toEqual([]);
      expectRenewalDiagnostic(diagnostics, 'human-context', 'unclassified');
    },
  );

  it('REQ-ENTERPRISE-090: failed renewal revokes old authority while ordinary terminal remains usable', async () => {
    const f = await fixture('valid');
    const diagnostics = captureRenewalDiagnostics();
    f.bindingFailure('renew');
    const terminal = await f.reconnect();
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toEqual({ terminal: `${owner.sessionId}-1`, bootId: 'already-running-compute', generation: 1 });
    await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
    await expectDenied(await f.send());
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
    expectRenewalDiagnostic(diagnostics, 'parent-bind', 'unclassified');
  });

  it('REQ-ENTERPRISE-090: shutdown renewal retains denial and emits only the closed parent-bind diagnostic', async () => {
    const f = await fixture('valid');
    const diagnostics = captureRenewalDiagnostics();
    f.host._shutdownStartedAt = Date.now();
    const terminal = await f.reconnect();
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toEqual({ terminal: `${owner.sessionId}-1`, bootId: 'already-running-compute', generation: 1 });
    await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
    await expectDenied(await f.send());
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
    expectRenewalDiagnostic(diagnostics, 'parent-bind', 'shutdown');
  });

  it('REQ-ENTERPRISE-090: unconfirmed credential revocation rejects the reconnect rather than forwarding it', async () => {
    const f = await fixture('valid');
    f.bindingFailure('revoke');
    expect(await closeCode(await f.reconnect(null))).toBe(1011);
    // Failed transport must neither replace nor expose the existing principal.
    expect(await openReviewSessionHuman(f.host, ref)).toEqual({ human: f.oldHuman, accessJwt: oldJwt, generation: 1 });
  });

  it('REQ-ENTERPRISE-090: a foreign session owner cannot refresh or revoke the real owner authority', async () => {
    const f = await fixture('valid');
    authentication.email = 'foreign@example.test';
    authentication.bucket = 'foreign-bucket';
    const response = await f.reconnect();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(await openReviewSessionHuman(f.host, ref)).toEqual({ human: f.oldHuman, accessJwt: oldJwt, generation: 1 });
    await expectDenied(await f.send(destinations[0], {
      user: authentication.email, personalPi: { ...owner, bucket: authentication.bucket, user: authentication.email },
    }));
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
  });

  it('REQ-ENTERPRISE-090: a changed human subject cannot replace the immutable same-email session principal', async () => {
    const f = await fixture('expired');
    const diagnostics = captureRenewalDiagnostics();
    authentication.verified.set(freshJwt, { ...f.verifiedHuman, subject: 'different-human' });
    f.identity({ user_uuid: 'different-human', email: owner.user, groups: [{ id: 'engineering-id', name: 'Engineering' }] });
    const terminal = await f.reconnect();
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toEqual({ terminal: `${owner.sessionId}-1`, bootId: 'already-running-compute', generation: 1 });
    await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
    await expectDenied(await f.send());
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
    expectRenewalDiagnostic(diagnostics, 'parent-bind', 'principal-mismatch');
  });

  it('REQ-ENTERPRISE-090: matching-group revocation survives fresh reconnect despite an allowed fallback', async () => {
    const f = await fixture();
    await f.reconnect();
    expect(await openReviewSessionHuman(f.host, ref)).toMatchObject({ human: f.freshHuman, generation: 1 });
    expect((await f.send()).status).toBe(200);
    f.policy(false);
    const response = await f.reconnect();
    expect(response.status).toBe(200);
    await expectDenied(await f.send());
    expect(f.providerRequests.map(request => request.url)).toEqual([destinations[0]]);
  });

  it.each(['operatorInference', 'operatorPolicy'] as const)(
    'REQ-ENTERPRISE-091: a refreshed human credential never authorizes %s native transport', async mode => {
      const f = await fixture('valid');
      expect((await f.reconnect()).status).toBe(200);
      for (const url of destinations) await expectDenied(await f.send(url, { [mode]: { activityId: 'operator-activity' } }));
      expect(f.providerRequests.map(request => request.url)).toEqual([]);
    },
  );

  it('REQ-ENTERPRISE-090: stale D1 generation cannot bind fresh authority to replaced compute', async () => {
    const f = await fixture('expired');
    // Isolate the stale-generation check from principal mismatch. This is a
    // synthetic race setup, not evidence that monitored exit retires authority.
    await discardReviewSessionHuman(f.host);
    f.records.set('lifecycleGeneration', 2);
    await f.reconnect();
    await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
    await expectDenied(await f.send());
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
  });

  it('REQ-ENTERPRISE-090: stale reconnect cannot revoke valid replacement-generation authority', async () => {
    const f = await fixture('expired');
    await discardReviewSessionHuman(f.host);
    f.records.set('lifecycleGeneration', 2);
    await bindReviewSessionHuman(f.host, { bucket: owner.bucket, sessionId: owner.sessionId,
      generation: 2, human: f.freshHuman, accessJwt: freshJwt });
    expect(await closeCode(await f.reconnect())).toBe(1011);
    expect(await openReviewSessionHuman(f.host, ref)).toEqual({ human: f.freshHuman, accessJwt: freshJwt, generation: 2 });
    for (const url of destinations) expect((await f.send(url)).status).toBe(200);
    expect(f.providerRequests.map(request => request.url)).toEqual(destinations);
  });

  it('REQ-ENTERPRISE-090: generation replacement during policy I/O still denies a freshly rebound request', async () => {
    const f = await fixture();
    await f.reconnect();
    expect(await openReviewSessionHuman(f.host, ref)).toMatchObject({ human: f.freshHuman, generation: 1 });
    const originalGet = f.kv.get.getMockImplementation()!;
    f.kv.get.mockImplementation(async (key, type) => {
      const value = await originalGet(key, type);
      if (key === SETUP_KEYS.GROUP_ROUTING && f.records.get('lifecycleGeneration') === 1) {
        await discardReviewSessionHuman(f.host);
        f.records.set('lifecycleGeneration', 2);
        await bindReviewSessionHuman(f.host, { bucket: owner.bucket, sessionId: owner.sessionId,
          generation: 2, human: f.freshHuman, accessJwt: freshJwt });
      }
      return value;
    });
    await expectDenied(await f.send());
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
    expect(await openReviewSessionHuman(f.host, ref)).toEqual({ human: f.freshHuman, accessJwt: freshJwt, generation: 2 });
  });

  it.each(['stopped', 'not-ready'] as const)(
    'REQ-TERM-002: %s compute cannot acquire fresh authority through a rejected reconnect', async gate => {
      const f = await fixture('expired');
      if (gate === 'stopped') f.kv._set(`session:${owner.bucket}:${owner.sessionId}`, {
        id: owner.sessionId, userId: owner.bucket, status: 'stopped', lifecycleGeneration: 1,
      });
      else f.readiness(false);
      expect(await closeCode(await f.reconnect())).toBe(gate === 'stopped' ? 4503 : 1013);
      await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
      await expectDenied(await f.send());
      expect(f.providerRequests.map(request => request.url)).toEqual([]);
    },
  );

  it('REQ-ENTERPRISE-090: refreshed credentials stay sealed and outside public responses and provider platform headers', async () => {
    const f = await fixture('expired');
    const terminal = await f.reconnect();
    expect(terminal.status).toBe(200);
    const publicWire = await terminal.text();
    expect(await openReviewSessionHuman(f.host, ref)).toEqual({ human: f.freshHuman, accessJwt: freshJwt, generation: 1 });
    const upstream = await f.send();
    expect(upstream.status).toBe(200);
    const upstreamWire = await upstream.text();
    // Confidentiality, not an implementation snapshot: none of the persisted or
    // publicly returned values may expose the plaintext parent credential.
    for (const wire of [JSON.stringify([...f.records]), publicWire, upstreamWire]) {
      expect(wire).not.toContain(oldJwt);
      expect(wire).not.toContain(freshJwt);
      expect(wire).not.toContain(providerCredential);
    }
    expect(f.providerRequests.map(request => request.url)).toEqual([destinations[0]]);
    const forwarded = f.providerRequests[0];
    expect(forwarded.headers.get('authorization')).toBe(`Bearer ${providerCredential}`);
    expect(await forwarded.text()).toBe(f.body);
    expect(forwarded.redirect).toBe('manual');
    for (const header of ['cf-access-jwt-assertion', 'cf-aig-authorization', 'x-codeflare-context', 'x-codeflare-session']) {
      expect(forwarded.headers.has(header)).toBe(false);
    }
    expect(JSON.stringify([...forwarded.headers])).not.toContain(freshJwt);
    expect(JSON.stringify([...forwarded.headers])).not.toContain(oldJwt);
  });
});
