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
// Native OpenAI OAuth/device login and Codex, plus the legacy GitHub device-code path.
const destinations = [
  'https://auth.openai.com/oauth/token',
  'https://auth.openai.com/api/accounts/deviceauth/usercode',
  'https://chatgpt.com/backend-api/codex/responses',
  'https://github.com/login/device/code',
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
  const actions = {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: unknown) => { records.set(key, value); },
    delete: async (key: string) => { records.delete(key); },
  };
  const storage = { ...actions,
    transaction: async <T>(work: (tx: typeof actions) => Promise<T>) => work(actions),
  };
  const host = {
    _bucketName: owner.bucket, _sessionId: owner.sessionId, _userEmail: owner.user,
    env: { ENCRYPTION_KEY: btoa('a'.repeat(32)) }, ctx: { storage },
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
        throw Error('Synthetic binding transport unavailable');
      }
      return bindReviewSessionHuman(host, input, expected);
    },
    openReviewHuman: (input: typeof ref) => openReviewSessionHuman(host, input),
  };
  const env = {
    ENTERPRISE_MODE: 'active', KV: kv, USAGE_DB: createMockSessionD1(kv),
    CONTAINER: { getByName: (name: string) => {
      if (name !== `${owner.bucket}-${owner.sessionId}`) throw Error('Foreign container');
      return container;
    } },
  } as unknown as Env;
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
  const send = (url = destinations[0], props: Record<string, unknown> = {}) => {
    const interceptor = new LlmInterceptor({ props: { user: owner.user, sessionId: owner.sessionId,
      personalPi: owner, ...props } } as unknown as ExecutionContext, env);
    return interceptor.fetch(new Request(url, { method: 'POST', headers: {
      authorization: `Bearer ${providerCredential}`, 'content-type': 'application/json',
      'cf-access-jwt-assertion': 'must-not-forward-human-assertion',
      'cf-aig-authorization': 'must-not-forward-gateway-key',
      'x-codeflare-context': 'must-not-forward-platform-context',
      'x-codeflare-session': 'must-not-forward-platform-session',
    }, body }));
  };
  return { kv, env, host, records, oldHuman, freshHuman, verifiedHuman, policy, reconnect, send, body,
    providerRequests, identity: (value: unknown) => { identity = value; },
    readiness: (ready: boolean) => { terminalReady = ready; },
    bindingFailure: (failure: 'renew' | 'revoke') => { bindingFailure = failure; },
  };
}

async function expectDenied(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ code: 'PERSONAL_PI_DENIED', error: 'Native Pi provider access is not permitted' });
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

  it.each(['missing-assertion', 'unverified', 'expired', 'foreign-email', 'identity-outage'] as const)(
    'REQ-ENTERPRISE-090: %s human reconnect cannot retain a previously valid sealed credential', async invalid => {
      const f = await fixture('valid');
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
    },
  );

  it('REQ-ENTERPRISE-090: failed renewal revokes old authority while ordinary terminal remains usable', async () => {
    const f = await fixture('valid');
    f.bindingFailure('renew');
    expect((await f.reconnect()).status).toBe(200);
    await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
    await expectDenied(await f.send());
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
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
    authentication.verified.set(freshJwt, { ...f.verifiedHuman, subject: 'different-human' });
    f.identity({ user_uuid: 'different-human', email: owner.user, groups: [{ id: 'engineering-id', name: 'Engineering' }] });
    await f.reconnect();
    await expect(openReviewSessionHuman(f.host, ref)).rejects.toThrow();
    await expectDenied(await f.send());
    expect(f.providerRequests.map(request => request.url)).toEqual([]);
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
    // Real lifecycle replacement discards both credential and old principal;
    // only generation comparison may reject this delayed generation-1 reconnect.
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
