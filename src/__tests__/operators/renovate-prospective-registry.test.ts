/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry, type CurrentProspectiveRegistration, type ManagementExecutionSelection, type ProspectiveAdmission } from '../../operators/registry';
import { OperatorActivity, createOperatorIntentDigest } from '../../operators/activity';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { connectionSecret, createNormalDispatcherTransport, normalDeployment, normalDispatcherBundle } from './fixtures/normal-dispatcher';
import { sealOperatorSecret } from '../../operators/protected-secrets';
import { DispatcherAuthorityUnavailable, OperatorRuntimeCapability, authorizeDispatcherPlan } from '../../operators/operator-runtime-capability';
import { createMockKV } from '../helpers/mock-kv';
import { setLogLevel } from '../../lib/logger';
import { captureError, hashDiagnostic } from '../../operators/dispatcher-diagnostics-wire';
import { Hono } from 'hono';
import * as access from '../../lib/access';
import { openOperatorExecutionAccess } from '../../operators/execution-context';
import activityRoutes from '../../routes/operator-activities';
import { listProspectiveRenovatePrs } from '../../operators/renovate-prospective';
import { createOwnerRawCaptureStorage, readRawCapture, type RawCaptureReceipt } from '../../operators/raw-capture-storage';
import type { Env } from '../../types';
import type { ProspectiveRenovateRetryProof } from '../../operators/renovate-retry-proof';

const repoId = 424242, head = 'a'.repeat(40), newerHead = 'b'.repeat(40);
const at = new Date().toISOString();
// Manually driven fixtures must not leave backing objects or alarms for later cases.
afterEach(async () => { await reset(); });
const claims = (email: string, lifetimeSeconds = 300) => ({ subject: email, email, issuer: 'https://owner.cloudflareaccess.com',
  audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 20,
  expiresAt: Math.floor(Date.now() / 1000) + lifetimeSeconds });
type Registration = { ok: true; activatedAt: string; registrationId: string } | { ok: false; reason: string };
type Reservation = { ok: true; activityId: string; actor: { registrationId: string; bucket: string;
  sessionId: string; sessionGeneration: number } } | { ok: false; reason: string };
type Prospective = {
  activateProspectiveRenovate(input: { installationId: string; bucket: string; sessionId: string;
    sessionGeneration: number; scope?: 'installation'; human: ReturnType<typeof claims>; accessJwt: string;
    repository?: { repository: string; repositoryId: number; baseBranch: string } }): Promise<Registration>;
  alarm(): Promise<void>;
  prospectiveRenovateStatus(installationId: string, ownerKey: string): Promise<string>;
  currentProspectiveRenovateRegistration(registrationId: string): Promise<unknown | null>;
  observeProspectiveRenovateRegistration(registrationId: string): Promise<
    { status: 'current'; registration: CurrentProspectiveRegistration }
    | { status: 'unavailable' } | { status: 'denied' }>;

  reserveProspectiveRenovateActivity(input: { registrationId: string; repositoryId: number;
    pullRequest: number; head: string; createdAt: string; activityId: string }): Promise<Reservation>;
  readProspectiveRenovateAdmission(activityId: string): Promise<unknown | null>;
  retainedProspectiveRenovateRetryTargets(registrationId: string): Promise<unknown[]>;
};

async function fixture(run: (context: { registry: Prospective; restart: () => Prospective;
  native: DurableObjectState; environment: Env; selection: object; proofs: Map<string, unknown>;
  state: { sessions: Map<string, { generation: number; status: string }>;
    roles: Map<string, string>; revoked: Set<string>; enabled: boolean;
    identityFault: 'valid' | 'revoked' | 'forbidden' | 'unavailable' | 'malformed' | 'transport-error' | 'timeout' } }) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.getByName(`prospective-registry-${crypto.randomUUID()}`), async (_instance, native) => {
    const state = { sessions: new Map([['asession01', { generation: 3, status: 'running' }],
      ['zsession01', { generation: 4, status: 'running' }]]),
      roles: new Map([['a@example.test', 'admin'], ['z@example.test', 'admin']]),
      revoked: new Set<string>(), enabled: true,
      identityFault: 'valid' as 'valid' | 'revoked' | 'forbidden' | 'unavailable' | 'malformed' | 'transport-error' | 'timeout' };
    const kv = createMockKV();
    const database = { prepare: () => ({ bind: (...args: unknown[]) => ({ first: async () => {
      const session = state.sessions.get(String(args[1]));
      return session && args[0] === 'owner-bucket' ? {
        owner_key: 'owner-bucket', session_id: args[1], lifecycle_state: session.status,
        lifecycle_generation: session.generation, name: 'Admin session', workspace: 'default',
        terminal_mode: 'terminal', created_at: at, last_accessed_at: at, response_revision: 0,
        observation_sequence: 0, editor_ready: 1, editor_ready_error: 0,
      } : null;
    } }) }) };
    kv.get = vi.fn(async (key: string) => key.startsWith('user:')
      ? JSON.stringify({ role: state.roles.get(key.slice(5)) ?? 'user' }) : kv._store.get(key) ?? null) as typeof kv.get;
    const proofs = new Map<string, unknown>();
    const environment = { OPERATOR_ACTIVITY: { getByName: (id: string) => ({
      readProspectiveRenovateRetryProof: async () => proofs.get(id) ?? null,
    }) }, ENCRYPTION_KEY: btoa('k'.repeat(32)),
      USAGE_DB: database, KV: kv } as unknown as Env;
    const registry = new OperatorRegistry(native, environment);
    const selection = { controlsRevision: 1, installation: { id: 'dispatcher-install', operatorId: 'dispatcher',
      enabled: true, revision: 1, releaseId: 'release',
      configurationJson: JSON.stringify({ renovate: { repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 900 } }), policy: { capabilities: ['fetch'], resourceProfileId: null } },
      operator: { id: 'dispatcher', operatorId: 'dispatcher', profile: 'dispatcher', revision: 1,
        policy: { capabilities: ['fetch'], resourceProfileId: null },
        invokers: { users: ['a@example.test', 'z@example.test'], groups: [] } },
      release: { id: 'release', bundleDigest: 'c'.repeat(64) }, manifestJson: JSON.stringify({
        id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion: '3' }) };
    const restart = () => {
      const next = new OperatorRegistry(native, environment);
      vi.spyOn(next, 'resolveManagementExecution').mockImplementation(async () => state.enabled
        ? { ok: true, value: selection } as never : { ok: false, reason: 'disabled' });
      return next as unknown as Prospective;
    };
    vi.spyOn(registry, 'resolveManagementExecution').mockImplementation(async () => state.enabled
      ? { ok: true, value: selection } as never : { ok: false, reason: 'disabled' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_request, init) => {
      const cookie = new Headers(init?.headers).get('Cookie') ?? '';
      const token = cookie.replace(/^CF_Authorization=/, '');
      if (state.revoked.has(token) || state.identityFault === 'revoked') return new Response(null, { status: 401 });
      if (state.identityFault === 'forbidden') return new Response(null, { status: 403 });
      if (state.identityFault === 'unavailable') return new Response(null, { status: 503 });
      if (state.identityFault === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
      if (state.identityFault === 'transport-error') throw new Error('Identity transport unavailable');
      return Response.json({ id: `${token.slice(0, 1)}@example.test`,
        email: `${token.slice(0, 1)}@example.test`,
        ...(state.identityFault === 'malformed' ? { groups: null } : {}) });
    };
    try { await run({ registry: registry as unknown as Prospective, restart, native,
      environment, selection, state, proofs }); }
    finally { globalThis.fetch = originalFetch; }
  });
}
async function enroll(registry: Prospective, user: 'a' | 'z', generation = user === 'a' ? 3 : 4, repository = { repository: 'acme/updates', repositoryId: repoId, baseBranch: 'trunk' }, lifetimeSeconds = 300) {
  return registry.activateProspectiveRenovate({ installationId: 'dispatcher-install', bucket: 'owner-bucket',
    sessionId: `${user}session01`, sessionGeneration: generation, human: claims(`${user}@example.test`, lifetimeSeconds), accessJwt: `${user}-jwt`, repository });
}
function pr(registrationId: string, activatedAt: string, patch: Record<string, unknown> = {}) {
  return { registrationId, repository: 'acme/updates', baseBranch: 'trunk', repositoryId: repoId, pullRequest: 1300, head,
    createdAt: new Date(Date.parse(activatedAt) + 1).toISOString(), activityId: 'activity-1', ...patch };
}

async function dispatcherPlan(registry: Prospective, environment: Env, selection: object,
  patch: { delegated?: boolean; human?: Partial<ReturnType<typeof claims>>; accessJwt?: string } = {}) {
  const activation = patch.delegated ? await activateInstallation(registry) : await enroll(registry, 'a');
  if (!activation.ok) throw Error('No activation');
  const observed = await registry.observeProspectiveRenovateRegistration(activation.registrationId);
  if (observed.status !== 'current') throw Error('No registration');
  const reservation = await registry.reserveProspectiveRenovateActivity(pr(activation.registrationId, activation.activatedAt));
  if (!reservation.ok) throw Error('No admission');
  const human = { ...observed.registration.human, ...patch.human };
  const executionContext = await createOperatorExecutionContext({ activityId: reservation.activityId,
    operatorId: 'dispatcher', artifactDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64),
    human, accessJwt: patch.accessJwt ?? observed.registration.accessJwt }, environment);
  const plan = { activityId: reservation.activityId, prospectiveAdmissionId: reservation.activityId,
    deadline: human.expiresAt * 1000, invocationJson: JSON.stringify({ repository: 'acme/updates' }),
    receipt: { selection }, executionContext };
  const host = { ...environment, OPERATOR_REGISTRY: { getByName: () => registry } } as unknown as Env;
  return { plan: plan as never, host };
}

describe('REQ-OPERATOR-061: durable prospective activation and admission', () => {
  it('REQ-OPERATOR-045/047/061: finite live transport grants exactly one prospective decision, not cached authority', () => fixture(async ({ registry, environment, selection }) => {
    const { plan, host } = await dispatcherPlan(registry, environment, selection);
    const responses = [Response.json({ id: 'a@example.test', email: 'a@example.test' })];
    const fetcher = globalThis.fetch;
    globalThis.fetch = async () => responses.shift() ?? new Response(null, { status: 503 });
    try {
      expect((await authorizeDispatcherPlan(plan, host)).admittedTarget).toMatchObject({ pullRequest: 1300, headSha: head });
      await expect(authorizeDispatcherPlan(plan, host)).rejects.toBeInstanceOf(DispatcherAuthorityUnavailable);
    } finally { globalThis.fetch = fetcher; }
  }));

  it.each(['subject', 'issuer', 'email', 'audiences', 'expiresAt', 'accessJwt'] as const)(
    'REQ-OPERATOR-045/061: a current registration cannot authorize a different execution %s', field => fixture(async ({ registry, environment, selection }) => {
      const patch = field === 'accessJwt' ? { accessJwt: 'different-live-token' } : { human: {
        [field]: field === 'audiences' ? ['foreign-audience'] : field === 'expiresAt'
          ? Math.floor(Date.now() / 1000) + 200 : field === 'issuer'
            ? 'https://foreign.cloudflareaccess.com' : 'foreign@example.test',
      } };
      const { plan, host } = await dispatcherPlan(registry, environment, selection, patch);
      await expect(authorizeDispatcherPlan(plan, host)).rejects.toThrow();
    }));

  it.each(['unavailable', 'transport-error', 'timeout', 'revoked', 'malformed'] as const)(
    'REQ-OPERATOR-045/047: prospective %s preserves unavailable versus denied', fault => fixture(async ({ registry, environment, selection, state }) => {
      const { plan, host } = await dispatcherPlan(registry, environment, selection);
      state.identityFault = fault;
      if (fault === 'unavailable' || fault === 'transport-error' || fault === 'timeout') {
        await expect(authorizeDispatcherPlan(plan, host)).rejects.toBeInstanceOf(DispatcherAuthorityUnavailable);
      } else {
        await expect(authorizeDispatcherPlan(plan, host)).rejects.not.toBeInstanceOf(DispatcherAuthorityUnavailable);
      }
    }));

  it('REQ-OPERATOR-047/061: revocation during local reads is observed before granting authority', () => fixture(async ({ registry, environment, selection, state }) => {
    const { plan, host } = await dispatcherPlan(registry, environment, selection);
    const get = environment.KV.get.bind(environment.KV);
    const read = vi.spyOn(environment.KV, 'get').mockImplementation(async (...args: Parameters<typeof get>) => {
      const value = await get(...args);
      state.revoked.add('a-jwt');
      return value;
    });
    try { await expect(authorizeDispatcherPlan(plan, host)).rejects.toThrow(); }
    finally { read.mockRestore(); }
  }));

  it.each(['role', 'revision', 'expiry', 'group-only'] as const)(
    'REQ-OPERATOR-047/061: %s changes during live verification cannot grant authority', fault => fixture(async ({ registry, environment, selection, state }) => {
      const { plan, host } = await dispatcherPlan(registry, environment, selection);
      const selected = selection as ManagementExecutionSelection;
      const fetcher = globalThis.fetch;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      globalThis.fetch = async (...args) => {
        const response = await fetcher(...args);
        if (fault === 'role') state.roles.set('a@example.test', 'user');
        if (fault === 'revision') selected.installation.revision++;
        if (fault === 'expiry') clock.mockReturnValue(Date.now() + 600_000);
        if (fault === 'group-only') selected.operator.invokers = { users: [], groups: [{ issuer: claims('a@example.test').issuer, id: 'cached-group' }] };
        return response;
      };
      try { await expect(authorizeDispatcherPlan(plan, host)).rejects.toThrow(); }
      finally { globalThis.fetch = fetcher; clock.mockRestore(); }
    }));

  it.each([
    ['unavailable', 'unavailable'], ['transport-error', 'unavailable'],
    ['revoked', 'denied'], ['forbidden', 'denied'], ['malformed', 'denied'],
  ] as const)('REQ-OPERATOR-061 AC3 /047 AC3: Access %s is %s observation, never effect authority', (fault, status) => fixture(async ({ registry, restart, state }) => {
    const activation = await enroll(registry, 'a', 3, undefined, 3600);
    if (!activation.ok) throw Error('Activation unavailable');
    const original = await registry.currentProspectiveRenovateRegistration(activation.registrationId);
    state.identityFault = fault;
    const restarted = restart();
    // Closed public observation contract; unavailable must not contain cached credentials/identity.
    expect(await restarted.observeProspectiveRenovateRegistration(activation.registrationId)).toEqual({ status });
    expect(await restarted.currentProspectiveRenovateRegistration(activation.registrationId)).toBeNull();
    expect((await restarted.reserveProspectiveRenovateActivity(pr(activation.registrationId, activation.activatedAt))).ok).toBe(false);
    expect(await restarted.readProspectiveRenovateAdmission('activity-1')).toBeNull();
    state.identityFault = 'valid';
    expect(await restart().observeProspectiveRenovateRegistration(activation.registrationId)).toEqual({ status: 'current', registration: original });
    expect(await restart().currentProspectiveRenovateRegistration(activation.registrationId)).toEqual(original);
    const elected = await registry.reserveProspectiveRenovateActivity(pr(activation.registrationId, activation.activatedAt));
    expect(elected).toMatchObject({ ok: true, activityId: 'activity-1' });
    expect(await registry.reserveProspectiveRenovateActivity(pr(activation.registrationId, activation.activatedAt,
      { activityId: 'must-not-replace' }))).toEqual(elected);
    expect(await registry.readProspectiveRenovateAdmission('must-not-replace')).toBeNull();
  }));

  it.each(['d1', 'kv'] as const)('REQ-OPERATOR-061 AC3: temporary %s observation failure retains no admission authority', dependency => fixture(async ({ registry, restart, environment }) => {
    const activation = await enroll(registry, 'a');
    if (!activation.ok) throw Error('Activation unavailable');
    const original = await registry.currentProspectiveRenovateRegistration(activation.registrationId);
    const outage = dependency === 'd1'
      ? vi.spyOn(environment.USAGE_DB, 'prepare').mockImplementation(() => { throw Error('Temporary database outage'); })
      : vi.spyOn(environment.KV, 'get').mockRejectedValue(Error('Temporary role lookup outage'));
    try {
      expect(await restart().observeProspectiveRenovateRegistration(activation.registrationId)).toEqual({ status: 'unavailable' });
      expect(await restart().currentProspectiveRenovateRegistration(activation.registrationId)).toBeNull();
      expect((await registry.reserveProspectiveRenovateActivity(pr(activation.registrationId, activation.activatedAt))).ok).toBe(false);
      expect(await registry.readProspectiveRenovateAdmission('activity-1')).toBeNull();
    } finally { outage.mockRestore(); }
    expect(await restart().currentProspectiveRenovateRegistration(activation.registrationId)).toEqual(original);
  }));

  it.each(['expired-during-outage', 'generation', 'stopped', 'disabled', 'config-revision', 'config-off', 'role'] as const)(
    'REQ-OPERATOR-061 AC3: %s denies future observation and protected admission', fault => fixture(async ({ registry, restart, state, selection }) => {
      const lifetime = 300, started = Date.now();
      const activation = await enroll(registry, 'a', 3, undefined, lifetime);
      if (!activation.ok) throw Error('Activation unavailable');
      const selected = selection as { installation: { revision: number; configurationJson: string } };
      const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
      try {
        if (fault === 'expired-during-outage') {
          state.identityFault = 'transport-error';
          clock.mockReturnValue(started + (lifetime + 1) * 1000);
        }
        if (fault === 'generation') state.sessions.set('asession01', { generation: 4, status: 'running' });
        if (fault === 'stopped') state.sessions.set('asession01', { generation: 3, status: 'stopped' });
        if (fault === 'disabled') state.enabled = false;
        if (fault === 'config-revision') selected.installation.revision++;
        if (fault === 'config-off') selected.installation.configurationJson = JSON.stringify({ renovate: {
          repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 900 } });
        if (fault === 'role') state.roles.set('a@example.test', 'user');
        expect(await restart().observeProspectiveRenovateRegistration(activation.registrationId)).toEqual({ status: 'denied' });
        expect(await restart().currentProspectiveRenovateRegistration(activation.registrationId)).toBeNull();
        expect((await registry.reserveProspectiveRenovateActivity(pr(activation.registrationId, activation.activatedAt))).ok).toBe(false);
        expect(await registry.readProspectiveRenovateAdmission('activity-1')).toBeNull();
      } finally { clock.mockRestore(); }
    }));

  it.each(['revoked', 'unavailable', 'malformed', 'transport-error'] as const)(
    'REQ-OPERATOR-047: prospective Registry authority with %s live identity denies email-granted reservations without retiring verified no-group registration', fault => fixture(async ({ registry, restart, state }) => {
      const enrolled = await enroll(registry, 'a');
      if (!enrolled.ok) throw Error('Activation unavailable');
      const before = await registry.currentProspectiveRenovateRegistration(enrolled.registrationId);
      expect(before).toMatchObject({ registrationId: enrolled.registrationId, human: { email: 'a@example.test', groups: [] } });
      state.identityFault = fault;
      expect(await restart().currentProspectiveRenovateRegistration(enrolled.registrationId)).toBeNull();
      expect(await registry.reserveProspectiveRenovateActivity(pr(enrolled.registrationId, enrolled.activatedAt)))
        .toEqual({ ok: false, reason: 'no-current-admin' });
      expect(await registry.readProspectiveRenovateAdmission('activity-1')).toBeNull();
      state.identityFault = 'valid';
      expect(await restart().currentProspectiveRenovateRegistration(enrolled.registrationId)).toEqual(before);
      expect(await registry.reserveProspectiveRenovateActivity(pr(enrolled.registrationId, enrolled.activatedAt)))
        .toMatchObject({ ok: true, activityId: 'activity-1', actor: { registrationId: enrolled.registrationId } });
    }));

  it.each(['old-intent', 'future-intent', 'foreign-package', 'malformed-manifest'])('REQ-OPERATOR-061: unsupported %s cannot activate a prospective current-package registration or retain its cutoff', fault => fixture(async ({ registry, selection }) => {
    const manifest = { id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion: '3' };
    if (fault === 'old-intent') manifest.intentVersion = '2';
    if (fault === 'future-intent') manifest.intentVersion = '5';
    if (fault === 'foreign-package') manifest.id = 'foreign-dispatcher';
    const selected = selection as { manifestJson: string };
    selected.manifestJson = fault === 'malformed-manifest' ? '{' : JSON.stringify(manifest);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(await enroll(registry, 'a')).toMatchObject({ ok: false });
      selected.manifestJson = JSON.stringify({ id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion: '3' });
      clock.mockReturnValue(now + 1_000);
      const supported = await enroll(registry, 'a');
      expect(supported).toMatchObject({ ok: true, activatedAt: new Date(now + 1_000).toISOString() });
      if (!supported.ok) throw Error('Supported activation unavailable');
      expect(await registry.currentProspectiveRenovateRegistration(supported.registrationId)).not.toBeNull();
      expect(await registry.reserveProspectiveRenovateActivity(pr(supported.registrationId, supported.activatedAt)))
        .toMatchObject({ ok: true, activityId: 'activity-1' });
    } finally { clock.mockRestore(); }
  }));
  it('takes the first server cutoff, never lets a later activation move it, and excludes old and equal PR timestamps', () => fixture(async ({ registry }) => {
    const first = await enroll(registry, 'a');
    expect(first).toMatchObject({ ok: true, activatedAt: expect.any(String), registrationId: expect.any(String) });
    if (!first.ok) throw Error('Activation unavailable');
    const next = await enroll(registry, 'z');
    expect(next).toMatchObject({ ok: true, activatedAt: first.activatedAt });
    for (const createdAt of [first.activatedAt, new Date(Date.parse(first.activatedAt) - 1).toISOString()]) {
      expect((await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt,
        { createdAt }))).ok).toBe(false);
    }
    expect(await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt)))
      .toMatchObject({ ok: true, activityId: 'activity-1' });
    expect((await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt,
      { pullRequest: 1301 }))).ok).toBe(false);
    expect(await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt,
      { pullRequest: 1301, activityId: 'activity-2' }))).toMatchObject({ ok: true, activityId: 'activity-2' });
  }));

  it('atomically elects one current administrator across competing reservations, reconstructed readers and lost responses', () => fixture(async ({ registry, restart, state }) => {
    const z = await enroll(registry, 'z');
    const a = await enroll(registry, 'a');
    if (!a.ok || !z.ok) throw Error('Activation unavailable');
    const input = pr(z.registrationId, a.activatedAt);
    const outcomes = await Promise.all([registry.reserveProspectiveRenovateActivity(input),
      registry.reserveProspectiveRenovateActivity({ ...input, registrationId: a.registrationId,
        activityId: 'competing-activity' })]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    const first = outcomes[0];
    expect(first).toMatchObject({ ok: true, actor: { registrationId: a.registrationId,
      sessionId: 'asession01', sessionGeneration: 3 } });
    expect(await restart().reserveProspectiveRenovateActivity({ ...input, activityId: 'replacement' })).toEqual(first);
    expect(await restart().readProspectiveRenovateAdmission(first.ok ? first.activityId : 'none'))
      .toMatchObject({ activityId: first.ok ? first.activityId : 'none',
        actor: { registrationId: a.registrationId } });
    state.sessions.set('asession01', { generation: 4, status: 'running' });
    expect(await registry.currentProspectiveRenovateRegistration(a.registrationId)).toBeNull();
    // Readback remains stable but cannot transfer its original actor's right to start or publish.
    expect(await registry.reserveProspectiveRenovateActivity({ ...input, activityId: 'another' })).toEqual(first);
    expect(await registry.currentProspectiveRenovateRegistration(a.registrationId)).toBeNull();
    expect(await registry.reserveProspectiveRenovateActivity({ ...input, head: newerHead,
      activityId: 'activity-new-head' })).toMatchObject({ ok: true, activityId: 'activity-new-head',
      actor: { registrationId: z.registrationId } });
  }));

  it('keeps an uncertain Activity admission on its one reserved identity without a replacement execution', () => fixture(async ({ registry, restart, native, environment, selection }) => {
    const registration = await enroll(registry, 'a');
    if (!registration.ok) throw Error('Activation unavailable');
    const observed = pr(registration.registrationId, registration.activatedAt);
    const reserved = await registry.reserveProspectiveRenovateActivity(observed);
    if (!reserved.ok) throw Error('Reservation unavailable');
    const human = claims('a@example.test');
    const invocationJson = JSON.stringify({ repository: 'acme/updates', pullRequest: observed.pullRequest });
    const token = 's'.repeat(43);
    const verifier = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const context = await createOperatorExecutionContext({ activityId: reserved.activityId,
      operatorId: 'dispatcher', artifactDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64),
      human, accessJwt: 'a-jwt' }, environment);
    let accepted = false;
    const activity = new OperatorActivity(native, { ...environment,
      OPERATOR_ACTIVITY: { idFromName: () => native.id }, OPERATOR_REGISTRY: { getByName: () => ({
      readProspectiveRenovateAdmission: (id: string) => registry.readProspectiveRenovateAdmission(id),
      admitManagement: async () => { accepted = true; throw new Error('Registry admission response lost'); },
      resolveManagementExecution: async () => ({ ok: true, value: selection }),
      upsertOwnedActivity: async () => {},
    }) } } as unknown as Env);
    const intent = { installationId: 'dispatcher-install', activityId: reserved.activityId,
      operatorId: 'dispatcher', intentDigest: await createOperatorIntentDigest('dispatcher', reserved.activityId, invocationJson),
      expectedRevision: 1, expectedInstallationRevision: 1, expectedControlsRevision: 1,
      deadline: human.expiresAt * 1000, startExpiresAt: human.expiresAt * 1000, startVerifier: verifier };
    expect(await activity.prepareAuthorized(intent, context, invocationJson, undefined, reserved.activityId))
      .toMatchObject({ ok: true });
    expect(await native.storage.get('prospective-admission')).toBe(reserved.activityId);
    expect(await activity.start(token)).toMatchObject({ ok: false, reason: 'admission-uncertain' });
    expect(accepted).toBe(true);
    expect(await restart().reserveProspectiveRenovateActivity({ ...observed,
      activityId: 'replacement-id' })).toMatchObject({ ok: true, activityId: reserved.activityId,
      actor: reserved.actor });
    expect(await activity.getRuntimePlan()).toBeNull();
    expect(await activity.start(token)).toMatchObject({ ok: false });
    expect(await activity.getRuntimePlan()).toBeNull();
  }));

  it('fences Activity-bound read/inference authority of an admitted prospective Dispatcher when its admin session ends', () => fixture(async ({ registry, state, native, environment, selection }) => {
    const activation = await enroll(registry, 'a');
    if (!activation.ok) throw Error('Activation unavailable');
    const reservation = await registry.reserveProspectiveRenovateActivity(pr(activation.registrationId, activation.activatedAt));
    if (!reservation.ok) throw Error('Admission unavailable');
    const current = await registry.observeProspectiveRenovateRegistration(activation.registrationId);
    if (current.status !== 'current') throw Error('Registration unavailable');
    const human = current.registration.human;
    const context = await createOperatorExecutionContext({ activityId: reservation.activityId,
      operatorId: 'dispatcher', artifactDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64),
      human, accessJwt: 'a-jwt' }, environment);
    const selected = selection as { installation: { id: string } };
    const plan = { activityId: reservation.activityId, prospectiveAdmissionId: reservation.activityId,
      deadline: human.expiresAt * 1000, invocationJson: JSON.stringify({ repository: 'acme/updates' }),
      receipt: { selection: { ...selection as object }, installationId: selected.installation.id }, executionContext: context };
    const host = { ...environment, OPERATOR_REGISTRY: { getByName: () => registry } } as unknown as Env;
    await expect(authorizeDispatcherPlan(plan as never, host)).resolves.toBeDefined();
    const activity = new OperatorActivity(native, host);
    const intent = { activityId: reservation.activityId, operatorId: 'dispatcher',
      installationId: 'dispatcher-install', deadline: plan.deadline, intentDigest: 'd'.repeat(64) };
    await native.storage.put('admission', { intent, phase: 'queued', receipt: { ...intent, selection },
      executionContext: context, invocationJson: plan.invocationJson, drive: { generation: 1, status: 'running' } });
    await native.storage.put('prospective-admission', reservation.activityId);
    await native.storage.put('dispatcher:lease', { generation: 1, artifactDigest: context.artifactDigest,
      inputDigest: intent.intentDigest, expiresAt: plan.deadline, submissionId: 'submission-1', status: 'running' });
    expect(await activity.dispatcherGenerationCurrent(1)).toBe(true);
    state.sessions.set('asession01', { generation: 3, status: 'stopping' });
    expect(await activity.dispatcherGenerationCurrent(1)).toBe(false);
    const read = new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'read-1', resource: 'pull-request' }) });
    expect((await activity.dispatcherOperation(1, read)).status).toBe(403);
    state.sessions.set('asession01', { generation: 3, status: 'running' });
    state.revoked.add('a-jwt');
    expect(await activity.dispatcherGenerationCurrent(1)).toBe(false);
    const inference = new Request('https://operator.internal/v1/dispatcher/inference', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'inference-1', input: { messages: [{ role: 'user', content: 'Hi' }] } }) });
    expect((await activity.dispatcherOperation(1, inference)).status).toBe(403);
  }));

  it('fences stopped, expired, logged-out, revoked, disabled and foreign registrations before new PR admission', () => fixture(async ({ registry, state }) => {
    const first = await enroll(registry, 'a');
    if (!first.ok) throw Error('Activation unavailable');
    state.sessions.set('asession01', { generation: 3, status: 'stopping' });
    expect(await registry.currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
    expect((await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt))).ok).toBe(false);
    state.sessions.set('asession01', { generation: 3, status: 'running' });
    state.revoked.add('a-jwt');
    expect(await registry.currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
    state.revoked.clear();
    state.roles.set('a@example.test', 'user');
    expect(await registry.currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
    state.roles.set('a@example.test', 'admin');
    state.enabled = false;
    expect(await registry.currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
    state.enabled = true;
    const clock = vi.spyOn(Date, 'now').mockReturnValue((claims('a@example.test').expiresAt + 1) * 1000);
    try { expect(await registry.currentProspectiveRenovateRegistration(first.registrationId)).toBeNull(); }
    finally { clock.mockRestore(); }
    expect((await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt,
      { repositoryId: 1 }))).ok).toBe(false);
  }));
});


describe('REQ-OPERATOR-061: configured Renovate run settings', () => {
  it('authenticates configured repository metadata with one fixed parent GET before activation and retains the target and revisions through scheduled delivery', () => fixture(async ({ registry, restart, selection, environment }) => {
    const selected = selection as { controlsRevision: number; installation: { revision: number }; operator: { revision: number } };
    selected.controlsRevision = 13;
    selected.installation.revision = 7;
    selected.operator.revision = 11;
    const authority = { human: claims('a@example.test'), accessJwt: 'a-jwt' };
    const human = vi.spyOn(access, 'requireOperatorHumanContext').mockResolvedValue(authority as never);
    const authenticated = vi.spyOn(access, 'authenticateRequest').mockResolvedValue({
      user: { email: 'a@example.test', role: 'admin' }, bucketName: 'owner-bucket',
    } as never);
    type ScheduledGeneration = { registrationId: string; installationId: string; bucket: string;
      sessionId: string; sessionGeneration: number };
    let scheduled: ScheduledGeneration | null = null;
    const session = { armRenovateScan: async (generation: ScheduledGeneration) => {
      scheduled = structuredClone(generation);
      return { ok: true };
    } };
    const reads: Array<{ url: string; method: string; redirect: Request['redirect'] }> = [];
    let createdAt = '';
    const exports = { GitHubInterceptor: () => ({ fetch: async (request: Request) => {
      reads.push({ url: request.url, method: request.method, redirect: request.redirect });
      const url = new URL(request.url);
      if (url.pathname === '/repos/acme/updates') return Response.json({
        id: repoId, full_name: 'acme/updates', default_branch: 'trunk' });
      if (url.pathname !== '/repos/acme/updates/pulls') throw Error('Unexpected protected path');
      return Response.json([{ number: 1300, state: 'open', draft: false, created_at: createdAt,
        user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' }, head: { sha: head },
        base: { ref: 'trunk', sha: newerHead, repo: { id: repoId, full_name: 'acme/updates' } } }]);
    }, connect: () => { throw Error('Unexpected socket'); } }) };
    const bindings = { ...environment, ENTERPRISE_MODE: 'active',
      OPERATOR_REGISTRY: { getByName: () => registry }, OPERATOR_ACTIVITY: {},
      CONTAINER: { idFromName: (name: string) => name, get: () => session, getByName: () => session },
    } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>().route('/api/operator-activities', activityRoutes);
    try {
      const response = await app.fetch(new Request('https://owner.example/api/operator-activities/renovate/activation', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest',
          'cf-access-authenticated-user-email': 'a@example.test' },
        body: JSON.stringify({ installationId: 'dispatcher-install', sessionId: 'asession01', sessionGeneration: 3 }),
      }), bindings, { exports, waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext);
      expect(response.status).toBe(202);
      const result = await response.json() as { activatedAt: string; repositoryId: number };
      expect(result).toMatchObject({ repositoryId: repoId, activatedAt: expect.any(String) });
      // Intentional parent HTTP contract, coupled to the real persisted registration below.
      expect(reads).toEqual([{ url: 'https://api.github.com/repos/acme/updates', method: 'GET', redirect: 'manual' }]);
      const generation = scheduled as ScheduledGeneration | null;
      expect(generation).toMatchObject({ installationId: 'dispatcher-install', bucket: 'owner-bucket',
        sessionId: 'asession01', sessionGeneration: 3 });
      if (!generation) throw Error('No scheduled generation');
      const registered = await restart().currentProspectiveRenovateRegistration(generation.registrationId);
      expect(registered).toMatchObject({ repository: 'acme/updates', repositoryId: repoId, baseBranch: 'trunk',
        controlsRevision: 13, installationRevision: 7, operatorRevision: 11,
        releaseId: 'release', bundleDigest: 'c'.repeat(64), repetitionIntervalSeconds: 900,
        activatedAt: result.activatedAt, bucket: generation.bucket, sessionId: generation.sessionId,
        sessionGeneration: generation.sessionGeneration });
      createdAt = new Date(Date.parse(result.activatedAt) + 1).toISOString();
      const candidates = await listProspectiveRenovatePrs({ env: bindings, exports,
        registration: registered as CurrentProspectiveRegistration,
        current: async () => await restart().currentProspectiveRenovateRegistration(generation.registrationId) !== null });
      expect(candidates).toMatchObject([{ repository: 'acme/updates', repositoryId: repoId,
        baseBranch: 'trunk', pullRequest: 1300, head, createdAt }]);
      const reservation = await registry.reserveProspectiveRenovateActivity({ registrationId: generation.registrationId,
        ...candidates[0], activityId: 'handoff-activity' });
      expect(reservation).toMatchObject({ ok: true, activityId: 'handoff-activity' });
      expect(await restart().readProspectiveRenovateAdmission('handoff-activity')).toMatchObject({
        repository: 'acme/updates', repositoryId: repoId, baseBranch: 'trunk',
        actor: { registrationId: generation.registrationId, sessionId: generation.sessionId,
          sessionGeneration: generation.sessionGeneration },
      });
    } finally { human.mockRestore(); authenticated.mockRestore(); }
  }));
  it.each([{}, { renovate: { repository: 'acme/updates' } },
    { renovate: { repository: 'acme/updates', automaticRuns: false } },
    { renovate: { automaticRuns: true, repetitionIntervalSeconds: 900 } }])
    ('denies activation without an explicit repository and automatic opt-in %j', configuration => fixture(async ({ registry, selection }) => {
      (selection as { installation: { configurationJson: string } }).installation.configurationJson = JSON.stringify(configuration);
      expect(await enroll(registry, 'a')).toMatchObject({ ok: false });
    }));
  it('pins alternate authenticated identity and defaults the registered interval to 3600', () => fixture(async ({ registry, selection }) => {
    (selection as { installation: { configurationJson: string } }).installation.configurationJson = JSON.stringify({
      renovate: { repository: 'acme/updates', automaticRuns: true } });
    const activation = await enroll(registry, 'a');
    if (!activation.ok) throw Error('Configured activation unavailable');
    expect(await registry.currentProspectiveRenovateRegistration(activation.registrationId)).toMatchObject({
      repository: 'acme/updates', repositoryId: repoId, baseBranch: 'trunk', repetitionIntervalSeconds: 3600 });
    expect(await registry.reserveProspectiveRenovateActivity(pr(activation.registrationId, activation.activatedAt)))
      .toMatchObject({ ok: true });
    expect(await registry.readProspectiveRenovateAdmission('activity-1')).toMatchObject({
      repository: 'acme/updates', repositoryId: repoId, baseBranch: 'trunk', activatedAt: activation.activatedAt });
  }));
  it('configuration save and ordinary separate enable cannot refresh an old admitted generation', () => fixture(async ({ registry, restart, selection, state }) => {
    const first = await enroll(registry, 'a');
    if (!first.ok) throw Error('Activation unavailable');
    const observed = pr(first.registrationId, first.activatedAt);
    const reserved = await registry.reserveProspectiveRenovateActivity(observed);
    expect(reserved).toMatchObject({ ok: true });
    const original = await registry.readProspectiveRenovateAdmission('activity-1');
    const selected = selection as { installation: { revision: number; configurationJson: string } };
    state.enabled = false;
    selected.installation.revision++;
    selected.installation.configurationJson = JSON.stringify({ renovate: {
      repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 7200 } });
    expect(await registry.currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
    state.enabled = true;
    expect(await restart().currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
    expect(await enroll(registry, 'a')).toMatchObject({ ok: false });
    selected.installation.revision++;
    selected.installation.configurationJson = JSON.stringify({ renovate: {
      repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 7200 } });
    const next = await enroll(registry, 'a');
    if (!next.ok) throw Error('Reactivation unavailable');
    expect(next.activatedAt).toBe(first.activatedAt);
    expect(next.registrationId).not.toBe(first.registrationId);
    expect(await restart().currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
    expect(await registry.readProspectiveRenovateAdmission('activity-1')).toEqual(original);
    expect(await registry.reserveProspectiveRenovateActivity({ ...observed, registrationId: next.registrationId,
      activityId: 'replacement' })).toEqual(reserved);
    expect(await registry.currentProspectiveRenovateRegistration(next.registrationId)).toMatchObject({ repetitionIntervalSeconds: 7200 });
  }));
  it('fences legacy automatic records without settings while leaving their admission readable', () => fixture(async ({ registry, native, selection }) => {
    const legacy = { activityId: 'legacy-activity', installationId: 'dispatcher-install', repositoryId: 973175879,
      pullRequest: 17, head, activatedAt: at, createdAt: at, ownerKey: 'a'.repeat(64), actor: { registrationId: 'legacy-scan' } };
    await native.storage.put('renovate-activity:legacy-activity', legacy);
    await native.storage.put('renovate-activation', { installationId: 'dispatcher-install', repositoryId: 973175879, activatedAt: at });
    (selection as { installation: { configurationJson: string } }).installation.configurationJson = '{}';
    expect(await enroll(registry, 'a')).toMatchObject({ ok: false });
    expect(await registry.readProspectiveRenovateAdmission('legacy-activity')).toEqual(legacy);
  }));
  it('each repository retains its first cutoff and returning to it retains same-head dedupe without replay', () => fixture(async ({ registry, restart, selection }) => {
    const first = await enroll(registry, 'a');
    if (!first.ok) throw Error('First activation unavailable');
    const observed = pr(first.registrationId, first.activatedAt);
    const reserved = await registry.reserveProspectiveRenovateActivity(observed);
    expect(reserved).toMatchObject({ ok: true });
    const selected = selection as { installation: { revision: number; configurationJson: string } };
    const later = Date.now() + 2000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      selected.installation.revision++;
      selected.installation.configurationJson = JSON.stringify({ renovate: { repository: 'other/service', automaticRuns: true, repetitionIntervalSeconds: 7200 } });
      const other = await enroll(registry, 'a', 3, { repository: 'other/service', repositoryId: 565656, baseBranch: 'develop' });
      expect(other).toMatchObject({ ok: true, activatedAt: new Date(later).toISOString() });
      if (!other.ok) throw Error('Other activation unavailable');
      expect(await registry.reserveProspectiveRenovateActivity(pr(other.registrationId, other.activatedAt,
        { repository: 'other/service', repositoryId: 565656, baseBranch: 'develop', activityId: 'other-activity' })))
        .toMatchObject({ ok: true, activityId: 'other-activity' });
      expect(await registry.currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
      selected.installation.revision++;
      selected.installation.configurationJson = JSON.stringify({ renovate: { repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 900 } });
      clock.mockReturnValue(later + 2000);
      const returning = await enroll(registry, 'a');
      if (!returning.ok) throw Error('Returning activation unavailable');
      expect(returning.activatedAt).toBe(first.activatedAt);
      expect(await restart().reserveProspectiveRenovateActivity({ ...observed, registrationId: returning.registrationId,
        activityId: 'replacement' })).toEqual(reserved);
      expect(await registry.reserveProspectiveRenovateActivity({ ...observed, registrationId: returning.registrationId,
        head: newerHead, activityId: 'new-head' })).toMatchObject({ ok: true, activityId: 'new-head' });
      selected.installation.revision++;
      expect(await enroll(registry, 'a', 3, { repository: 'acme/updates', repositoryId: 1, baseBranch: 'trunk' }))
        .toMatchObject({ ok: false });
    } finally { clock.mockRestore(); }
  }));
  it('a settings change during asynchronous election cannot create a stale admission', () => fixture(async ({ registry, selection }) => {
    const activation = await enroll(registry, 'a');
    if (!activation.ok) throw Error('Activation unavailable');
    const selected = selection as { installation: { revision: number } };
    const original = globalThis.fetch;
    globalThis.fetch = async (request, init) => { const result = await original(request, init); selected.installation.revision++; return result; };
    try {
      expect(await registry.reserveProspectiveRenovateActivity(pr(activation.registrationId, activation.activatedAt)))
        .toMatchObject({ ok: false });
      expect(await registry.readProspectiveRenovateAdmission('activity-1')).toBeNull();
    } finally { globalThis.fetch = original; }
  }));

});

function terminalProof(activityId: string, createdAt: string, terminalAt: number): ProspectiveRenovateRetryProof {
  return { activityId, generation: 1, repository: 'acme/updates', repositoryId: repoId, baseBranch: 'trunk',
    pullRequest: 1300, head, artifactDigest: 'c'.repeat(64), createdAt, terminalAt,
    collected: true, settled: true, sdkSubmissionId: 'original-sid', disposition: 'DEFERRED' };
}

describe('REQ-OPERATOR-061 AC2/6/7: terminal-proof configured retry', () => {
  // These fresh actors remain authorized across the 900-second due boundary.
  // Existing enrollment/expiry cases retain their original 300-second lifetime.
  const enrollRetry = (registry: Prospective, user: 'a' | 'z') => enroll(registry, user, undefined, undefined, 7200);
  it.each(['3', '4'])('admits the existing first-party intent%s contract', intentVersion => fixture(async ({ registry, selection }) => {
    (selection as { manifestJson: string }).manifestJson = JSON.stringify({ id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion });
    expect(await enrollRetry(registry, 'a')).toMatchObject({ ok: true });
  }));
  it.each(['EXECUTION_FAILED', 'DEFERRED'] as const)('elects one fresh unchanged-head %s attempt exactly at the configured due boundary and preserves original history', disposition => fixture(async ({ registry, restart, proofs }) => {
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const a = await enrollRetry(registry, 'a'), z = await enrollRetry(registry, 'z');
      if (!a.ok || !z.ok) throw Error('Activation unavailable');
      const observed = pr(a.registrationId, a.activatedAt);
      const original = await registry.reserveProspectiveRenovateActivity(observed);
      const journal = await registry.readProspectiveRenovateAdmission('activity-1');
      proofs.set('activity-1', { ...terminalProof('activity-1', observed.createdAt, now + 1000), disposition });
      clock.mockReturnValue(now + 900_000 - 1);
      expect(await registry.reserveProspectiveRenovateActivity({ ...observed, activityId: 'not-due' })).toEqual(original);
      expect(await registry.retainedProspectiveRenovateRetryTargets(a.registrationId)).toEqual([]);
      clock.mockReturnValue(now + 900_000);
      expect(await registry.retainedProspectiveRenovateRetryTargets(a.registrationId)).toEqual([{
        repositoryId: repoId, pullRequest: 1300, head, createdAt: observed.createdAt }]);
      const outcomes = await Promise.all([registry.reserveProspectiveRenovateActivity({ ...observed, activityId: 'retry-a' }),
        registry.reserveProspectiveRenovateActivity({ ...observed, registrationId: z.registrationId, activityId: 'retry-z' })]);
      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(outcomes[0]).toMatchObject({ ok: true, actor: { registrationId: a.registrationId } });
      if (!outcomes[0].ok) throw Error('Retry unavailable');
      expect(outcomes[0].activityId).not.toBe('activity-1');
      expect(await restart().readProspectiveRenovateAdmission(outcomes[0].activityId)).toMatchObject({
        attempt: 2, previousActivityId: 'activity-1', admittedAt: now + 900_000, head });
      expect(await restart().readProspectiveRenovateAdmission('activity-1')).toEqual(journal);
      // A lost preparation/start response supplies no terminal proof for the winner.
      clock.mockReturnValue(now + 1_800_000);
      expect(await restart().reserveProspectiveRenovateActivity({ ...observed, activityId: 'lost-ack-replacement' })).toEqual(outcomes[0]);
      expect(await restart().readProspectiveRenovateAdmission('lost-ack-replacement')).toBeNull();
    } finally { clock.mockRestore(); }
  }));
  it('does not borrow refreshed session or installation authority for a due retry', () => fixture(async ({ registry, proofs, state, selection }) => {
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const a = await enrollRetry(registry, 'a'); if (!a.ok) throw Error('Activation unavailable');
      const observed = pr(a.registrationId, a.activatedAt);
      await registry.reserveProspectiveRenovateActivity(observed);
      const original = await registry.readProspectiveRenovateAdmission('activity-1');
      proofs.set('activity-1', terminalProof('activity-1', observed.createdAt, now + 1000));
      clock.mockReturnValue(now + 900_000);
      state.sessions.set('asession01', { generation: 4, status: 'running' });
      expect(await registry.reserveProspectiveRenovateActivity({ ...observed, activityId: 'stale-retry' }))
        .toEqual({ ok: false, reason: 'no-current-admin' });
      state.sessions.set('asession01', { generation: 3, status: 'running' });
      (selection as { installation: { revision: number } }).installation.revision++;
      expect(await registry.reserveProspectiveRenovateActivity({ ...observed, activityId: 'stale-retry' }))
        .toEqual({ ok: false, reason: 'no-current-admin' });
      expect(await registry.readProspectiveRenovateAdmission('activity-1')).toEqual(original);
      expect(await registry.readProspectiveRenovateAdmission('stale-retry')).toBeNull();
    } finally { clock.mockRestore(); }
  }));
  it('REQ-OPERATOR-061 AC2/6: preserves historical evidence but never renews a pre-cutoff target, even with verified failure proof', () => fixture(async ({ registry, proofs, native }) => {
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const a = await enrollRetry(registry, 'a'); if (!a.ok) throw Error('Activation unavailable');
      const observed = pr(a.registrationId, a.activatedAt);
      await registry.reserveProspectiveRenovateActivity(observed);
      const oldCreatedAt = new Date(now - 1000).toISOString();
      const admission = { ...await registry.readProspectiveRenovateAdmission('activity-1') as object, createdAt: oldCreatedAt };
      // Retained historical admission fixture; ordinary scans cannot create this pre-cutoff record.
      await native.storage.put('renovate-activity:activity-1', admission);
      await native.storage.put(`renovate-admission:${repoId}:1300:${head}`, admission);
      proofs.set('activity-1', terminalProof('activity-1', oldCreatedAt, now + 1000));
      clock.mockReturnValue(now + 900_000);
      expect(await registry.retainedProspectiveRenovateRetryTargets(a.registrationId)).toEqual([]);
      expect(await registry.reserveProspectiveRenovateActivity({ ...observed, createdAt: oldCreatedAt, head: newerHead, activityId: 'changed-old-head' }))
        .toMatchObject({ ok: false, reason: 'pre-activation' });
      expect(await registry.reserveProspectiveRenovateActivity({ ...observed, createdAt: oldCreatedAt, pullRequest: 1301, activityId: 'unretained-old-pr' }))
        .toMatchObject({ ok: false, reason: 'pre-activation' });
      expect(await registry.reserveProspectiveRenovateActivity({ ...observed, createdAt: oldCreatedAt, activityId: 'retained-retry' }))
        .toMatchObject({ ok: false, reason: 'pre-activation' });
      expect(await registry.readProspectiveRenovateAdmission('retained-retry')).toBeNull();
      expect(await registry.currentProspectiveRenovateRegistration(a.registrationId)).toMatchObject({ activatedAt: a.activatedAt });
      expect(await registry.readProspectiveRenovateAdmission('activity-1')).toEqual(admission);
    } finally { clock.mockRestore(); }
  }));
  it.each(['absent', 'unknown', 'uncollected', 'unsettled', 'foreign-activity', 'foreign-repository', 'foreign-head', 'foreign-package', 'success', 'future-terminal', 'unavailable'])
    ('refuses %s proof without replacing or refreshing the original actor', fault => fixture(async ({ registry, restart, proofs, environment }) => {
      const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const a = await enrollRetry(registry, 'a'); if (!a.ok) throw Error('Activation unavailable');
        const observed = pr(a.registrationId, a.activatedAt);
        const original = await registry.reserveProspectiveRenovateActivity(observed);
        const proof: Record<string, unknown> = { ...terminalProof('activity-1', observed.createdAt, now + 1000) };
        if (fault === 'unknown') proof.disposition = 'UNKNOWN';
        if (fault === 'uncollected') proof.collected = false;
        if (fault === 'unsettled') proof.settled = false;
        if (fault === 'foreign-activity') proof.activityId = 'other-activity';
        if (fault === 'foreign-repository') proof.repositoryId = 1;
        if (fault === 'foreign-head') proof.head = newerHead;
        if (fault === 'foreign-package') proof.artifactDigest = 'd'.repeat(64);
        if (fault === 'success') proof.disposition = 'MERGED';
        if (fault === 'future-terminal') proof.terminalAt = now + 1_800_001;
        if (fault !== 'absent') proofs.set('activity-1', proof);
        if (fault === 'unavailable') (environment as unknown as { OPERATOR_ACTIVITY: unknown }).OPERATOR_ACTIVITY = {
          getByName: () => ({ readProspectiveRenovateRetryProof: async () => { throw Error('Unavailable'); } }) };
        clock.mockReturnValue(now + 900_000);
        expect(await restart().reserveProspectiveRenovateActivity({ ...observed, activityId: 'replacement' })).toEqual(original);
        expect(await restart().readProspectiveRenovateAdmission('replacement')).toBeNull();
        expect(await registry.retainedProspectiveRenovateRetryTargets(a.registrationId)).toEqual([]);
      } finally { clock.mockRestore(); }
    }));
});



const activateInstallation = (registry: Prospective, human = claims('a@example.test', 3600)) => registry.activateProspectiveRenovate({
  installationId: 'dispatcher-install', scope: 'installation', bucket: 'owner-bucket', sessionId: '', sessionGeneration: 0,
  human, accessJwt: 'a-jwt', repository: { repository: 'acme/updates', repositoryId: repoId, baseBranch: 'trunk' } });
// Migration contract: historical persisted installation records have no delegation field.
async function seedLegacyInstallation(native: DurableObjectState, activation: Registration) {
  if (!activation.ok) throw Error('No activation');
  const key = `renovate-registration:${activation.registrationId}`;
  const { delegation: _newOnly, ...legacy } = (await native.storage.get<Record<string, unknown>>(key))!;
  await native.storage.put(key, legacy);
}

describe('REQ-OPERATOR-045 AC3 /047 AC3/7 /061 AC1/3: bounded installation delegation', () => {
  it.each(['subject', 'issuer', 'email', 'audiences', 'issuedAt', 'expiresAt', 'accessJwt'] as const)(
    'delegated original authority cannot be replaced or extended by execution %s', field => fixture(async ({ registry, environment, selection, state }) => {
      const patch = field === 'accessJwt' ? { accessJwt: 'reauthenticated-token' } : { human: {
        [field]: field === 'audiences' ? ['foreign-audience'] : field === 'expiresAt'
          ? Math.floor(Date.now() / 1000) + 7200 : field === 'issuedAt' ? Math.floor(Date.now() / 1000)
            : field === 'issuer' ? 'https://foreign.cloudflareaccess.com' : 'foreign@example.test',
      } };
      const { plan, host } = await dispatcherPlan(registry, environment, selection, { delegated: true, ...patch });
      state.identityFault = 'unavailable';
      await expect(authorizeDispatcherPlan(plan, host)).rejects.toThrow();
    }));

  it.each(['unavailable', 'transport-error', 'timeout', 'revoked', 'forbidden', 'malformed'] as const)(
    'fresh Activate cannot delegate with %s identity evidence', fault => fixture(async ({ registry, native, state }) => {
      state.identityFault = fault;
      expect(await activateInstallation(registry)).toMatchObject({ ok: false });
      expect(await native.storage.getAlarm()).toBeNull();
      expect(await native.storage.list({ prefix: 'renovate-registration:' })).toEqual(new Map());
    }));
  it('seals final verified ACL membership and captures separate configured routing labels without live external dependence', () => fixture(async ({ registry, restart, native, environment, selection, state }) => {
    const selected = selection as ManagementExecutionSelection;
    selected.operator.invokers = { users: [], groups: [{ issuer: claims('a@example.test').issuer, id: 'stable-id' }] };
    await environment.KV.put('setup:enterprise_access_group', 'Operators,stable-id,a@example.test,missing');
    const fetcher = globalThis.fetch;
    // Wire budget is exactly issuance's two independently validated identity responses.
    const responses = [1, 2].map(() => Response.json({ id: 'a@example.test', email: 'a@example.test',
      groups: [{ id: 'stable-id', name: 'Operators' }, { email: 'a@example.test' }] }));
    globalThis.fetch = async () => responses.shift() ?? new Response(null, { status: 503 });
    try {
      const consent = claims('a@example.test', 3600);
      const first = await activateInstallation(registry, consent); if (!first.ok) throw Error('No activation');
      const key = `renovate-registration:${first.registrationId}`;
      const record = (await native.storage.get<Record<string, unknown>>(key))!;
      const sealed = await openOperatorExecutionAccess(record.context as never, environment);
      expect(sealed.human.groups).toEqual(['stable-id']);
      for (const fault of ['unavailable', 'revoked', 'valid'] as const) {
        state.identityFault = fault;
        expect(await restart().observeProspectiveRenovateRegistration(first.registrationId)).toMatchObject({ status: 'current', registration: {
          scope: 'installation', delegation: { version: 1, routingGroups: ['Operators', 'stable-id', 'a@example.test'] },
          human: { groups: ['stable-id'], expiresAt: consent.expiresAt } } });
      }
      expect((await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt))).ok).toBe(true);
      selected.operator.invokers = { users: [], groups: [] };
      expect(await restart().currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
    } finally { globalThis.fetch = fetcher; }
  }));
  it.each(['role', 'revision', 'invoker', 'expiry'] as const)(
    'final issuance %s race cannot seal authority', fault => fixture(async ({ registry, native, selection, state }) => {
      const fetcher = globalThis.fetch;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      globalThis.fetch = async (...args) => {
        const response = await fetcher(...args);
        if (fault === 'role') state.roles.set('a@example.test', 'user');
        if (fault === 'revision') (selection as ManagementExecutionSelection).installation.revision++;
        if (fault === 'invoker') (selection as ManagementExecutionSelection).operator.invokers = { users: [], groups: [] };
        if (fault === 'expiry') clock.mockReturnValue(Date.now() + 3601_000);
        return response;
      };
      try {
        expect(await activateInstallation(registry)).toMatchObject({ ok: false });
        expect(await native.storage.list({ prefix: 'renovate-registration:' })).toEqual(new Map());
      } finally { clock.mockRestore(); globalThis.fetch = fetcher; }
    }));
  it.each([{ version: 2, routingGroups: [] }, { version: 1 }, null, { version: 1, routingGroups: [4] }])(
    'invalid persisted marker/snapshot never downgrades to live authority: %j', delegation => fixture(async ({ registry, restart, native }) => {
      const activation = await activateInstallation(registry); if (!activation.ok) throw Error('No activation');
      const key = `renovate-registration:${activation.registrationId}`;
      await native.storage.put(key, { ...await native.storage.get<Record<string, unknown>>(key), delegation });
      expect(await restart().observeProspectiveRenovateRegistration(activation.registrationId)).toEqual({ status: 'denied' });
      expect((await registry.reserveProspectiveRenovateActivity(pr(activation.registrationId, activation.activatedAt))).ok).toBe(false);
    }));
  it('legacy persisted installation keeps live identity checks and requires fresh explicit consent to delegate', () => fixture(async ({ registry, restart, native, state }) => {
    const consent = claims('a@example.test', 3600);
    const first = await activateInstallation(registry, consent); if (!first.ok) throw Error('No activation');
    await seedLegacyInstallation(native, first);
    state.identityFault = 'unavailable';
    expect(await restart().observeProspectiveRenovateRegistration(first.registrationId)).toEqual({ status: 'unavailable' });
    state.identityFault = 'valid';
    expect(await restart().currentProspectiveRenovateRegistration(first.registrationId)).toMatchObject({ human: { email: consent.email } });
    state.identityFault = 'revoked';
    expect(await restart().currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
  }));
  it('duplicate acknowledgement and reconstruction retain original expiry and immutable cutoff', () => fixture(async ({ registry, restart, native }) => {
    const consent = claims('a@example.test', 3600);
    const first = await activateInstallation(registry, consent); if (!first.ok) throw Error('No activation');
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 1000);
    try {
      expect(await activateInstallation(restart(), consent)).toEqual(first);
      expect(await restart().currentProspectiveRenovateRegistration(first.registrationId)).toMatchObject({ human: { expiresAt: consent.expiresAt } });
      clock.mockReturnValue(consent.expiresAt * 1000);
      expect(await restart().currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
      expect(await activateInstallation(registry, consent)).toMatchObject({ ok: false });
      expect(await registry.readProspectiveRenovateAdmission('activity-1')).toBeNull();
      expect(await native.storage.get('renovate-cutoff:dispatcher-install:424242')).toBe(first.activatedAt);
    } finally { clock.mockRestore(); }
  }));
});

describe('REQ-OPERATOR-063 AC1/5/6: one-round prospective admission diagnostic wire', () => {
  const message = 'Prospective Renovate admission boundary';
  type Entry = { message: string; data: Record<string, unknown> };
  // Intentional closed diagnostic wire contract, always paired below with real return/storage outcomes.
  const assertBoundaryWire = (entries: Entry[]) => {
    for (const { data } of entries.filter(entry => entry.message === message)) {
      expect(['activity-proof-rpc', 'registry-proof-storage', 'activity-bind-storage']).toContain(data.boundary);
      expect(['started', 'completed', 'failed']).toContain(data.outcome);
      expect(data.admissionDigest).toMatch(/^[a-f0-9]{64}$/);
      const completionField = data.boundary === 'activity-bind-storage' ? 'accepted' : 'proofPresent';
      expect(Object.keys(data).sort()).toEqual(['boundary', 'outcome', 'admissionDigest',
        ...(data.outcome === 'completed' ? [completionField] : []),
        ...(data.outcome === 'failed' ? ['error'] : []),
      ].sort());
      if (data.outcome === 'completed') expect(typeof data[completionField]).toBe('boolean');
    }
  };

  async function preparation(environment: Env, activityId: string) {
    const human = claims('a@example.test');
    const invocationJson = JSON.stringify({ repository: 'acme/updates' });
    const executionContext = await createOperatorExecutionContext({ activityId, operatorId: 'dispatcher',
      artifactDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64), human, accessJwt: 'a-jwt' }, environment);
    const intent = { installationId: 'dispatcher-install', activityId, operatorId: 'dispatcher',
      intentDigest: await createOperatorIntentDigest('dispatcher', activityId, invocationJson),
      expectedRevision: 1, expectedInstallationRevision: 1, expectedControlsRevision: 1,
      deadline: human.expiresAt * 1000, startExpiresAt: human.expiresAt * 1000, startVerifier: 'e'.repeat(64) };
    return { intent, executionContext, invocationJson };
  }

  it.each(['success', 'same-binding', 'missing-proof', 'foreign-proof', 'previous-binding', 'foreign-admission',
    'same-admission', 'rpc-error', 'unsafe-rpc-error', 'registry-storage-error', 'bind-transaction-error', 'bind-write-error',
    'admission-write-error', 'invalid-id', 'foreign-id', 'foreign-object', 'missing-namespace'] as const)(
    'REQ-OPERATOR-063 AC1/5/6 /061 AC3/7: %s traces only validated boundaries and preserves proof, binding and original errors with working and throwing loggers',
    fault => fixture(async ({ registry, native, environment }) => {
      const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
      await runInDurableObject(namespace.getByName(`admission-boundary-${crypto.randomUUID()}`), async (_instance, activityNative) => {
        const activityId = 'private-admission-activity', otherId = 'private-other-activity';
        const registryNamespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
        const inRegistry = <T>(action: () => Promise<T>) => runInDurableObject(registryNamespace.get(native.id), () => action());
        const first = await inRegistry(() => activateInstallation(registry));
        if (!first.ok) throw Error('No activation');
        if (fault !== 'missing-proof') expect(await inRegistry(() => registry.reserveProspectiveRenovateActivity(
          pr(first.registrationId, first.activatedAt, { activityId })))).toMatchObject({ ok: true, activityId });
        const journal = await inRegistry(() => registry.readProspectiveRenovateAdmission(activityId));
        const originalError = Error('private-provider-body Authorization=private-token', {
          cause: Error('private-cause https://private.invalid/provider'),
        });
        if (fault === 'unsafe-rpc-error') Object.defineProperty(originalError, 'message', {
          get: () => { throw Error('private-getter-body'); },
        });
        const host = { ...environment,
          OPERATOR_ACTIVITY: fault === 'missing-namespace' ? undefined
            : { idFromName: () => fault === 'foreign-object' ? namespace.idFromName(otherId) : activityNative.id },
          OPERATOR_REGISTRY: { getByName: () => ({ readProspectiveRenovateAdmission: async (id: string) => {
            if (fault === 'rpc-error' || fault === 'unsafe-rpc-error') throw originalError;
            if (fault === 'foreign-proof') return { ...journal as object, activityId: otherId };
            return inRegistry(() => registry.readProspectiveRenovateAdmission(id));
          } }) },
        } as unknown as Env;
        const activity = new OperatorActivity(activityNative, host);
        const { intent, executionContext, invocationJson } = await preparation(host, activityId);
        if (fault === 'previous-binding' || fault === 'same-binding') {
          await activityNative.storage.put('prospective-admission', fault === 'same-binding' ? activityId : otherId);
        }
        if (fault === 'foreign-admission' || fault === 'same-admission') {
          await activityNative.storage.put('admission', { intent: { ...intent,
            activityId: fault === 'same-admission' ? activityId : otherId }, phase: 'prepared', receipt: null });
        }
        const beforeAdmission = await activityNative.storage.get('admission');
        const beforeBinding = await activityNative.storage.get('prospective-admission');
        const read = native.storage.get.bind(native.storage);
        let storageOutage = fault === 'registry-storage-error';
        const unavailable = vi.spyOn(native.storage, 'get').mockImplementation((async (key: string) => {
          if (storageOutage && key === `renovate-activity:${activityId}`) throw originalError;
          return read(key);
        }) as typeof native.storage.get);
        const transaction = activityNative.storage.transaction.bind(activityNative.storage);
        const persist = vi.spyOn(activityNative.storage, 'transaction').mockImplementation(callback => {
          if (fault === 'bind-transaction-error') return Promise.reject(originalError);
          return transaction(tx => callback(new Proxy(tx, { get(target, property) {
            const member = Reflect.get(target, property);
            if (property === 'put') return (...args: unknown[]) => {
              const key = fault === 'bind-write-error' ? 'prospective-admission'
                : fault === 'admission-write-error' ? 'admission' : null;
              if (key && (args[0] === key || typeof args[0] === 'object'
                && args[0] !== null && key in args[0])) throw originalError;
              return Reflect.apply(member, target, args);
            };
            return typeof member === 'function' ? member.bind(target) : member;
          } })));
        });
        const outputs: Entry[] = [];
        let loggerOutage = false;
        const output = (line: unknown) => {
          outputs.push(JSON.parse(String(line)));
          if (loggerOutage) throw Error('private-logger-body');
        };
        setLogLevel('info');
        const logs = vi.spyOn(console, 'log').mockImplementation(output);
        const warnings = vi.spyOn(console, 'warn').mockImplementation(output);
        const errors = vi.spyOn(console, 'error').mockImplementation(output);
        let firstDigest: unknown;
        try {
          // Repeat fresh preparation under a throwing logger; a second prepare is not a successful replay.
          for (const outage of [false, true]) {
            const accepted = fault === 'success' || fault === 'same-binding';
            if (outage && accepted) {
              await activityNative.storage.delete('admission');
              if (beforeBinding === undefined) await activityNative.storage.delete('prospective-admission');
            }
            loggerOutage = outage; outputs.length = 0;
            const input = fault === 'invalid-id' ? 'private/invalid?Authorization=private-token'
              : fault === 'foreign-id' ? otherId : activityId;
            const throws = ['rpc-error', 'unsafe-rpc-error', 'registry-storage-error', 'bind-transaction-error',
              'bind-write-error', 'admission-write-error'].includes(fault);
            const result = activity.prepareAuthorized(intent, executionContext, invocationJson, undefined, input);
            if (throws) await expect(result).rejects.toBe(originalError);
            else await expect(result).resolves.toEqual(accepted ? { ok: true, phase: 'prepared' }
              : { ok: false, reason: fault === 'same-admission' || fault === 'foreign-admission'
                ? 'already-prepared' : 'admission-denied' });
            const boundaries = outputs.filter(entry => entry.message === message);
            assertBoundaryWire(outputs);
            const proofRead = !['invalid-id', 'foreign-id', 'foreign-object', 'missing-namespace'].includes(fault);
            const storageRead = proofRead && !['rpc-error', 'unsafe-rpc-error', 'foreign-proof'].includes(fault);
            const bind = proofRead && !['rpc-error', 'unsafe-rpc-error', 'foreign-proof', 'registry-storage-error', 'missing-proof'].includes(fault);
            expect(boundaries.map(({ data }) => `${data.boundary}:${data.outcome}`)).toEqual([
              ...(proofRead ? ['activity-proof-rpc:started'] : []),
              ...(storageRead ? ['registry-proof-storage:started', `registry-proof-storage:${fault === 'registry-storage-error' ? 'failed' : 'completed'}`] : []),
              ...(proofRead ? [`activity-proof-rpc:${['rpc-error', 'unsafe-rpc-error', 'registry-storage-error'].includes(fault) ? 'failed' : 'completed'}`] : []),
              ...(bind ? ['activity-bind-storage:started', `activity-bind-storage:${['bind-transaction-error', 'bind-write-error', 'admission-write-error'].includes(fault) ? 'failed' : 'completed'}`] : []),
            ]);
            const digests = new Set(boundaries.map(({ data }) => data.admissionDigest));
            expect(digests.size).toBe(proofRead ? 1 : 0);
            // Domain separation is required; the plan deliberately does not pin the choice of prefix.
            if (proofRead) {
              expect([...digests][0]).not.toBe(hashDiagnostic(activityId));
              if (outage) expect([...digests][0]).toBe(firstDigest);
              else firstDigest = [...digests][0];
            }
            for (const { data } of boundaries) {
              if (data.outcome === 'failed') expect(data.error).toEqual(captureError(originalError));
              if (data.outcome === 'completed') expect(data).toMatchObject(data.boundary === 'activity-bind-storage'
                ? { accepted } : { proofPresent: fault !== 'missing-proof' });
            }
            expect(await activityNative.storage.get('prospective-admission')).toBe(accepted ? activityId : beforeBinding);
            if (accepted) {
              expect(await activityNative.storage.get('admission')).toMatchObject({ intent, executionContext,
                invocationJson, phase: 'prepared', receipt: null });
              expect(await activity.getAdmission()).toEqual({ activityId, phase: 'prepared', receipt: null });
              expect(await activity.getRuntimePlan()).toBeNull(); // Prepared never masquerades as queued.
            } else expect(await activityNative.storage.get('admission')).toEqual(beforeAdmission);
            // Registry failure is transient; removing the injected storage outage reveals the same immutable proof.
            storageOutage = false;
            expect(await inRegistry(() => registry.readProspectiveRenovateAdmission(activityId))).toEqual(journal);
            storageOutage = fault === 'registry-storage-error';
            if (fault === 'invalid-id') {
              const beforeInvalidRead = [...outputs];
              await expect(inRegistry(() => registry.readProspectiveRenovateAdmission(input))).resolves.toBeNull();
              expect(outputs).toEqual(beforeInvalidRead);
            }
            for (const value of [activityId, otherId, input, first.registrationId, 'owner-bucket', 'a@example.test',
              'a-jwt', head, 'private-provider-body', 'private-token', 'private-cause', 'private-getter-body',
              'private-logger-body', 'https://private.invalid/provider', 'Authorization']) {
              expect(JSON.stringify(outputs)).not.toContain(value);
            }
          }
        } finally {
          persist.mockRestore(); unavailable.mockRestore(); logs.mockRestore(); warnings.mockRestore(); errors.mockRestore(); setLogLevel('silent');
        }
      });
    }));

  it.each(['manual', 'boundary'] as const)(
    'REQ-OPERATOR-016 AC2 /061 AC3: %s preparation retains its existing authority without prospective proof',
    mode => fixture(async ({ native, environment }) => {
      const activityId = 'manual-preparation';
      const { intent, executionContext, invocationJson } = await preparation(environment, activityId);
      const boundary = { repositoryId: repoId, pullRequest: 1300, contextDigest: 'f'.repeat(64),
        session: { bucket: 'owner-bucket', sessionId: 'asession01', generation: 3 } };
      const activity = new OperatorActivity(native, { ...environment,
        OPERATOR_REGISTRY: { getByName: () => ({ readProspectiveRenovateAdmission: async () => null }) },
      } as unknown as Env);
      const result = mode === 'manual'
        ? await activity.prepareAuthorized(intent, executionContext, invocationJson)
        : await activity.prepareAuthorized(intent, executionContext, invocationJson, boundary);
      expect(result).toEqual({ ok: true, phase: 'prepared' });
      expect(await native.storage.get('prospective-admission')).toBeUndefined();
      expect(await native.storage.get('admission')).toMatchObject({ intent, executionContext, invocationJson,
        phase: 'prepared', receipt: null, ...(mode === 'boundary' ? { boundary } : {}) });
      expect(await activity.getBoundaryStartBinding(activityId)).toEqual(mode === 'boundary' ? boundary : null);
      expect(await activity.getAdmission()).toEqual({ activityId, phase: 'prepared', receipt: null });
      expect(await activity.getRuntimePlan()).toBeNull();
    }));

  it.each(['expired', 'mismatched-context'] as const)(
    'REQ-OPERATOR-016 AC2 /061 AC3: refused %s preparation cannot leave a prospective link or admission',
    fault => fixture(async ({ native, environment }) => {
      const activityId = 'refused-preparation';
      const { intent, executionContext, invocationJson } = await preparation(environment, activityId);
      const host = { ...environment, OPERATOR_ACTIVITY: { idFromName: () => native.id },
        OPERATOR_REGISTRY: { getByName: () => ({ readProspectiveRenovateAdmission: async () => ({ activityId }) }) },
      } as unknown as Env;
      const activity = new OperatorActivity(native, host);
      await expect(activity.prepareAuthorized(fault === 'expired' ? { ...intent, deadline: Date.now() - 1 } : intent,
        fault === 'mismatched-context' ? { ...executionContext, activityId: 'different-activity' } : executionContext,
        invocationJson, undefined, activityId)).resolves.toEqual({ ok: false,
        reason: fault === 'expired' ? 'authority-expired' : 'admission-denied' });
      expect(await native.storage.get('prospective-admission')).toBeUndefined();
      expect(await activity.getAdmission()).toBeNull();
      expect(await activity.getRuntimePlan()).toBeNull();
    }));

  it.each(['none', 'info', 'warn', 'both'] as const)(
    'REQ-OPERATOR-063 AC1/5/6 /061 AC3/7: first captured handoff stays paired through later failures and retained candidates; logger outage=%s cannot promote the secondary fence error',
    outage => fixture(async ({ registry, native, environment, selection, state }) => {
      (selection as ManagementExecutionSelection).installation.configurationJson = JSON.stringify({ renovate: {
        repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 21600 } });
      const prior = await enroll(registry, 'a', undefined, undefined, 86400);
      if (!prior.ok) throw Error('No prior activation');
      const retained = await registry.reserveProspectiveRenovateActivity(pr(prior.registrationId, prior.activatedAt,
        { pullRequest: 1302, activityId: 'private-retained-activity' }));
      const consent = claims('z@example.test', 86400);
      const first = await registry.activateProspectiveRenovate({ installationId: 'dispatcher-install', scope: 'installation',
        bucket: 'owner-bucket', sessionId: '', sessionGeneration: 0, human: consent, accessJwt: 'z-jwt',
        repository: { repository: 'acme/updates', repositoryId: repoId, baseBranch: 'trunk' } });
      if (!first.ok) throw Error('No activation');
      state.sessions.clear();
      const createdAt = new Date(Date.parse(first.activatedAt) + 1).toISOString();
      const originalError = Error('private-admission-body Authorization=private-token', { cause: Error('private-admission-cause') });
      const laterError = Error('private-later-plan-body');
      const fenceError = Error('private-fence-body', { cause: Error('private-fence-cause') });
      const attempted: string[] = [];
      const activityNamespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
      const receiverDigest = (id: string) => hashDiagnostic(JSON.stringify([
        'operator-activity-rpc-receiver:v1', activityNamespace.idFromName(id).toString(),
      ]));
      environment.CONTAINER = { getByName: () => { throw Error('No Host access'); } } as never;
      environment.OPERATOR_ACTIVITY = { getByName: (id: string) => ({
        id: activityNamespace.idFromName(id),
        readProspectiveRenovateRetryProof: async () => null,
        getRuntimePlan: async () => {
          attempted.push(id);
          if (attempted.length === 1) return null;
          throw laterError;
        },
        getBrowserDetail: async () => null,
        prepareAuthorized: async () => { throw originalError; },
        fenceRuntimeFailure: async () => { throw fenceError; },
      }) } as never;
      const exports = { GitHubInterceptor: () => ({ fetch: async (request: Request) => request.url.includes('/pulls?')
        ? Response.json([1300, 1301, 1302].map(number => ({ number, state: 'open', draft: false, created_at: createdAt,
          user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' }, head: { sha: head },
          base: { ref: 'trunk', sha: newerHead, repo: { id: repoId, full_name: 'acme/updates' } } })))
        : Response.json({ id: repoId, full_name: 'acme/updates', default_branch: 'trunk' }) }) };
      Object.defineProperty(native, 'exports', { configurable: true, value: exports });
      const observer = new OperatorRegistry(native, environment);
      vi.spyOn(observer, 'resolveManagementExecution').mockResolvedValue({ ok: true, value: selection } as never);
      environment.OPERATOR_REGISTRY = { getByName: () => observer } as never;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
      const outputs: Entry[] = [];
      const output = (level: 'info' | 'warn' | 'error') => (line: unknown) => {
        outputs.push(JSON.parse(String(line)));
        if (outage === level || outage === 'both') throw Error('private-logger-outage');
      };
      setLogLevel('info');
      const logs = vi.spyOn(console, 'log').mockImplementation(output('info'));
      const warnings = vi.spyOn(console, 'warn').mockImplementation(output('warn'));
      const errors = vi.spyOn(console, 'error').mockImplementation(output('error'));
      try {
        await expect(observer.alarm()).resolves.toBeUndefined();
        const summaries = outputs.filter(entry => entry.message === 'Prospective Renovate observation');
        expect(summaries).toHaveLength(1);
        expect(summaries[0].data).toEqual({ context: 'registry-alarm',
          observationDigest: expect.stringMatching(/^[a-f0-9]{64}$/), outcome: 'handoff-failure', stage: 'reservation',
          candidates: 3, reservationDenied: 0, retainedOtherRegistration: 1, retainedExisting: 0, handoffAttempts: 0,
          error: captureError(originalError), failureStage: 'preparation', admissionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          receiverDigest: receiverDigest(attempted[0]!),
        });
        const fenceWarnings = outputs.filter(entry => entry.message === 'Prospective Renovate handoff fence unavailable');
        expect(fenceWarnings.map(entry => entry.data)).toEqual([
          { stage: 'preparation', category: 'fence-unavailable', admissionDigest: summaries[0].data.admissionDigest,
            receiverDigest: receiverDigest(attempted[0]!), error: captureError(fenceError) },
          { stage: 'plan', category: 'fence-unavailable', admissionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            receiverDigest: receiverDigest(attempted[1]!), error: captureError(fenceError) },
        ]);
        expect(attempted).toHaveLength(2); // Two actually reserved identities, not replacement/replayed admissions.
        const proofDigests: unknown[] = [];
        for (const [index, id] of attempted.entries()) {
          const start = outputs.length;
          expect(await registry.readProspectiveRenovateAdmission(id)).toMatchObject({ activityId: id, pullRequest: 1300 + index,
            head, createdAt, activatedAt: first.activatedAt, actor: { registrationId: first.registrationId, sessionId: '', sessionGeneration: 0 } });
          const boundary = outputs.slice(start).filter(entry => entry.message === message);
          assertBoundaryWire(boundary);
          expect(boundary.map(entry => entry.data)).toEqual([
            { boundary: 'registry-proof-storage', outcome: 'started', admissionDigest: fenceWarnings[index].data.admissionDigest },
            { boundary: 'registry-proof-storage', outcome: 'completed', admissionDigest: fenceWarnings[index].data.admissionDigest, proofPresent: true },
          ]);
          proofDigests.push(boundary[0].data.admissionDigest);
          expect(await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt,
            { pullRequest: 1300 + index, activityId: 'private-no-replacement' }))).toMatchObject({ ok: true, activityId: id });
        }
        expect(proofDigests[0]).toBe(summaries[0].data.admissionDigest);
        expect(proofDigests[0]).not.toBe(proofDigests[1]);
        expect(await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt,
          { pullRequest: 1302, activityId: 'private-no-replacement' }))).toEqual(retained);
        expect(await registry.readProspectiveRenovateAdmission('private-no-replacement')).toBeNull();
        expect(await registry.currentProspectiveRenovateRegistration(first.registrationId)).toMatchObject({
          human: { expiresAt: consent.expiresAt }, repetitionIntervalSeconds: 21600, activatedAt: first.activatedAt,
        });
        expect(await native.storage.getAlarm()).toBe(Date.now() + 21600_000);
        const beforeDuplicate = [...outputs];
        await expect(observer.alarm()).resolves.toBeUndefined();
        expect(outputs).toEqual(beforeDuplicate);
        expect(await native.storage.getAlarm()).toBe(Date.now() + 21600_000);
        for (const value of [first.registrationId, prior.registrationId, ...attempted,
          ...attempted.map(id => activityNamespace.idFromName(id).toString()), 'private-retained-activity',
          'private-no-replacement', 'owner-bucket', 'a@example.test', 'z@example.test', 'asession01', 'a-jwt', 'z-jwt', head, newerHead,
          'private-admission-body', 'private-token', 'Authorization', 'private-admission-cause', 'private-later-plan-body',
          'private-fence-body', 'private-fence-cause', 'private-logger-outage']) expect(JSON.stringify(outputs)).not.toContain(value);
      } finally { logs.mockRestore(); warnings.mockRestore(); errors.mockRestore(); clock.mockRestore(); setLogLevel('silent'); }
    }));
});

describe('Task101 REQ-OPERATOR-061 installation-scoped observation', () => {
  const activate = (registry: Prospective, user: 'a' | 'z' = 'a', lifetimeSeconds = 3600) => registry.activateProspectiveRenovate({ installationId: 'dispatcher-install',
    scope: 'installation', bucket: 'owner-bucket', sessionId: '', sessionGeneration: 0,
    human: claims(`${user}@example.test`, lifetimeSeconds), accessJwt: `${user}-jwt`,
    repository: { repository: 'acme/updates', repositoryId: repoId, baseBranch: 'trunk' } });
  it.each([true, false, undefined])('REQ-OPERATOR-090/091: validated prospective logging=%s is parent-owned and pinned', loggingEnabled => fixture(async ({ registry, selection }) => {
    const selected = selection as ManagementExecutionSelection;
    if (loggingEnabled !== undefined) selected.operator.policy.loggingEnabled = loggingEnabled;
    const first = await activate(registry);
    expect(first.ok).toBe(true);
    if (!first.ok) throw Error('No activation');
    expect(await registry.observeProspectiveRenovateRegistration(first.registrationId)).toMatchObject({
      status: 'current', registration: { registrationId: first.registrationId, loggingEnabled: loggingEnabled !== false },
    });
    // A changed setting/revision cannot become a fresh capture or execution grant for this registration.
    selected.operator.policy.loggingEnabled = loggingEnabled === false;
    selected.operator.revision++;
    expect(await registry.observeProspectiveRenovateRegistration(first.registrationId)).toEqual({ status: 'denied' });
  }));
  it.each([{ loggingEnabled: true, planFailure: false }, { loggingEnabled: true, planFailure: true },
    { loggingEnabled: false, planFailure: false }])('REQ-OPERATOR-090/091: alarm raw logging=$loggingEnabled plan failure=$planFailure preserves complete private evidence and original admission', ({ loggingEnabled, planFailure }) => fixture(async ({ registry, native, environment, selection }) => {
    (selection as ManagementExecutionSelection).operator.policy.loggingEnabled = loggingEnabled;
    let body = new TextEncoder().encode('[]' + ' '.repeat(300_000));
    const originalError = new Error('SYNTHETIC_ORIGINAL_PLAN_FAILURE', {
      cause: new DOMException('SYNTHETIC_NATIVE_PLAN_TIMEOUT', 'TimeoutError'),
    });
    if (planFailure) environment.OPERATOR_ACTIVITY = { getByName: () => ({
      getRuntimePlan: async () => { throw originalError; },
      fenceRuntimeFailure: async () => {}, readProspectiveRenovateRetryProof: async () => null,
    }) } as never;
    Object.defineProperty(native, 'exports', { configurable: true, value: {
      GitHubInterceptor: () => ({ fetch: async (request: Request) => request.url.includes('/pulls?') ? new Response(body)
        : Response.json({ id: repoId, full_name: 'acme/updates', default_branch: 'trunk' }) }),
    } });
    const first = await activate(registry);
    if (!first.ok) throw Error('No activation');
    if (planFailure) body = new TextEncoder().encode(JSON.stringify([{ number: 1300, state: 'open', draft: false,
      created_at: new Date(Date.parse(first.activatedAt) + 1).toISOString(),
      user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' }, head: { sha: head },
      base: { ref: 'trunk', sha: newerHead, repo: { id: repoId, full_name: 'acme/updates' } },
    }]).padEnd(300_000, ' '));
    const existingKeys = new Set((await native.storage.list()).keys());
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    const outputs: string[] = [];
    let retained!: (receipt: RawCaptureReceipt) => void;
    const published = new Promise<RawCaptureReceipt>(resolve => { retained = resolve; });
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      outputs.push(line);
      const value = JSON.parse(line);
      if (value.message === 'raw-capture-receipt') retained(value.data);
    });
    try {
      await expect(registry.alarm()).resolves.toBeUndefined();
      expect((await native.storage.list({ prefix: 'renovate-admission:' })).size).toBe(planFailure ? 1 : 0);
      expect(await native.storage.getAlarm()).toBe(Date.now() + 900_000);
      if (loggingEnabled) {
        const receipt = await published;
        expect(receipt).toMatchObject({ status: 'complete', termination: planFailure ? 'failed' : 'complete' });
        const storage = await createOwnerRawCaptureStorage(environment, native.storage, async () => {});
        const archive = await readRawCapture({ storage, binding: { ownerKey: await operatorOwnerKey(claims('a@example.test')),
          installationId: 'dispatcher-install', releaseId: 'release',
          captureId: receipt.captureId, scope: { kind: 'observation', observationId: receipt.captureId } } });
        expect(archive.status).toBe('complete');
        expect(archive.records.find(record => record.stage === 'discovery-observation')?.value).toMatchObject({ accessJwt: 'a-jwt' });
        if (planFailure) expect(archive.records.find(record => record.stage === 'prospective-plan-error')?.value).toMatchObject({
          name: 'Error', message: 'SYNTHETIC_ORIGINAL_PLAN_FAILURE', cause: {
            name: 'TimeoutError', message: 'SYNTHETIC_NATIVE_PLAN_TIMEOUT',
          },
        });
        const chunks = archive.records.filter(record => record.stage === 'discovery-response-chunk'
          && (record.value as { url: string }).url.includes('/pulls?'));
        const captured = Uint8Array.from(chunks.flatMap(record => (record.value as { bytes: number[] }).bytes));
        expect(captured).toEqual(body);
        expect(archive.records.some(record => record.stage === 'discovery-response-eof'
          && (record.value as { url: string }).url.includes('/pulls?'))).toBe(true);
        for (const secret of ['a-jwt', 'SYNTHETIC_ORIGINAL_PLAN_FAILURE', 'SYNTHETIC_NATIVE_PLAN_TIMEOUT']) {
          expect(outputs.join('\n')).not.toContain(secret);
        }
      } else {
        expect(new Set((await native.storage.list()).keys())).toEqual(existingKeys);
        expect(outputs.map(line => JSON.parse(line)).some(value => value.message === 'raw-capture-receipt')).toBe(false);
      }
    } finally { log.mockRestore(); clock.mockRestore(); }
  }));
  it('zero sessions: explicit activation persists an alarm and admits only post-cutoff work; duplicate consent retains cutoff and identity', () => fixture(async ({ registry, restart, native, state }) => {
    state.sessions.clear();
    const first = await activate(registry); expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw Error('No activation');
    expect(await native.storage.getAlarm()).toBeGreaterThan(Date.now());
    expect(await activate(registry)).toEqual(first);
    expect(await restart().currentProspectiveRenovateRegistration(first.registrationId)).toMatchObject({ scope: 'installation',
      delegation: { version: 1, routingGroups: [] }, human: { groups: [] } });
    expect(await registry.prospectiveRenovateStatus('dispatcher-install', await operatorOwnerKey(claims('a@example.test')))).toBe('active');
    expect(await registry.prospectiveRenovateStatus('dispatcher-install', 'f'.repeat(64))).toBe('inactive');
    expect(await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt, { createdAt: first.activatedAt })))
      .toMatchObject({ ok: false, reason: 'pre-activation' });
    const reserved = await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt));
    expect(reserved).toMatchObject({ ok: true });
    expect(await restart().reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt, { activityId: 'duplicate' }))).toEqual(reserved);
    expect(await registry.readProspectiveRenovateAdmission('duplicate')).toBeNull();
  }));
  it('legacy installation migration: retirement during asynchronous election fences the stale winner at commit and leaves the head available to the armed admin', () => fixture(async ({ registry, restart, native, state }) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const identityFetch = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const observing = new Promise<void>(resolve => { entered = resolve; });
    let held = false;
    let reservation: Promise<Reservation> | undefined;
    const consent = { installationId: 'dispatcher-install', scope: 'installation' as const,
      bucket: 'owner-bucket', sessionId: '', sessionGeneration: 0,
      human: claims('a@example.test', 3600), accessJwt: 'a-jwt',
      repository: { repository: 'acme/updates', repositoryId: repoId, baseBranch: 'trunk' } };
    try {
      const a = await registry.activateProspectiveRenovate(consent), z = await activate(registry, 'z');
      if (!a.ok || !z.ok) throw Error('No activation');
      await seedLegacyInstallation(native, a); await seedLegacyInstallation(native, z);
      globalThis.fetch = async (input, init) => {
        if (!held && new Headers(init?.headers).get('Cookie') === 'CF_Authorization=a-jwt') {
          held = true; entered(); await gate;
        }
        return identityFetch(input, init);
      };
      reservation = registry.reserveProspectiveRenovateActivity(pr(z.registrationId, z.activatedAt));
      await observing;
      state.roles.set('a@example.test', 'user');
      clock.mockReturnValue(Date.now() + 2000);
      await registry.alarm();
      state.roles.set('a@example.test', 'admin');
      release();
      expect(await reservation).toMatchObject({ ok: false, reason: 'stale-election' });
      expect(await registry.readProspectiveRenovateAdmission('activity-1')).toBeNull();
      expect(await restart().reserveProspectiveRenovateActivity(pr(z.registrationId, z.activatedAt)))
        .toMatchObject({ ok: true, actor: { registrationId: z.registrationId } });
      // Reusing the same still-valid explicit consent also rearms a retired record.
      const rearmed = await registry.activateProspectiveRenovate(consent);
      expect(rearmed).toEqual(a);
      expect(await registry.currentProspectiveRenovateRegistration(a.registrationId))
        .toMatchObject({ human: { email: 'a@example.test' } });
      expect(await registry.activateProspectiveRenovate(consent)).toEqual(rearmed);
    } finally {
      release(); await reservation;
      globalThis.fetch = identityFetch; clock.mockRestore();
    }
  }));
  it('due Registry alarm observes the configured repository and binds one durable admission with zero sessions or container access', () => fixture(async ({ registry, native, environment, selection, state }) => {
    state.sessions.clear(); const first = await activate(registry); if (!first.ok) throw Error('No activation');
    const bound = new Set<string>();
    environment.CONTAINER = { getByName: () => { throw Error('Must not wake a container'); } } as never;
    environment.OPERATOR_ACTIVITY = { getByName: (id: string) => ({
      prepareAuthorized: async (intent: { activityId: string; expectedControlsRevision: number;
        expectedInstallationRevision: number; expectedRevision: number }, _context: unknown, invocationJson: string,
      boundary: unknown, prospectiveAdmissionId?: string) => {
        expect(intent).toMatchObject({ activityId: id, expectedControlsRevision: 1,
          expectedInstallationRevision: 1, expectedRevision: 1 });
        expect(invocationJson).toBe('{"repository":"acme/updates"}');
        expect(boundary).toBeUndefined();
        expect(prospectiveAdmissionId).toBe(id);
        bound.add(id); return { ok: true, phase: 'prepared' };
      },
      start: async () => ({ ok: false, reason: 'admission-uncertain' }),
      getRuntimePlan: async () => null,
      getBrowserDetail: async () => bound.has(id) ? { executionStatus: 'unknown' } : null,
    }) } as never;
    const createdAt = new Date(Date.parse(first.activatedAt) + 1).toISOString();
    const exports = { GitHubInterceptor: () => ({ fetch: async (request: Request) => request.url.includes('/pulls?')
      ? Response.json([{ number: 1300, state: 'open', draft: false, created_at: createdAt,
        user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' }, head: { sha: head },
        base: { ref: 'trunk', sha: newerHead, repo: { id: repoId, full_name: 'acme/updates' } } }])
      : Response.json({ id: repoId, full_name: 'acme/updates', default_branch: 'trunk' }) }) };
    Object.defineProperty(native, 'exports', { configurable: true, value: exports });
    const observer = new OperatorRegistry(native, environment);
    vi.spyOn(observer, 'resolveManagementExecution').mockImplementation(async () => state.enabled
      ? { ok: true, value: selection } as never : { ok: false, reason: 'disabled' });
    environment.OPERATOR_REGISTRY = { getByName: () => observer } as never;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    try {
      await observer.alarm();
      expect(bound.size).toBe(1);
      const id = [...bound][0]; expect(await registry.readProspectiveRenovateAdmission(id)).toMatchObject({
        pullRequest: 1300, head, createdAt, activatedAt: first.activatedAt, actor: { registrationId: first.registrationId } });
      const due = await native.storage.getAlarm(); expect(due).toBeGreaterThan(Date.now());
      await observer.alarm(); expect([...bound]).toEqual([id]); // early/duplicate delivery admits no replacement
      expect(await native.storage.getAlarm()).toBe(due);
      state.enabled = false; clock.mockReturnValue(due! + 1); await observer.alarm();
      expect(await native.storage.getAlarm()).toBeNull(); expect([...bound]).toEqual([id]);
    } finally { clock.mockRestore(); }
  }));
  it.each(['denied', 'unavailable', 'binding-unavailable', 'discovery-failure', 'unexpected-source', 'malformed-json-body', 'stream-error-body', 'empty', 'candidate', 'retained', 'other-registration', 'reservation-denied', 'stale-authority', 'handoff-attempt', 'handoff-failure', 'logger-throws', 'source-and-logger-throws'] as const)(
    'REQ-OPERATOR-063/209: legacy installation migration Registry alarm summary %s is private and does not change admission or saved six-hour cadence', fault => fixture(async ({ registry, native, environment, selection, state }) => {
      (selection as { installation: { configurationJson: string } }).installation.configurationJson = JSON.stringify({ renovate: {
        repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 21600 } });
      if (fault === 'other-registration') {
        const prior = await enroll(registry, 'a', undefined, undefined, 86400);
        if (!prior.ok) throw Error('No prior activation');
        await registry.reserveProspectiveRenovateActivity(pr(prior.registrationId, prior.activatedAt));
      }
      const first = await activate(registry, fault === 'other-registration' ? 'z' : 'a', 86400);
      if (!first.ok) throw Error('No activation');
      // Historical alarm diagnostic contract retains live Access dispositions.
      await seedLegacyInstallation(native, first);
      const target = pr(first.registrationId, first.activatedAt);
      let original: Reservation | undefined;
      if (fault === 'retained') original = await registry.reserveProspectiveRenovateActivity(target);
      const admitted = new Set<string>();
      const bodyFault = fault === 'malformed-json-body' || fault === 'stream-error-body';
      const originalRegistration = bodyFault ? await registry.currentProspectiveRenovateRegistration(first.registrationId) : undefined;
      const privateBody = '{"secret":"SYNTHETIC_DISCOVERY_SECRET Authorization=synthetic-token owner@synthetic.test",!}';
      const streamError = Error(privateBody);
      const handoffError = Error('secret-handoff-body https://private.test/handoff');
      environment.OPERATOR_ACTIVITY = { getByName: (id: string) => ({
        readProspectiveRenovateRetryProof: async () => null,
        prepareAuthorized: async (intent: { activityId: string }, _context: unknown, _invocation: string,
          _boundary: unknown, prospectiveAdmissionId?: string) => {
          expect(intent.activityId).toBe(id);
          expect(prospectiveAdmissionId).toBe(id);
          admitted.add(id);
          if (fault === 'handoff-failure') throw handoffError;
          return { ok: true, phase: 'prepared' };
        },
        start: async () => ({ ok: false, reason: 'admission-uncertain' }),
        // This intentionally incomplete plan only reaches the parent handoff; no SDK success is simulated.
        getRuntimePlan: async () => admitted.has(id) && fault === 'handoff-attempt' ? { activityId: id } : null,
        getBrowserDetail: async () => admitted.has(id)
          ? { executionStatus: fault === 'handoff-attempt' ? 'queued' : 'unknown' } : null,
        fenceRuntimeFailure: async () => false,
      }) } as never;
      const exports = { GitHubInterceptor: () => ({ fetch: async (request: Request) => {
        // Observation has already consumed its due time before source I/O.
        const saved = await native.storage.get<{ nextObservationAt: number }>(`renovate-registration:${first.registrationId}`);
        expect(saved?.nextObservationAt).toBe(Date.now() + 21600_000);
        if (fault === 'unexpected-source' || fault === 'source-and-logger-throws') throw Error('secret-source-body https://private.test/raw');
        if (fault === 'discovery-failure') return new Response('secret-source-body', { status: 503 });
        if (bodyFault && request.url.includes('/pulls?')) return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            if (fault === 'stream-error-body') controller.error(streamError);
            else { controller.enqueue(new TextEncoder().encode(privateBody)); controller.close(); }
          },
        }));
        return request.url.includes('/pulls?') ? Response.json(fault === 'empty' ? [] : [{
          number: 1300, state: 'open', draft: false, created_at: target.createdAt,
          user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' }, head: { sha: head },
          base: { ref: 'trunk', sha: newerHead, repo: { id: repoId, full_name: 'acme/updates' } },
        }]) : Response.json({ id: repoId, full_name: 'acme/updates', default_branch: 'trunk' });
      } }) };
      Object.defineProperty(native, 'exports', { configurable: true, value: fault === 'binding-unavailable' ? undefined : {
        ...exports, OperatorRuntimeCapability: () => { throw Error('No runtime handle may be opened by this diagnostic fixture'); },
      } });
      const observer = new OperatorRegistry(native, environment);
      vi.spyOn(observer, 'resolveManagementExecution').mockResolvedValue({ ok: true, value: selection } as never);
      environment.OPERATOR_REGISTRY = { getByName: () => observer } as never;
      if (fault === 'reservation-denied') vi.spyOn(observer, 'reserveProspectiveRenovateActivity')
        .mockResolvedValue({ ok: false, reason: 'stale-election' });
      if (fault === 'stale-authority') {
        const reserve = observer.reserveProspectiveRenovateActivity.bind(observer);
        vi.spyOn(observer, 'reserveProspectiveRenovateActivity').mockImplementation(async input => {
          const result = await reserve(input); state.identityFault = 'revoked'; return result;
        });
      }
      if (fault === 'denied') state.identityFault = 'revoked';
      if (fault === 'unavailable') state.identityFault = 'unavailable';
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
      const outputs: string[] = [];
      setLogLevel('info');
      const log = vi.spyOn(console, 'log').mockImplementation((value: string) => {
        outputs.push(value); if (fault === 'logger-throws' || fault === 'source-and-logger-throws') throw Error('Logger unavailable');
      });
      try {
        await expect(observer.alarm()).resolves.toBeUndefined();
        const summaries = outputs.map(value => JSON.parse(value)).filter(entry => entry.message === 'Prospective Renovate observation');
        expect(summaries).toHaveLength(1);
        const data = summaries[0].data;
        // Closed parent-owned summary contract: no target or authority payload fields.
        expect(Object.keys(data).filter(key => key !== 'error').sort()).toEqual([
          'context', 'observationDigest', 'outcome', 'stage', 'candidates', 'reservationDenied',
          'retainedOtherRegistration', 'retainedExisting', 'handoffAttempts',
          ...(fault === 'handoff-failure' ? ['failureStage', 'admissionDigest'] : []),
        ].sort());
        expect(data).toMatchObject({ context: 'registry-alarm', observationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          candidates: ['candidate', 'retained', 'other-registration', 'reservation-denied', 'stale-authority', 'handoff-attempt', 'handoff-failure', 'logger-throws'].includes(fault) ? 1 : 0,
          reservationDenied: fault === 'reservation-denied' ? 1 : 0,
          retainedOtherRegistration: fault === 'other-registration' ? 1 : 0,
          retainedExisting: fault === 'retained' ? 1 : 0, handoffAttempts: fault === 'handoff-attempt' ? 1 : 0 });
        if (['denied', 'unavailable', 'binding-unavailable', 'discovery-failure', 'unexpected-source', 'source-and-logger-throws', 'stale-authority', 'handoff-failure'].includes(fault) || bodyFault) {
          expect(data.outcome).toBe(fault === 'denied' ? 'authority-denied' : fault === 'unavailable' ? 'authority-unavailable'
            : fault === 'unexpected-source' || fault === 'source-and-logger-throws' || bodyFault ? 'discovery-failure' : fault);
        }
        if (bodyFault) {
          expect(data.stage).toBe('discovery');
          // Closed wire permits unavailable fingerprints and reports unsafe native accessors explicitly.
          const fingerprint = (value: unknown) => value === null ? null : expect.stringMatching(/^[a-f0-9]{64}$/);
          const accessorLoss = data.error.loss.includes('unsafe-error-access');
          expect(data.error).toEqual({ kind: 'Error', publicCode: null,
            messageDigest: hashDiagnostic('Renovate page unavailable'), stackDigest: fingerprint(data.error.stackDigest),
            causes: [{ kind: fault === 'malformed-json-body' ? 'SyntaxError' : 'Error',
              messageDigest: fault === 'stream-error-body' ? hashDiagnostic(streamError.message) : fingerprint(data.error.causes[0]?.messageDigest),
              stackDigest: fingerprint(data.error.causes[0]?.stackDigest) }],
            loss: accessorLoss ? ['unsafe-error-access'] : [], fingerprintScope: accessorLoss ? 'bounded' : 'full' });
          expect(await native.storage.list({ prefix: 'renovate-activity:' })).toEqual(new Map());
          expect(await native.storage.list({ prefix: 'renovate-admission:' })).toEqual(new Map());
          expect(originalRegistration).not.toBeNull();
          expect(await registry.currentProspectiveRenovateRegistration(first.registrationId)).toEqual(originalRegistration);
          for (const privateValue of [privateBody, 'SYNTHETIC_DISCOVERY_SECRET', 'Authorization', 'synthetic-token', 'owner@synthetic.test',
            'Renovate page unavailable', 'SyntaxError:']) expect(JSON.stringify(outputs)).not.toContain(privateValue);
        }
        if (fault === 'handoff-failure') expect(data).toMatchObject({ error: captureError(handoffError),
          failureStage: 'preparation', admissionDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
        for (const privateValue of ['acme/updates', 'owner-bucket', 'a@example.test', 'a-jwt', 'asession01',
          first.registrationId, head, newerHead, 'https://private.test/raw', 'secret-source-body',
          'secret-handoff-body', 'https://private.test/handoff', ...admitted]) {
          expect(JSON.stringify(summaries)).not.toContain(privateValue);
        }
        expect(admitted.size).toBe(['candidate', 'retained', 'handoff-attempt', 'handoff-failure', 'logger-throws'].includes(fault) ? 1 : 0);
        for (const id of admitted) expect(await registry.readProspectiveRenovateAdmission(id)).toMatchObject({
          activityId: id, pullRequest: 1300, head, actor: { registrationId: first.registrationId },
        });
        if (original?.ok) expect(await registry.reserveProspectiveRenovateActivity({ ...target, activityId: 'no-replacement' })).toEqual(original);
        expect(await registry.readProspectiveRenovateAdmission('no-replacement')).toBeNull();
        expect(await native.storage.getAlarm()).toBe(fault === 'denied' ? null : Date.now() + 21600_000);
        const before = [...outputs]; await observer.alarm(); expect(outputs).toEqual(before);
      } finally { log.mockRestore(); setLogLevel('silent'); clock.mockRestore(); }
    }));
  it.each(['claim-lost', 'authority-throw'] as const)(
    'REQ-OPERATOR-063/209: %s emits one bounded summary without replacing the original alarm outcome', fault => fixture(async ({ registry, native }) => {
      const first = await activate(registry); if (!first.ok) throw Error('No activation');
      const originalDue = await native.storage.getAlarm();
      const originalError = Error('private authority failure');
      const read = registry.observeProspectiveRenovateRegistration.bind(registry);
      const observation = vi.spyOn(registry, 'observeProspectiveRenovateRegistration').mockImplementation(async id => {
        if (fault === 'authority-throw') throw originalError;
        const result = await read(id);
        // A competing delivery already claimed this due observation.
        const key = `renovate-registration:${id}`;
        const saved = await native.storage.get<Record<string, unknown>>(key);
        await native.storage.put(key, { ...saved, nextObservationAt: Date.now() + 900_000 });
        return result;
      });
      const outputs: string[] = [];
      setLogLevel('info');
      const log = vi.spyOn(console, 'log').mockImplementation((value: string) => { outputs.push(value); throw Error('Logger unavailable'); });
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
      try {
        if (fault === 'authority-throw') await expect(registry.alarm()).rejects.toBe(originalError);
        else await expect(registry.alarm()).resolves.toBeUndefined();
        const summaries = outputs.map(value => JSON.parse(value)).filter(entry => entry.message === 'Prospective Renovate observation');
        expect(summaries).toHaveLength(1);
        expect(summaries[0].data).toMatchObject({ context: 'registry-alarm',
          outcome: fault === 'claim-lost' ? 'claim-lost' : 'observation-failure', candidates: 0, handoffAttempts: 0 });
        expect(JSON.stringify(summaries)).not.toContain(originalError.message);
        expect(JSON.stringify(summaries)).not.toContain(first.registrationId);
        expect(await native.storage.getAlarm()).toBe(fault === 'authority-throw' ? originalDue : Date.now() + 900_000);
        expect(await registry.readProspectiveRenovateAdmission('activity-1')).toBeNull();
      } finally { observation.mockRestore(); log.mockRestore(); setLogLevel('silent'); clock.mockRestore(); }
    }));
  const handoffFaults = ['authority-unavailable', 'authority-denied', 'late-authority-unavailable', 'lost-start-ack', 'admission-unavailable', 'profile-unavailable', 'profile-revoked',
    'plan-read', 'plan-missing', 'drive-plan-read', 'drive-plan-missing', 'detail-read', 'detail-missing', 'binding', 'concurrent-drive', 'persistence-unavailable',
    'prepared-start', 'admitting-start', 'preparation-proof-missing'] as const;
  const reconciliationCases = ['upgrade', 'absent', 'prepared', 'absent-global-receipt', 'admitting',
    'ledger-unavailable', 'legacy-no-admittedAt', 'concurrent-drive', 'unknown', 'foreign-owner', 'foreign-bucket',
    'stale-caller', 'stale-selection', 'stale-election', 'legacy-full-queued', 'legacy-full-absent',
    'legacy-full-prepared', 'legacy-full-missing-local', 'legacy-full-foreign-repository', 'session-pinned',
    'partial-pins', 'invalid-pins', 'mismatched-pins', 'invalid-admittedAt', 'legacy-full-ledger-missing', 'legacy-full-ledger-mismatch',
    'orphan-effect', 'orphan-publication', 'orphan-lease', 'active-original', 'head-boundary'] as const;
  const normalAlarmHandoff = (fault: typeof handoffFaults[number] | 'none', delegated = false,
    reconciliation?: typeof reconciliationCases[number]) => fixture(async ({ native, environment, selection, state }) => {
    // 2160810c's complete persisted layout used a fixed numeric repository and session authority.
    const historical = reconciliation?.startsWith('legacy-full-') === true;
    const sessionScoped = historical || reconciliation === 'session-pinned';
    const repoId = historical ? 973175879 : 424242;
    const repository = historical ? 'nikolanovoselec/komodo' : 'acme/updates';
    const replaceable = ['upgrade', 'absent', 'prepared', 'legacy-no-admittedAt', 'legacy-full-queued',
      'legacy-full-absent', 'legacy-full-prepared', 'session-pinned'].includes(reconciliation ?? '');
    // Reuse the normal installed-Worker wire fixture: real Registry/Activity/orchestrator,
    // controlled external App HTTP. This proves parent execution, not execution of Flue SDK code.
    const registryNamespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
    const inRegistry = <T>(action: () => Promise<T>) => runInDurableObject(registryNamespace.get(native.id), () => action());
    const activityNamespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
    const activityName = `alarm-normal-${crypto.randomUUID()}`;
    // Retain only names; each caller must acquire its own I/O stub, as in inOwnContext.
    const inActivity = <T>(action: () => Promise<T>) => runInDurableObject(activityNamespace.getByName(activityName), () => action());
    await runInDurableObject(activityNamespace.getByName(activityName), async (_instance, activityNative) => {
      state.sessions.clear();
      const approved = normalDispatcherBundle();
      let bytes = new TextEncoder().encode(JSON.stringify(approved));
      const bundleDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      const selected = selection as ManagementExecutionSelection;
      selected.installation.configurationJson = JSON.stringify({ renovate: {
        repository, automaticRuns: true, repetitionIntervalSeconds: 900 } });
      const inference = { allowedSources: ['managed'] as Array<'managed'>, routeIds: ['approved'], defaultRouteId: 'approved',
        reasoningLevels: ['off'] as Array<'off'>, defaultReasoningLevel: 'off' as const, inheritUserDefaults: false };
      selected.installation.policy = { capabilities: ['fetch', 'inference'], resourceProfileId: null, inference };
      selected.operator.policy = selected.installation.policy;
      Object.assign(selected.release, { bundleDigest, sourceCommit: approved.sourceCommit, manifestDigest: 'd'.repeat(64),
        intentVersion: '3', coreVersion: '1', provenance: { compilerCommit: normalDeployment.compilerCommit } });
      const transport = createNormalDispatcherTransport();
      const connection = { installationId: 'dispatcher-install', releaseId: 'release', connectionRevision: 1,
        ...normalDeployment, bundleDigest, manifestDigest: selected.release.manifestDigest,
        connectionSecretCiphertext: await sealOperatorSecret(connectionSecret, environment,
          { purpose: 'connection', recordId: 'dispatcher-install' }) };
      const pending: Promise<unknown>[] = [];
      let drained = 0;
      const drain = async () => {
        while (drained < pending.length) { const batch = pending.slice(drained); drained = pending.length; await Promise.all(batch); }
      };
      Object.defineProperty(activityNative, 'waitUntil', { configurable: true, value: (promise: Promise<unknown>) => { pending.push(promise); } });
      let activity: OperatorActivity;
      let activityId: string | undefined;
      let faultArmed = false;
      let runtimeRead = false;
      let queuedPlan: Awaited<ReturnType<OperatorActivity['getRuntimePlan']>>;
      let queuedAdmission: Awaited<ReturnType<OperatorActivity['getAdmission']>>;
      let originalPreparation: Parameters<OperatorActivity['prepareAuthorized']> | undefined;
      let originalStartCapability: string | undefined;
      let missingPreparationProof = fault === 'preparation-proof-missing';
      let ledgerUnavailable = false;
      const sensitiveError = 'private-token=never-log-this; body=private-owner-payload';
      const observations: Array<Record<string, unknown>> = [];
      const observationStatuses: string[] = [];
      const reservationStatuses: string[] = [];
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logs = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        try {
          const entry = JSON.parse(String(line));
          if (entry?.message !== 'Prospective Renovate observation') return;
          const { outcome, stage, failureStage, candidates, reservationDenied, retainedOtherRegistration,
            retainedExisting, handoffAttempts } = entry.data;
          observations.push({ outcome, stage, failureStage, candidates, reservationDenied,
            retainedOtherRegistration, retainedExisting, handoffAttempts });
        } catch { /* Unrelated console output is not admission evidence. */ }
      });
      setLogLevel('info');
      environment.CONTAINER = { getByName: () => { throw Error('No user Host may be opened'); },
        idFromName: () => { throw Error('No user Host may be selected'); } } as never;
      environment.LOADER = { get: () => { throw Error('Normal Dispatcher must use its installed App'); } } as never;
      environment.OPERATOR_ACTIVITY = { idFromName: () => activityNative.id, getByName: (id: string) => {
        if (activityId && activityId !== id) throw Error('Unexpected replacement Activity');
        activityId = id;
        // Use the fixture's existing inOwnContext pattern for each real DO boundary.
        return new Proxy(activity, { get: (target, key) => {
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? (...args: unknown[]) => inActivity(async () => {
            if (key === 'prepareAuthorized') {
              if (historical) {
                const intent = args[0] as Parameters<OperatorActivity['prepareAuthorized']>[0];
                args[2] = JSON.stringify({ repository, pullRequest: 1300 });
                args[0] = { ...intent, intentDigest: await createOperatorIntentDigest(intent.operatorId, intent.activityId, args[2] as string) };
              }
              originalPreparation = args as Parameters<OperatorActivity['prepareAuthorized']>;
            }
            if (key === 'start') originalStartCapability = args[0] as string;
            if (key === 'start' && fault === 'prepared-start') {
              queuedAdmission = await target.getAdmission();
              return { ok: false, reason: 'admission-uncertain' };
            }
            if (faultArmed) {
              if (key === 'fenceRuntimeFailure' && fault === 'concurrent-drive') {
                expect(await target.beginDrive()).toMatchObject({ ok: true, state: { generation: 1, status: 'running' } });
              }
              if (key === 'getRuntimePlan' && (fault === 'plan-read' || fault === 'drive-plan-read' && runtimeRead)
                || key === 'getBrowserDetail' && fault === 'detail-read'
                || key === 'fenceRuntimeFailure' && fault === 'persistence-unavailable') throw Error(sensitiveError);
              if (key === 'getRuntimePlan' && (fault === 'plan-missing' || fault === 'drive-plan-missing' && runtimeRead)
                || key === 'getBrowserDetail' && fault === 'detail-missing') return null;
            }
            const result = await Reflect.apply(value, target, args);
            if (key === 'start' && fault === 'admitting-start') queuedAdmission = await target.getAdmission();
            if (key === 'start' && result !== null && typeof result === 'object'
              && 'ok' in result && result.ok === true && fault !== 'none') {
              queuedPlan = await target.getRuntimePlan();
              queuedAdmission = await target.getAdmission();
              if (fault === 'authority-unavailable' || fault === 'lost-start-ack') state.identityFault = 'unavailable';
              if (fault === 'authority-denied') state.identityFault = 'forbidden';
              if (fault === 'binding' || fault === 'concurrent-drive' || fault === 'persistence-unavailable') {
                Object.defineProperty(exports, 'OperatorRuntimeCapability', { configurable: true, value: undefined });
              }
              faultArmed = true;
              if (fault === 'lost-start-ack') throw Error(sensitiveError);
            }
            if (key === 'getBrowserDetail' && faultArmed) {
              runtimeRead = true;
              if (fault === 'late-authority-unavailable') state.identityFault = 'unavailable';
            }
            return result;
          }) : value;
        } });
      } } as never;
      const exports = { GitHubInterceptor: () => ({ fetch: async (request: Request) => request.url.includes('/pulls?')
        ? Response.json(createdAt ? [{ number: 1300, state: 'open', draft: false, created_at: createdAt,
          user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' }, head: { sha: head },
          base: { ref: 'trunk', sha: newerHead, repo: { id: repoId, full_name: repository } } }] : [])
        : Response.json({ id: repoId, full_name: repository, default_branch: 'trunk' }) }),
        OperatorRuntimeCapability: ({ props }: { props: Record<string, unknown> }) =>
          new OperatorRuntimeCapability({ props } as unknown as ExecutionContext, environment) };
      const runtimeExport = exports.OperatorRuntimeCapability;
      Object.defineProperties(native, {
        exports: { configurable: true, value: exports },
        waitUntil: { configurable: true, value: (promise: Promise<unknown>) => { pending.push(promise); } },
      });
      const owner = new OperatorRegistry(native, environment);
      const observe = owner.observeProspectiveRenovateRegistration.bind(owner);
      const observation = vi.spyOn(owner, 'observeProspectiveRenovateRegistration').mockImplementation(async id => {
        const result = await observe(id);
        observationStatuses.push(result.status);
        return result;
      });
      const reserve = owner.reserveProspectiveRenovateActivity.bind(owner);
      const reservation = vi.spyOn(owner, 'reserveProspectiveRenovateActivity').mockImplementation(async input => {
        const result = await reserve(input);
        reservationStatuses.push(result.ok ? 'admitted' : result.reason);
        return result;
      });
      vi.spyOn(owner, 'resolveManagementExecution').mockResolvedValue({ ok: true, value: selected });
      // Same Registry admission/deployment authority seams used by dispatcher-production.ts.
      vi.spyOn(owner, 'admitManagement').mockImplementation(async input => {
        if (fault === 'admitting-start') return { ok: false, reason: 'disabled' };
        const receipt = { ...input, admittedAt: Date.now(), selection: selected };
        if (reconciliation) {
          // Preserve the real immutable ledger behind getManagementAdmission, even if local state is lost.
          await owner.getManagementAdmission(input.activityId);
          native.storage.sql.exec('INSERT INTO operator_admissions VALUES(?,?)', input.activityId, JSON.stringify(receipt));
        }
        return { ok: true, value: receipt };
      });
      vi.spyOn(owner, 'getManagementBundle').mockImplementation(async () => {
        if (fault === 'admission-unavailable') state.identityFault = 'unavailable';
        return bytes;
      });
      vi.spyOn(owner, 'getManagementDispatcherConnection').mockResolvedValue(connection);
      environment.OPERATOR_REGISTRY = { getByName: () => new Proxy(owner, { get: (target, key) => {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? (...args: unknown[]) => inRegistry(async () => {
          if (key === 'readProspectiveRenovateAdmission' && missingPreparationProof) return null;
          if (key === 'getManagementAdmission' && ledgerUnavailable) throw Error('Admission ledger unavailable');
          return Reflect.apply(value, target, args);
        }) : value;
      } }) } as never;
      const bucket = vi.spyOn(access, 'resolveBucketName').mockResolvedValue('owner-bucket');
      const groups = vi.spyOn(access, 'resolveSessionAccessGroup').mockResolvedValue([]);
      const routing = vi.spyOn(access, 'loadEnterpriseRouteConfig').mockResolvedValue({ routeCatalog: ['approved'],
        defaultRoute: 'approved', defaultReasoning: 'off', routeContextWindows: {} } as never);
      const identityFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        return new URL(url).origin === normalDeployment.controlOrigin
          ? transport.fetcher(input, init).then(response => {
            if (new URL(url).pathname === '/control/profile') {
              if (fault === 'profile-unavailable') state.identityFault = 'unavailable';
              if (fault === 'profile-revoked') state.identityFault = 'revoked';
            }
            return response;
          }) : identityFetch(input, init);
      };
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      let createdAt = '';
      try {
        activity = new OperatorActivity(activityNative, environment);
        await drain();
        const activateOwner = (user: 'a' | 'z') => owner.activateProspectiveRenovate({
          installationId: 'dispatcher-install', scope: 'installation', bucket: 'owner-bucket', sessionId: '', sessionGeneration: 0,
          human: claims(`${user}@example.test`, 3600), accessJwt: `${user}-jwt`,
          repository: { repository, repositoryId: repoId, baseBranch: 'trunk' } });
        const retired = await inRegistry(() => activateOwner('a'));
        const registration = await inRegistry(() => activateOwner('z'));
        if (!retired.ok || !registration.ok) throw Error('No installation activation');
        if (!delegated) {
          await inRegistry(() => seedLegacyInstallation(native, retired));
          await inRegistry(() => seedLegacyInstallation(native, registration));
        }
        state.roles.set('a@example.test', 'user');
        clock.mockReturnValue(Date.now() + 2000);
        // No new PRs yet; this delivery retires only A's authority.
        await inRegistry(() => owner.alarm()); await drain();
        expect(activityId).toBeUndefined();
        state.roles.set('a@example.test', 'admin');
        expect(await inRegistry(() => owner.currentProspectiveRenovateRegistration(retired.registrationId))).toBeNull();
        createdAt = new Date(Date.parse(registration.activatedAt) + 1).toISOString();
        clock.mockReturnValue(Date.now() + 900_000);
        await inRegistry(() => owner.alarm()); await drain();
        if (!activityId) throw Error(`No Activity admitted by alarm: ${JSON.stringify({
          observations: observations.slice(-4), observationStatuses: observationStatuses.slice(-16),
          reservationStatuses: reservationStatuses.slice(-8),
        })}`);
        if (reconciliation) {
          const originalId = activityId;
          const persisted = await inRegistry(() => owner.readProspectiveRenovateAdmission(originalId)) as ProspectiveAdmission;
          const legacy: Record<string, unknown> = historical ? {
            activityId: persisted.activityId, installationId: persisted.installationId, repositoryId,
            pullRequest: persisted.pullRequest, head: persisted.head, createdAt: persisted.createdAt,
            activatedAt: persisted.activatedAt, ownerKey: persisted.ownerKey, actor: { ...persisted.actor },
          } : { ...persisted };
          if (reconciliation === 'legacy-no-admittedAt') delete legacy.admittedAt;
          if (reconciliation === 'partial-pins') delete legacy.releaseId;
          if (reconciliation === 'invalid-pins') legacy.controlsRevision = '1';
          if (reconciliation === 'mismatched-pins') legacy.releaseId = 'not-the-original-release';
          if (reconciliation === 'invalid-admittedAt') legacy.admittedAt = null;
          if (sessionScoped) {
            legacy.actor = { ...persisted.actor, sessionId: 'zsession01', sessionGeneration: 4 };
            // Authentic session record; only the subsequent explicit installation consent may supersede it.
            await inRegistry(async () => {
              const key = `renovate-registration:${registration.registrationId}`;
              const { scope: _scope, delegation: _delegation, nextObservationAt: _due, ...record } =
                (await native.storage.get<Record<string, unknown>>(key))!;
              await native.storage.put(key, { ...record, sessionId: 'zsession01', sessionGeneration: 4 });
            });
          }
          if (reconciliation === 'legacy-full-foreign-repository') legacy.repositoryId = repoId + 1;
          await inRegistry(() => native.storage.put({ [`renovate-activity:${originalId}`]: legacy,
            [`renovate-admission:${repoId}:1300:${head}`]: legacy }));
          const original = await inRegistry(() => owner.readProspectiveRenovateAdmission(originalId)) as ProspectiveAdmission;
          // No fresh installation consent: valid legacy work stays attached to its original actor.
          if (historical && reconciliation !== 'legacy-full-foreign-repository' || reconciliation === 'session-pinned') {
            expect(await inRegistry(() => owner.reserveProspectiveRenovateActivity({
              ...pr(registration.registrationId, registration.activatedAt), repositoryId: repoId, activityId: 'before-consent',
            }))).toMatchObject({ ok: true, activityId: originalId });
            expect(await inRegistry(() => owner.readProspectiveRenovateAdmission('before-consent'))).toBeNull();
          }
          const originalActivity = activity;
          if (reconciliation === 'absent-global-receipt' || reconciliation === 'legacy-full-missing-local') {
            expect(await inRegistry(() => owner.getManagementAdmission(originalId))).toMatchObject({ activityId: originalId });
            await inActivity(() => activityNative.storage.delete('admission'));
          }
          faultArmed = false;
          missingPreparationProof = false;
          Object.defineProperty(exports, 'OperatorRuntimeCapability', { configurable: true, value: runtimeExport });
          // A real new package/release selection invalidates the old consent, not its history.
          approved.modules['resources/intent.txt'].text += 'Upgraded approved resource\n';
          bytes = new TextEncoder().encode(JSON.stringify(approved));
          const upgradedDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
          selected.installation.revision++;
          selected.installation.releaseId = selected.release.id = 'upgraded-release';
          selected.release.bundleDigest = connection.bundleDigest = upgradedDigest;
          connection.releaseId = selected.release.id;
          const consent = { installationId: 'dispatcher-install', scope: 'installation' as const,
            bucket: reconciliation === 'foreign-bucket' ? 'other-bucket' : 'owner-bucket', sessionId: '', sessionGeneration: 0,
            human: claims(reconciliation === 'foreign-owner' ? 'a@example.test' : 'z@example.test', 86400),
            accessJwt: reconciliation === 'foreign-owner' ? 'a-jwt' : 'z-jwt',
            repository: { repository, repositoryId: repoId, baseBranch: 'trunk' } };
          const originalRegistration = await inRegistry(() => native.storage.get(`renovate-registration:${registration.registrationId}`));
          const current = await inRegistry(() => owner.activateProspectiveRenovate(consent));
          if (!current.ok) throw Error('No fresh activation');
          expect(current.activatedAt).toBe(original.activatedAt);
          const target = pr(reconciliation === 'stale-caller' ? registration.registrationId : current.registrationId,
            current.activatedAt, { activityId: 'reconciled-a', repositoryId: repoId });
          if (reconciliation === 'head-boundary') {
            target.head = newerHead;
            await inRegistry(() => native.storage.put(`renovate-admission:${repoId}:1300:${newerHead}`, original));
          }
          if (reconciliation === 'active-original') await inRegistry(() => native.storage.put(
            `renovate-registration:${registration.registrationId}`, originalRegistration));
          const orphanKey = reconciliation === 'orphan-effect' ? 'dispatcher:operation:orphan'
            : reconciliation === 'orphan-publication' ? 'renovate:publication' : reconciliation === 'orphan-lease' ? 'dispatcher:lease' : null;
          if (orphanKey) await inActivity(() => activityNative.storage.put(orphanKey,
            reconciliation === 'orphan-lease' ? { generation: 1, artifactDigest: persisted.bundleDigest,
              inputDigest: originalPreparation![0].intentDigest, expiresAt: Date.now() + 60_000, submissionId: null, status: 'unknown' }
              : reconciliation === 'orphan-publication' ? { ownerKey: original.ownerKey, bucket: original.actor.bucket,
                sessionId: original.actor.sessionId, sessionGeneration: original.actor.sessionGeneration,
                activityGeneration: 1, assessmentDigest: 'd'.repeat(64), operationId: 'old-publication', effects: { comment: { phase: 'unknown' } } }
                : { generation: 1, requestDigest: 'd'.repeat(64), phase: 'unknown' }));
          const originalState = await inActivity(() => originalActivity.getAdmission());
          const originalDetail = await inActivity(() => originalActivity.getBrowserDetail());
          const originalLedger = await inRegistry(() => owner.getManagementAdmission(originalId));
          if (['absent', 'prepared', 'legacy-no-admittedAt', 'legacy-full-absent', 'legacy-full-prepared'].includes(reconciliation)) expect(originalLedger).toBeNull();
          ledgerUnavailable = reconciliation === 'ledger-unavailable';
          let racedDrive = false;
          environment.OPERATOR_ACTIVITY = { idFromName: () => activityNative.id, getByName: (id: string) => {
            if (id !== originalId) throw Error('Unexpected replacement before election');
            return new Proxy(originalActivity, { get: (object, key) => {
              const value = Reflect.get(object, key);
              return typeof value === 'function' ? (...args: unknown[]) => inActivity(async () => {
                if (key === 'retireProspectiveRenovatePreparation' && reconciliation === 'concurrent-drive' && !racedDrive) {
                  racedDrive = true;
                  await originalActivity.beginDrive();
                }
                if (key === 'retireProspectiveRenovatePreparation' && reconciliation === 'legacy-full-ledger-missing') {
                  vi.spyOn(owner, 'getManagementAdmission').mockResolvedValue(null);
                }
                if (key === 'retireProspectiveRenovatePreparation' && reconciliation === 'legacy-full-ledger-mismatch') {
                  vi.spyOn(owner, 'getManagementAdmission').mockResolvedValue({ ...originalLedger!, intentDigest: 'f'.repeat(64) });
                }
                const result = await Reflect.apply(value, object, args);
                if (key === 'retireProspectiveRenovatePreparation' && result === true) {
                  if (reconciliation === 'stale-selection') selected.installation.revision++;
                  if (reconciliation === 'stale-election') await inRegistry(() => owner.activateProspectiveRenovate({
                    ...consent, accessJwt: 'z-fresh-consent' }));
                }
                return result;
              }) : value;
            } });
          } } as never;
          const outcomes = await inRegistry(() => Promise.all([
            owner.reserveProspectiveRenovateActivity(target),
            owner.reserveProspectiveRenovateActivity({ ...target, activityId: 'reconciled-b' }),
          ]));
          if (reconciliation === 'legacy-full-ledger-missing' || reconciliation === 'legacy-full-ledger-mismatch') {
            vi.mocked(owner.getManagementAdmission).mockRestore();
          }
          expect(await inRegistry(() => owner.readProspectiveRenovateAdmission(originalId))).toEqual(original);
          expect(await inRegistry(() => owner.getManagementAdmission(originalId))).toEqual(originalLedger);
          expect(transport.admissions.size).toBe(0);
          expect(transport.networkRequests).toEqual([]);
          if (!replaceable) {
            expect(await inRegistry(() => owner.readProspectiveRenovateAdmission('reconciled-a'))).toBeNull();
            expect(await inRegistry(() => owner.readProspectiveRenovateAdmission('reconciled-b'))).toBeNull();
            if (reconciliation === 'concurrent-drive') {
              expect(await inActivity(() => originalActivity.getBrowserDetail())).toMatchObject({ executionStatus: 'running' });
            } else if (reconciliation === 'stale-selection' || reconciliation === 'stale-election') {
              expect(await inActivity(() => originalActivity.getBrowserDetail())).toMatchObject({
                executionStatus: 'cancel-requested', cleanupStatus: 'stopped' });
            } else {
              expect(await inActivity(() => originalActivity.getAdmission())).toEqual(originalState);
              expect(await inActivity(() => originalActivity.getBrowserDetail())).toEqual(originalDetail);
            }
            return;
          }
          expect(outcomes[0]).toEqual(outcomes[1]);
          const elected = outcomes[0];
          if (!elected.ok) throw Error('No reconciled admission');
          expect(['reconciled-a', 'reconciled-b']).toContain(elected.activityId);
          const loser = elected.activityId === 'reconciled-a' ? 'reconciled-b' : 'reconciled-a';
          expect(await inRegistry(() => owner.readProspectiveRenovateAdmission(loser))).toBeNull();
          expect(await inRegistry(() => owner.readProspectiveRenovateAdmission(elected.activityId))).toMatchObject({
            previousActivityId: originalId, attempt: 2, releaseId: 'upgraded-release', bundleDigest: upgradedDigest,
            actor: { registrationId: current.registrationId, email: original.actor.email }, head, createdAt });
          const queuedOriginal = ['upgrade', 'legacy-full-queued', 'session-pinned'].includes(reconciliation);
          const blockedDrive = { ok: false, reason: queuedOriginal ? 'drive-settled' : 'not-admitted' };
          expect(await inActivity(() => originalActivity.beginDrive())).toEqual(blockedDrive);
          if (['absent', 'legacy-no-admittedAt', 'legacy-full-absent'].includes(reconciliation)) {
            const latePreparation = originalPreparation;
            if (!latePreparation) throw Error('Missing original preparation input');
            expect(await inActivity(() => originalActivity.prepareAuthorized(...latePreparation)))
              .toEqual({ ok: false, reason: 'admission-denied' });
            expect(await inActivity(() => originalActivity.getAdmission())).toBeNull();
          }
          if (reconciliation === 'prepared' || reconciliation === 'legacy-full-prepared') {
            const lateCapability = originalStartCapability;
            if (!lateCapability) throw Error('Missing original start capability');
            expect(await inActivity(() => originalActivity.start(lateCapability)))
              .toEqual({ ok: false, reason: 'admission-denied' });
            expect(await inActivity(() => originalActivity.getAdmission())).toMatchObject({ phase: 'cancelled', receipt: null });
          }
          const freshName = `alarm-reconciled-${crypto.randomUUID()}`;
          await runInDurableObject(activityNamespace.getByName(freshName), async (_fresh, freshNative) => {
            const inFresh = <T>(action: () => Promise<T>) => runInDurableObject(activityNamespace.getByName(freshName), () => action());
            const freshActivity = new OperatorActivity(freshNative, environment);
            Object.defineProperty(freshNative, 'waitUntil', { configurable: true, value: (work: Promise<unknown>) => { pending.push(work); } });
            environment.OPERATOR_ACTIVITY = { idFromName: (id: string) => id === originalId ? activityNative.id : freshNative.id,
              getByName: (id: string) => {
                const object = id === originalId ? originalActivity : freshActivity;
                if (id !== originalId && id !== elected.activityId) throw Error('Unexpected duplicate Activity');
                const enter = id === originalId ? inActivity : inFresh;
                return new Proxy(object, { get: (target, key) => {
                  const value = Reflect.get(target, key);
                  return typeof value === 'function' ? (...args: unknown[]) => enter(async () => Reflect.apply(value, target, args)) : value;
                } });
              } } as never;
            const due = await inRegistry(() => native.storage.getAlarm());
            clock.mockReturnValue(due! + 1);
            await inRegistry(() => owner.alarm()); await drain();
            expect(await inFresh(() => freshActivity.getBrowserDetail())).toMatchObject({ activityId: elected.activityId, executionStatus: 'running' });
            expect(transport.admissions.size).toBe(1);
            const accepted = structuredClone([...transport.admissions.values()]);
            await inRegistry(() => owner.alarm()); await drain();
            expect([...transport.admissions.values()]).toEqual(accepted);
            expect(await inRegistry(() => owner.readProspectiveRenovateAdmission(originalId))).toEqual(original);
            expect(await inRegistry(() => owner.getManagementAdmission(originalId))).toEqual(originalLedger);
            expect(await inActivity(() => originalActivity.beginDrive())).toEqual(blockedDrive);
          });
          return;
        }
        if (fault === 'preparation-proof-missing') {
          expect(observations.at(-1)).toMatchObject({ outcome: 'handoff-failure', failureStage: 'preparation',
            handoffAttempts: 0 });
          expect(await activity.getAdmission()).toBeNull();
          expect(await activityNative.storage.get('prospective-admission')).toBeUndefined();
          expect(await activity.getRuntimePlan()).toBeNull();
          expect(transport.networkRequests).toEqual([]);
          const retained = await inRegistry(() => owner.readProspectiveRenovateAdmission(activityId!));
          expect(retained).toMatchObject({ activityId, activatedAt: registration.activatedAt, createdAt });
          await inRegistry(() => owner.alarm()); await drain();
          expect(await activity.getAdmission()).toBeNull();
          expect(await inRegistry(() => owner.reserveProspectiveRenovateActivity(pr(registration.registrationId,
            registration.activatedAt, { activityId: 'must-not-replace-refused-preparation' }))))
            .toMatchObject({ ok: true, activityId });
          expect(await inRegistry(() => owner.readProspectiveRenovateAdmission('must-not-replace-refused-preparation'))).toBeNull();
          return;
        }
        if (!delegated && ['admission-unavailable', 'profile-unavailable', 'profile-revoked'].includes(fault)) {
          const ownerKey = await operatorOwnerKey(claims('z@example.test'));
          const code = fault === 'profile-revoked' ? 'authority-denied' : 'platform-evidence-required';
          expect(await activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null });
          expect(await activity.getDispatcherDiagnosticsV2(ownerKey, { view: 'summary' })).toMatchObject({
            status: 200, value: { diagnosis: { code } },
          });
          expect(transport.admissions.size).toBe(0);
          expect(transport.networkRequests.filter(request => new URL(request.url).pathname !== '/control/profile')).toEqual([]);
          if (fault === 'admission-unavailable') expect(transport.networkRequests).toEqual([]);
          const retained = await inRegistry(() => owner.readProspectiveRenovateAdmission(activityId!));
          state.identityFault = 'valid';
          await inRegistry(() => owner.alarm()); await drain();
          expect(transport.admissions.size).toBe(0);
          expect(await inRegistry(() => owner.readProspectiveRenovateAdmission(activityId!))).toEqual(retained);
          return;
        }
        if (!delegated && fault !== 'none') {
          faultArmed = false;
          const retained = await inRegistry(() => owner.readProspectiveRenovateAdmission(activityId!));
          const due = await inRegistry(() => native.storage.getAlarm());
          if (fault === 'prepared-start' || fault === 'admitting-start') {
            activity = new OperatorActivity(activityNative, environment);
            await drain();
            expect(await activity.getAdmission()).toEqual(queuedAdmission!);
            expect(await activity.getAdmission()).toMatchObject({ phase: fault === 'prepared-start' ? 'prepared' : 'admitting', receipt: null });
            expect(await activity.fenceRuntimeFailure(undefined, { boundary: 'construction', code: 'startup-failed' },
              { onlyBeforeDrive: true })).toEqual({ ok: false, reason: 'not-admitted' });
            await inRegistry(() => owner.alarm()); await drain();
            expect(await activity.getAdmission()).toEqual(queuedAdmission!);
            expect(await inRegistry(() => owner.readProspectiveRenovateAdmission(activityId!))).toEqual(retained);
            expect(await inRegistry(() => native.storage.getAlarm())).toBe(due);
            expect(transport.networkRequests).toEqual([]);
            return;
          }
          expect(due).toBe(Math.min(Date.now() + 900_000, queuedPlan!.deadline));
          // Reopen the real owner: browser status and diagnostics must come from durable state.
          activity = new OperatorActivity(activityNative, environment);
          await drain();
          expect(await activity.getAdmission()).toEqual(queuedAdmission!);
          // Immutable runtime-plan contract: fencing cannot replace pins, owner or the original authority window.
          expect(await activity.getRuntimePlan()).toEqual(queuedPlan!);
          expect(await activity.getBrowserDetail()).toMatchObject({ activityId,
            executionStatus: fault === 'concurrent-drive' ? 'running' : fault === 'persistence-unavailable' ? 'queued' : 'unknown',
            checkpoint: null, result: null });
          const ownerKey = await operatorOwnerKey(claims('z@example.test'));
          const diagnostics = await activity.getDispatcherDiagnostics(ownerKey);
          expect(diagnostics).toMatchObject({ parent: { driveGeneration: fault === 'concurrent-drive' ? 1
            : fault === 'persistence-unavailable' ? null : 1, lease: null } });
          if (fault !== 'concurrent-drive' && fault !== 'persistence-unavailable') {
            const code = fault === 'authority-denied' ? 'authority-denied'
              : ['authority-unavailable', 'late-authority-unavailable', 'lost-start-ack'].includes(fault)
                ? 'platform-evidence-required' : 'startup-failed';
            const summary = await activity.getDispatcherDiagnosticsV2(ownerKey, { view: 'summary' });
            expect(summary).toMatchObject({ status: 200, value: { fence: { code, uncertain: true },
              diagnosis: { executionStatus: 'unknown', code } } });
            const history = await activity.getDispatcherDiagnosticsV2(ownerKey, { view: 'history' });
            expect(history).toMatchObject({ status: 200, value: { records: expect.arrayContaining([
              expect.objectContaining({ owner: 'host', outcome: 'unknown', code, origin: 'state-transition' }),
            ]) } });
            expect(JSON.stringify(history)).not.toContain(sensitiveError);
            expect(JSON.stringify(history)).not.toContain('never-log-this');
          }
          if (fault === 'persistence-unavailable') {
            const handoffWarnings = warnings.mock.calls.map(([line]) => {
              try { return JSON.parse(String(line)); } catch { return null; }
            }).filter(entry => entry?.message === 'Prospective Renovate handoff fence unavailable');
            expect(handoffWarnings).toEqual([expect.objectContaining({ data: {
              stage: 'binding', category: 'fence-unavailable', admissionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
              error: expect.objectContaining({ messageDigest: hashDiagnostic(sensitiveError) }),
            } })]);
            expect(JSON.stringify(handoffWarnings)).not.toContain('never-log-this');
          }
          expect(transport.admissions.size).toBe(0);
          expect(transport.networkRequests).toEqual([]);
          expect(retained).toMatchObject({ activityId, activatedAt: registration.activatedAt, createdAt,
            actor: { registrationId: registration.registrationId, email: 'z@example.test', sessionId: '', sessionGeneration: 0 } });
          await inRegistry(() => owner.alarm()); await drain();
          expect(await inRegistry(() => native.storage.getAlarm())).toBe(due);
          if (fault !== 'persistence-unavailable') {
            state.identityFault = 'valid';
            Object.defineProperty(exports, 'OperatorRuntimeCapability', { configurable: true, value: runtimeExport });
            clock.mockReturnValue(due! + 1);
            await inRegistry(() => owner.alarm()); await drain();
            expect(await activity.getBrowserDetail()).toMatchObject({ executionStatus: fault === 'concurrent-drive' ? 'running' : 'unknown' });
            expect(await inRegistry(() => owner.readProspectiveRenovateAdmission(activityId!))).toEqual(retained);
            expect(await inRegistry(() => owner.listOwnedActivityPage(ownerKey, null))).toMatchObject({
              items: [expect.objectContaining({ activityId })],
            });
            expect(transport.networkRequests).toEqual([]);
          }
          return;
        }
        expect(await activity.getAdmission()).toMatchObject({ phase: 'queued', receipt: { activityId } });
        expect(await activity.getBrowserDetail()).toMatchObject({ activityId, executionStatus: 'running', result: null });
        const plan = await activity.getRuntimePlan();
        expect(plan).toMatchObject({ activityId, prospectiveAdmissionId: activityId,
          invocationJson: JSON.stringify({ repository: 'acme/updates' }), executionContext: { owner: { email: 'z@example.test' } } });
        const result = { repository: 'acme/updates', results: [{ pullRequest: 1300, headSha: head,
          decision: 'DO_NOT_MERGE', comment: 'Controlled normal App result; no merge authorized.', outcome: 'NOT_MERGED' }] };
        transport.settle('completed', [{ name: 'assessment', data: result }]);
        await activity.reconcileDispatcherLease(); await drain();
        expect(await activity.collectBrowserResult()).toMatchObject({ ok: true,
          detail: { activityId, executionStatus: 'completed', collectionStatus: 'consumed', result } });
        const retained = await inRegistry(() => owner.readProspectiveRenovateAdmission(activityId!));
        const accepted = structuredClone([...transport.admissions.values()]);
        expect(retained).toMatchObject({ activityId, activatedAt: registration.activatedAt, createdAt,
          actor: { registrationId: registration.registrationId, sessionId: '', sessionGeneration: 0 } });
        expect(await inRegistry(() => owner.reserveProspectiveRenovateActivity(pr(registration.registrationId, registration.activatedAt,
          { activityId: 'must-not-replace-normal' })))).toMatchObject({ ok: true, activityId });
        await inRegistry(() => owner.alarm()); await drain();
        expect(await inRegistry(() => owner.readProspectiveRenovateAdmission('must-not-replace-normal'))).toBeNull();
        expect(await activity.getBrowserDetail()).toMatchObject({ activityId, executionStatus: 'completed', result });
        expect(await inRegistry(() => owner.readProspectiveRenovateAdmission(activityId!))).toEqual(retained);
        expect([...transport.admissions.values()]).toEqual(accepted);
        // Only fresh explicit consent can rearm A; it cannot change the cutoff
        // or replace Z's already-completed admission. Issuance itself stays live.
        if (delegated) {
          expect(await inRegistry(() => activate(owner as unknown as Prospective))).toMatchObject({ ok: false });
          state.identityFault = 'valid';
        }
        const reactivated = await inRegistry(() => activate(owner as unknown as Prospective));
        expect(reactivated).toMatchObject({ ok: true, activatedAt: retired.activatedAt });
        expect(await inRegistry(() => activate(owner as unknown as Prospective))).toEqual(reactivated);
        if (!reactivated.ok) throw Error('No explicit reactivation');
        expect(await inRegistry(() => owner.currentProspectiveRenovateRegistration(reactivated.registrationId)))
          .toMatchObject({ human: { email: 'a@example.test' } });
        expect(await inRegistry(() => owner.readProspectiveRenovateAdmission(activityId!))).toEqual(retained);
      } finally {
        setLogLevel('silent');
        try { await drain(); }
        finally {
          clock.mockRestore(); globalThis.fetch = identityFetch;
          routing.mockRestore(); groups.mockRestore(); bucket.mockRestore(); warnings.mockRestore();
          logs.mockRestore(); observation.mockRestore(); reservation.mockRestore();
        }
      }
    });
  });
  it.each(reconciliationCases)('REQ-OPERATOR-061 AC2/3/6/7 /062 /107: stale reservation %s preserves uncertainty and elects only atomically retired same-owner work',
    reconciliation => normalAlarmHandoff(reconciliation === 'unknown' ? 'binding'
      : ['absent', 'ledger-unavailable', 'legacy-no-admittedAt', 'legacy-full-absent'].includes(reconciliation) ? 'preparation-proof-missing'
        : reconciliation === 'prepared' || reconciliation === 'legacy-full-prepared' ? 'prepared-start' : reconciliation === 'admitting' ? 'admitting-start'
          : 'persistence-unavailable', false, reconciliation));
  it('role restoration without new consent cannot elect a retired admin or strand the active admin’s normal Dispatcher work',
    () => normalAlarmHandoff('none'));
  it.each(['authority-unavailable', 'authority-denied', 'late-authority-unavailable', 'admission-unavailable', 'profile-unavailable', 'profile-revoked'] as const)(
    'REQ-OPERATOR-047/048/061: delegated normal alarm handoff and immutable terminal collection survive external %s without a Host',
    fault => normalAlarmHandoff(fault, true));
  it.each(handoffFaults)('REQ-OPERATOR-061 AC3/5/7: legacy installation migration post-admission %s retains the original Activity and pre-drive disposition',
    fault => normalAlarmHandoff(fault));
  it.each(['expiry', 'role', 'invoker', 'installation', 'revision', 'configuration', 'release', 'controls'] as const)(
    '%s fences session-independent callbacks and new admissions', fault => fixture(async ({ registry, restart, selection, state }) => {
      state.sessions.clear(); const first = await activate(registry); if (!first.ok) throw Error('No activation');
      const selected = selection as { installation: { revision: number; configurationJson: string };
        operator: { invokers: { users: string[] } }; release: { id: string }; controlsRevision: number };
      const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        if (fault === 'expiry') clock.mockReturnValue(now + 3601_000);
        if (fault === 'role') state.roles.set('a@example.test', 'user');
        if (fault === 'invoker') selected.operator.invokers.users = [];
        if (fault === 'installation') state.enabled = false;
        if (fault === 'revision') selected.installation.revision++;
        if (fault === 'configuration') selected.installation.configurationJson = JSON.stringify({ renovate: {
          repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 900 } });
        if (fault === 'release') selected.release.id = 'other';
        if (fault === 'controls') selected.controlsRevision++;
        expect(await restart().currentProspectiveRenovateRegistration(first.registrationId)).toBeNull();
        expect((await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt))).ok).toBe(false);
        expect(await registry.readProspectiveRenovateAdmission('activity-1')).toBeNull();
      } finally { clock.mockRestore(); }
    }));
  it('manual-only saved settings cannot register or arm an alarm', () => fixture(async ({ registry, native, selection, state }) => {
    state.sessions.clear(); (selection as { installation: { configurationJson: string } }).installation.configurationJson = JSON.stringify({ renovate: {
      repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 900 } });
    expect(await activate(registry)).toMatchObject({ ok: false }); expect(await native.storage.getAlarm()).toBeNull();
  }));
  it('fresh explicit activation supersedes legacy session callbacks without reinterpreting their pins', () => fixture(async ({ registry, restart }) => {
    const old = await enroll(registry, 'a'); if (!old.ok) throw Error('No legacy registration');
    const next = await activate(registry); if (!next.ok) throw Error('No installation registration');
    expect(next.activatedAt).toBe(old.activatedAt);
    expect(await restart().currentProspectiveRenovateRegistration(old.registrationId)).toBeNull();
    expect(await restart().currentProspectiveRenovateRegistration(next.registrationId)).toMatchObject({ scope: 'installation' });
  }));
  it('expiry is truthful and a fresh explicit human activation rearms while retaining immutable cutoff', () => fixture(async ({ registry, native }) => {
    const first = await activate(registry); if (!first.ok) throw Error('No activation');
    const owner = await operatorOwnerKey(claims('a@example.test'));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3601_000);
    try {
      expect(await registry.prospectiveRenovateStatus('dispatcher-install', owner)).toBe('expired');
      const next = await activate(registry); if (!next.ok) throw Error('No reactivation');
      expect(next.activatedAt).toBe(first.activatedAt); expect(next.registrationId).not.toBe(first.registrationId);
      expect(await registry.prospectiveRenovateStatus('dispatcher-install', owner)).toBe('active');
      // A clock jump does not deliver the earlier saved alarm. Activation must not
      // postpone that due delivery; delivering it advances the newly armed owner.
      expect(await native.storage.getAlarm()).toBeLessThanOrEqual(Date.now());
      await registry.alarm();
      expect(await native.storage.getAlarm()).toBeGreaterThan(Date.now());
      expect(await registry.prospectiveRenovateStatus('dispatcher-install', owner)).toBe('active');
      expect(await activate(registry)).toEqual(next);
    } finally { clock.mockRestore(); }
  }));
  it('legacy installation migration: temporary identity loss projects unconfirmed and supplies no admission authority', () => fixture(async ({ registry, native, state }) => {
    const first = await activate(registry); if (!first.ok) throw Error('No activation');
    await seedLegacyInstallation(native, first); state.identityFault = 'unavailable';
    expect(await registry.prospectiveRenovateStatus('dispatcher-install', await operatorOwnerKey(claims('a@example.test')))).toBe('unconfirmed');
    expect((await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt))).ok).toBe(false);
  }));
});
