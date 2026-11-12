/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry, type CurrentProspectiveRegistration, type ManagementExecutionSelection } from '../../operators/registry';
import { OperatorActivity, createOperatorIntentDigest } from '../../operators/activity';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { connectionSecret, createNormalDispatcherTransport, normalDeployment, normalDispatcherBundle } from './fixtures/normal-dispatcher';
import { sealOperatorSecret } from '../../operators/protected-secrets';
import { OperatorRuntimeCapability, authorizeDispatcherPlan } from '../../operators/operator-runtime-capability';
import { createMockKV } from '../helpers/mock-kv';
import { Hono } from 'hono';
import * as access from '../../lib/access';
import activityRoutes from '../../routes/operator-activities';
import { listProspectiveRenovatePrs } from '../../operators/renovate-prospective';
import type { Env } from '../../types';
import type { ProspectiveRenovateRetryProof } from '../../operators/renovate-retry-proof';

const repoId = 424242, head = 'a'.repeat(40), newerHead = 'b'.repeat(40);
const at = new Date().toISOString();
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
    identityFault: 'valid' | 'revoked' | 'forbidden' | 'unavailable' | 'malformed' | 'transport-error' } }) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.getByName(`prospective-registry-${crypto.randomUUID()}`), async (_instance, native) => {
    const state = { sessions: new Map([['asession01', { generation: 3, status: 'running' }],
      ['zsession01', { generation: 4, status: 'running' }]]),
      roles: new Map([['a@example.test', 'admin'], ['z@example.test', 'admin']]),
      revoked: new Set<string>(), enabled: true,
      identityFault: 'valid' as 'valid' | 'revoked' | 'forbidden' | 'unavailable' | 'malformed' | 'transport-error' };
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
      ? JSON.stringify({ role: state.roles.get(key.slice(5)) ?? 'user' }) : null) as typeof kv.get;
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

describe('REQ-OPERATOR-061: durable prospective activation and admission', () => {
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
    const activity = new OperatorActivity(native, { ...environment, OPERATOR_REGISTRY: { getByName: () => ({
      admitManagement: async () => { accepted = true; throw new Error('Registry admission response lost'); },
      resolveManagementExecution: async () => ({ ok: true, value: selection }),
      upsertOwnedActivity: async () => {},
    }) } } as unknown as Env);
    const intent = { installationId: 'dispatcher-install', activityId: reserved.activityId,
      operatorId: 'dispatcher', intentDigest: await createOperatorIntentDigest('dispatcher', reserved.activityId, invocationJson),
      expectedRevision: 1, expectedInstallationRevision: 1, expectedControlsRevision: 1,
      deadline: human.expiresAt * 1000, startExpiresAt: human.expiresAt * 1000, startVerifier: verifier };
    expect(await activity.prepareAuthorized(intent, context, invocationJson)).toMatchObject({ ok: true });
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
    const human = claims('a@example.test');
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


describe('Task101 REQ-OPERATOR-061 installation-scoped observation', () => {
  const activate = (registry: Prospective, user: 'a' | 'z' = 'a') => registry.activateProspectiveRenovate({ installationId: 'dispatcher-install',
    scope: 'installation', bucket: 'owner-bucket', sessionId: '', sessionGeneration: 0,
    human: claims(`${user}@example.test`, 3600), accessJwt: `${user}-jwt`,
    repository: { repository: 'acme/updates', repositoryId: repoId, baseBranch: 'trunk' } });
  it('zero sessions: explicit activation persists an alarm and admits only post-cutoff work; duplicate consent retains cutoff and identity', () => fixture(async ({ registry, restart, native, state }) => {
    state.sessions.clear();
    const first = await activate(registry); expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw Error('No activation');
    expect(await native.storage.getAlarm()).toBeGreaterThan(Date.now());
    expect(await activate(registry)).toEqual(first);
    expect(await restart().currentProspectiveRenovateRegistration(first.registrationId)).toMatchObject({ scope: 'installation' });
    expect(await registry.prospectiveRenovateStatus('dispatcher-install', await operatorOwnerKey(claims('a@example.test')))).toBe('active');
    expect(await registry.prospectiveRenovateStatus('dispatcher-install', 'f'.repeat(64))).toBe('inactive');
    expect(await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt, { createdAt: first.activatedAt })))
      .toMatchObject({ ok: false, reason: 'pre-activation' });
    const reserved = await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt));
    expect(reserved).toMatchObject({ ok: true });
    expect(await restart().reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt, { activityId: 'duplicate' }))).toEqual(reserved);
    expect(await registry.readProspectiveRenovateAdmission('duplicate')).toBeNull();
  }));
  it('retirement during asynchronous election fences the stale winner at commit and leaves the head available to the armed admin', () => fixture(async ({ registry, restart, state }) => {
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
      bindProspectiveRenovateAdmission: async () => { bound.add(id); return true; },
      getRuntimePlan: async () => null,
      getBrowserDetail: async () => ({ executionStatus: 'unknown' }),
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
  it('role restoration without new consent cannot elect a retired admin or strand the active admin’s normal Dispatcher work', () => fixture(async ({ native, environment, selection, state }) => {
    // Reuse the normal installed-Worker wire fixture: real Registry/Activity/orchestrator,
    // controlled external App HTTP. This proves parent execution, not execution of Flue SDK code.
    const registryNamespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
    const inRegistry = <T>(action: () => Promise<T>) => runInDurableObject(registryNamespace.get(native.id), () => action());
    const activityNamespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
    const activityStub = activityNamespace.getByName(`alarm-normal-${crypto.randomUUID()}`);
    const inActivity = <T>(action: () => Promise<T>) => runInDurableObject(activityStub, () => action());
    await runInDurableObject(activityStub, async (_instance, activityNative) => {
      state.sessions.clear();
      const approved = normalDispatcherBundle();
      const bytes = new TextEncoder().encode(JSON.stringify(approved));
      const bundleDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      const selected = selection as ManagementExecutionSelection;
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
      environment.CONTAINER = { getByName: () => { throw Error('No user Host may be opened'); },
        idFromName: () => { throw Error('No user Host may be selected'); } } as never;
      environment.LOADER = { get: () => { throw Error('Normal Dispatcher must use its installed App'); } } as never;
      environment.OPERATOR_ACTIVITY = { idFromName: () => activityNative.id, getByName: (id: string) => {
        if (activityId && activityId !== id) throw Error('Unexpected replacement Activity');
        activityId = id;
        // Use the fixture's existing inOwnContext pattern for each real DO boundary.
        return new Proxy(activity, { get: (target, key) => {
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? (...args: unknown[]) => inActivity(async () => Reflect.apply(value, target, args)) : value;
        } });
      } } as never;
      const exports = { GitHubInterceptor: () => ({ fetch: async (request: Request) => request.url.includes('/pulls?')
        ? Response.json(createdAt ? [{ number: 1300, state: 'open', draft: false, created_at: createdAt,
          user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' }, head: { sha: head },
          base: { ref: 'trunk', sha: newerHead, repo: { id: repoId, full_name: 'acme/updates' } } }] : [])
        : Response.json({ id: repoId, full_name: 'acme/updates', default_branch: 'trunk' }) }),
        OperatorRuntimeCapability: ({ props }: { props: Record<string, unknown> }) =>
          new OperatorRuntimeCapability({ props } as unknown as ExecutionContext, environment) };
      Object.defineProperties(native, {
        exports: { configurable: true, value: exports },
        waitUntil: { configurable: true, value: (promise: Promise<unknown>) => { pending.push(promise); } },
      });
      const owner = new OperatorRegistry(native, environment);
      vi.spyOn(owner, 'resolveManagementExecution').mockResolvedValue({ ok: true, value: selected });
      // Same Registry admission/deployment authority seams used by dispatcher-production.ts.
      vi.spyOn(owner, 'admitManagement').mockImplementation(async input => ({ ok: true, value: {
        ...input, admittedAt: Date.now(), selection: selected } }));
      vi.spyOn(owner, 'getManagementBundle').mockResolvedValue(bytes);
      vi.spyOn(owner, 'getManagementDispatcherConnection').mockResolvedValue(connection);
      environment.OPERATOR_REGISTRY = { getByName: () => new Proxy(owner, { get: (target, key) => {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? (...args: unknown[]) => inRegistry(async () => Reflect.apply(value, target, args)) : value;
      } }) } as never;
      const bucket = vi.spyOn(access, 'resolveBucketName').mockResolvedValue('owner-bucket');
      const groups = vi.spyOn(access, 'resolveSessionAccessGroup').mockResolvedValue([]);
      const routing = vi.spyOn(access, 'loadEnterpriseRouteConfig').mockResolvedValue({ routeCatalog: ['approved'],
        defaultRoute: 'approved', defaultReasoning: 'off', routeContextWindows: {} } as never);
      const identityFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => new URL(new Request(input, init).url).origin === normalDeployment.controlOrigin
        ? transport.fetcher(input, init) : identityFetch(input, init);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      let createdAt = '';
      try {
        activity = new OperatorActivity(activityNative, environment);
        await drain();
        const retired = await inRegistry(() => activate(owner as unknown as Prospective));
        const registration = await inRegistry(() => activate(owner as unknown as Prospective, 'z'));
        if (!retired.ok || !registration.ok) throw Error('No installation activation');
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
        if (!activityId) throw Error('No Activity admitted by alarm');
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
        // or replace Z's already-completed admission.
        const reactivated = await inRegistry(() => activate(owner as unknown as Prospective));
        expect(reactivated).toMatchObject({ ok: true, activatedAt: retired.activatedAt });
        expect(await inRegistry(() => activate(owner as unknown as Prospective))).toEqual(reactivated);
        if (!reactivated.ok) throw Error('No explicit reactivation');
        expect(await inRegistry(() => owner.currentProspectiveRenovateRegistration(reactivated.registrationId)))
          .toMatchObject({ human: { email: 'a@example.test' } });
        expect(await inRegistry(() => owner.readProspectiveRenovateAdmission(activityId!))).toEqual(retained);
      } finally {
        await drain(); clock.mockRestore(); globalThis.fetch = identityFetch;
        routing.mockRestore(); groups.mockRestore(); bucket.mockRestore();
      }
    });
  }));
  it.each(['expiry', 'role', 'invoker', 'installation', 'revision', 'configuration', 'release', 'controls', 'identity'] as const)(
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
        if (fault === 'identity') state.revoked.add('a-jwt');
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
  it('temporary identity loss projects unconfirmed and supplies no admission authority', () => fixture(async ({ registry, state }) => {
    const first = await activate(registry); if (!first.ok) throw Error('No activation'); state.identityFault = 'unavailable';
    expect(await registry.prospectiveRenovateStatus('dispatcher-install', await operatorOwnerKey(claims('a@example.test')))).toBe('unconfirmed');
    expect((await registry.reserveProspectiveRenovateActivity(pr(first.registrationId, first.activatedAt))).ok).toBe(false);
  }));
});
