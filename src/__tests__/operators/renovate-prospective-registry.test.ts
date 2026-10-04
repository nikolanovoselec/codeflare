/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { OperatorActivity, createOperatorIntentDigest } from '../../operators/activity';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { authorizeDispatcherPlan } from '../../operators/operator-runtime-capability';
import { createMockKV } from '../helpers/mock-kv';
import type { Env } from '../../types';

const repoId = 973175879, head = 'a'.repeat(40), newerHead = 'b'.repeat(40);
const at = new Date().toISOString();
const claims = (email: string) => ({ subject: email, email, issuer: 'https://owner.cloudflareaccess.com',
  audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 20,
  expiresAt: Math.floor(Date.now() / 1000) + 300 });
type Registration = { ok: true; activatedAt: string; registrationId: string } | { ok: false; reason: string };
type Reservation = { ok: true; activityId: string; actor: { registrationId: string; bucket: string;
  sessionId: string; sessionGeneration: number } } | { ok: false; reason: string };
type Prospective = {
  activateProspectiveRenovate(input: { installationId: string; bucket: string; sessionId: string;
    sessionGeneration: number; human: ReturnType<typeof claims>; accessJwt: string }): Promise<Registration>;
  currentProspectiveRenovateRegistration(registrationId: string): Promise<unknown | null>;
  reserveProspectiveRenovateActivity(input: { registrationId: string; repositoryId: number;
    pullRequest: number; head: string; createdAt: string; activityId: string }): Promise<Reservation>;
  readProspectiveRenovateAdmission(activityId: string): Promise<unknown | null>;
};

async function fixture(run: (context: { registry: Prospective; restart: () => Prospective;
  native: DurableObjectState; environment: Env; selection: object;
  state: { sessions: Map<string, { generation: number; status: string }>;
    roles: Map<string, string>; revoked: Set<string>; enabled: boolean } }) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, native) => {
    const state = { sessions: new Map([['asession01', { generation: 3, status: 'running' }],
      ['zsession01', { generation: 4, status: 'running' }]]),
      roles: new Map([['a@example.test', 'admin'], ['z@example.test', 'admin']]),
      revoked: new Set<string>(), enabled: true };
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
    const environment = { ENCRYPTION_KEY: btoa('k'.repeat(32)),
      USAGE_DB: database, KV: kv } as unknown as Env;
    const registry = new OperatorRegistry(native, environment);
    const selection = { controlsRevision: 1, installation: { id: 'dispatcher-install', operatorId: 'dispatcher',
      enabled: true, revision: 1, releaseId: 'release', policy: { capabilities: ['fetch'], resourceProfileId: null } },
      operator: { id: 'dispatcher', operatorId: 'dispatcher', profile: 'dispatcher', revision: 1,
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
      if (state.revoked.has(token)) return new Response(null, { status: 401 });
      return Response.json({ id: `${token.slice(0, 1)}@example.test`,
        email: `${token.slice(0, 1)}@example.test`, groups: [] });
    };
    try { await run({ registry: registry as unknown as Prospective, restart, native,
      environment, selection, state }); }
    finally { globalThis.fetch = originalFetch; }
  });
}
async function enroll(registry: Prospective, user: 'a' | 'z', generation = user === 'a' ? 3 : 4) {
  return registry.activateProspectiveRenovate({ installationId: 'dispatcher-install', bucket: 'owner-bucket',
    sessionId: `${user}session01`, sessionGeneration: generation, human: claims(`${user}@example.test`), accessJwt: `${user}-jwt` });
}
function pr(registrationId: string, activatedAt: string, patch: Record<string, unknown> = {}) {
  return { registrationId, repositoryId: repoId, pullRequest: 1300, head,
    createdAt: new Date(Date.parse(activatedAt) + 1).toISOString(), activityId: 'activity-1', ...patch };
}

describe('REQ-OPERATOR-061: durable prospective activation and admission', () => {
  it.each(['old-intent', 'future-intent', 'foreign-package', 'malformed-manifest'])('REQ-OPERATOR-061: unsupported %s cannot activate a prospective current-package registration or retain its cutoff', fault => fixture(async ({ registry, selection }) => {
    const manifest = { id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion: '3' };
    if (fault === 'old-intent') manifest.intentVersion = '2';
    if (fault === 'future-intent') manifest.intentVersion = '4';
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
    const invocationJson = JSON.stringify({ repository: 'nikolanovoselec/komodo', pullRequest: observed.pullRequest });
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
      deadline: human.expiresAt * 1000, invocationJson: JSON.stringify({ repository: 'nikolanovoselec/komodo' }),
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
