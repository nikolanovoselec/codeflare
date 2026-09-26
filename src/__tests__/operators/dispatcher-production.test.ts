/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorActivity, OperatorDispatcherCapability, createOperatorIntentDigest } from '../../operators/activity';
import { driveDispatcherRuntime } from '../../operators/runtime';
import { runOperatorActivity } from '../../operators/orchestrator';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import type { DispatcherBundle } from '../../operators/distribution';
import type { Env } from '../../types';

vi.mock('../../lib/access', async original => ({ ...await original<typeof import('../../lib/access')>(),
  resolveOperatorGroupIdentity: async (human: unknown) => human,
  resolveBucketName: async () => 'owner-bucket',
  resolveSessionAccessGroup: async () => [],
  loadEnterpriseRouteConfig: async () => ({ routeCatalog: ['approved'], defaultRoute: 'approved', defaultReasoning: 'off' }),
}));
vi.mock('../../lib/aig-config', () => ({ getAigConfig: async () => ({ gatewayUrl: 'https://gateway.example.test', token: 'parent-only' }) }));

const bundle: DispatcherBundle = { schemaVersion: 1, sourceCommit: 'a'.repeat(40),
  versions: { runtime: '2.1.0', vitePlugin: '2.1.0', agents: '0.20.1' }, className: 'FlueDispatcherAgent',
  compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'], mainModule: 'index.js',
  modules: { 'index.js': { js: 'export class FlueDispatcherAgent {}' } } };
const bytes = new TextEncoder().encode(JSON.stringify(bundle));
const invocation = { repository: 'owner/repo', pullRequest: 17 };
async function digest(value: string | Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string'
    ? new TextEncoder().encode(value) : value)), b => b.toString(16).padStart(2, '0')).join('');
}

/** Instrumented SDK owner, not native Flue proof: native cases remain in loader-runtime.test.ts. */
async function fixture(test: (f: {
  activity: OperatorActivity; capability: OperatorDispatcherCapability; environment: Env;
  artifactDigest: string; settle: (id?: string, outcome?: string, error?: unknown) => void; expire: () => void;
  revoke: () => void; sent: Request[]; abortStatus: () => string | undefined;
  restart: () => OperatorActivity; loseResponse: () => void; nextAlarm: () => Promise<number | null>;
}) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  await runInDurableObject(namespace.getByName(`dispatcher-${crypto.randomUUID()}`), async (_instance, native) => {
    const activityId = `activity-${crypto.randomUUID()}`;
    const artifactDigest = await digest(bytes);
    const now = Date.now();
    const expiresAt = Math.floor(now / 1000) + 300;
    const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
      audiences: ['audience'], issuedAt: Math.floor(now / 1000) - 1, expiresAt };
    const policy = { capabilities: ['fetch', 'inference'], resourceProfileId: null };
    const selection = { controlsRevision: 1, installation: { id: 'installation', operatorId: 'operator', revision: 1,
      enabled: true, policy, configurationJson: '{}', releaseId: 'release' },
    operator: { operatorId: 'operator', profile: 'dispatcher', revision: 1, invokers: { users: [human.email], groups: [] } },
    release: { id: 'release', bundleDigest: artifactDigest, sourceCommit: bundle.sourceCommit }, manifestJson: '{}' };
    let revoked = false;
    let settlements: unknown[] = [];
    let aborted: string | undefined;
    let uncertain = false;
    const sent: Request[] = [];
    const pending: Promise<unknown>[] = [];
    let activity: OperatorActivity;
    const child = {
      _cf_initAsFacet: async () => {},
      _cf_checkRunFibersForFacet: async () => 0,
      _cf_dispatchScheduledCallback: async () => true,
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname.endsWith('/abort')) {
          aborted = (await activity.getBrowserDetail())?.executionStatus;
          return Response.json({ ok: true });
        }
        if (request.method === 'POST') return Response.json({ submissionId: 'submission-1' }, { status: 202 });
        return Response.json({ settlements });
      },
    };
    // Agent validates the native DurableObjectState brand and SQLite capability.
    // Keep that real owner while replacing only the fixture's child/interceptor seams.
    Object.defineProperties(native, {
      facets: { configurable: true, value: { get: () => child } },
      exports: { configurable: true, value: {
        OperatorDispatcherCapability: () => ({ fetch: async () => new Response() }),
        GitHubInterceptor: () => ({ fetch: async (request: Request) => {
          sent.push(request); if (uncertain) return Response.json({ error: 'lost response' }, { status: 502 });
          return Response.json({ number: 17, user: { login: 'fork-specific-bot[bot]', id: 42 }, head: { sha: 'b'.repeat(40) } });
        } }),
        LlmInterceptor: () => ({ fetch: async (request: Request) => {
          sent.push(request); if (uncertain) return Response.json({ error: 'lost response' }, { status: 502 });
          return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
        } }),
      } },
      waitUntil: { configurable: true, value: (promise: Promise<unknown>) => { pending.push(promise); } },
    });
    const context = native;
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const registry = { getManagementBundle: async () => bytes,
      resolveManagementExecution: async () => revoked ? { ok: false, reason: 'disabled' } : { ok: true, value: selection },
      admitManagement: async (input: unknown) => ({ ok: true, value: { ...input as object, admittedAt: now, selection } }),
      upsertOwnedActivity: async () => {},
    };
    const environment = { ...encryption, ENTERPRISE_MODE: 'active',
      OPERATOR_REGISTRY: { getByName: () => registry }, OPERATOR_ACTIVITY: { getByName: () => activity, idFromName: () => native.id },
      LOADER: { get: () => ({ getDurableObjectClass: () => ({}) }) },
    } as unknown as Env;
    const activityEnvironment = environment as unknown as ConstructorParameters<typeof OperatorActivity>[1];
    activity = new OperatorActivity(context, activityEnvironment);
    const invocationJson = JSON.stringify(invocation);
    const execution = await createOperatorExecutionContext({ activityId, operatorId: 'operator', artifactDigest,
      policyDigest: await digest(JSON.stringify(policy)), human, accessJwt: 'private.jwt' }, encryption);
    await activity.prepareAuthorized({ activityId, operatorId: 'operator', installationId: 'installation',
      intentDigest: await createOperatorIntentDigest('operator', activityId, invocationJson),
      expectedRevision: 1, expectedInstallationRevision: 1, expectedControlsRevision: 1,
      deadline: expiresAt * 1000, startExpiresAt: expiresAt * 1000, startVerifier: await digest('s'.repeat(43)) }, execution, invocationJson);
    expect(await activity.start('s'.repeat(43))).toEqual({ ok: true, phase: 'queued' });
    const capability = new OperatorDispatcherCapability({ props: { activityId, generation: 1 } } as unknown as ExecutionContext,
      environment as unknown as ConstructorParameters<typeof OperatorDispatcherCapability>[1]);
    try {
      await test({ activity, capability, environment, artifactDigest, sent,
        settle: (id = 'submission-1', outcome = 'completed', error?: unknown) => { settlements = [{ submissionId: id, outcome, error }]; },
        expire: () => { vi.spyOn(Date, 'now').mockReturnValue(expiresAt * 1000 + 1); },
        revoke: () => { revoked = true; },
        abortStatus: () => aborted, restart: () => (activity = new OperatorActivity(context, activityEnvironment)),
        loseResponse: () => { uncertain = true; }, nextAlarm: () => native.storage.getAlarm(),
      });
    } finally {
      await activity.cancelDrive();
      vi.restoreAllMocks();
      await Promise.allSettled(pending);
    }
  });
}
function read(operationId = 'read-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'pull-request', ...extra }) });
}
async function start(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  return driveDispatcherRuntime({ activity: f.activity, deadline: Date.now() + 25_000,
    bundle, artifactDigest: f.artifactDigest, invocation });
}

describe('REQ-OPERATOR-047/048: production Dispatcher lease and restricted effects', () => {
  it('reserves once; admission and unrelated settlement remain running; exact settlement alone permits continuation', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true, state: { status: 'running', generation: 1 } });
    expect(await start(f)).toEqual({ ok: false, reason: 'drive-active' });
    expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'waiting', checkpoint: null }))
      .toEqual({ ok: false, reason: 'invalid-update' });
    f.settle('foreign'); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
    expect(await f.activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 2 } });
    expect((await f.capability.fetch(read())).status).toBe(403);
  }));
  it('rechecks a later settlement before the bounded lease expires without caller continuation', () => fixture(async f => {
    const startedAt = Date.now();
    await start(f);
    await f.activity.reconcileDispatcherLease();
    const alarm = await f.nextAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThan(startedAt + 15_000);
    f.settle();
    vi.spyOn(Date, 'now').mockReturnValue(alarm! + 1_000);
    await f.activity.alarm();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
  }));
  it('fences failed settlement rather than granting a continuation', () => fixture(async f => {
    await start(f); f.settle('submission-1', 'failed'); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await start(f)).toEqual({ ok: false, reason: 'drive-settled' });
  }));
  it('privately reads only the bounded failed submission reason after fencing without reviving execution', () => fixture(async f => {
    await start(f);
    f.settle('submission-1', 'failed', { type: 'operation_failed', meta: { reason: 'Synthetic fixture failure' } });
    await f.activity.reconcileDispatcherLease();
    const inspection = f.activity as unknown as { inspectFailedDispatcherReason?: () => Promise<string | null> };
    expect(await inspection.inspectFailedDispatcherReason?.()).toBe('Synthetic fixture failure');
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect((await f.capability.fetch(read())).status).toBe(403);
  }));
  it('fences expired leases even when their exact settlement arrives late', () => fixture(async f => {
    await start(f); f.expire(); f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
  }));
  it('fences uncertain admission without retrying the generated child', async () => {
    let state = { generation: 1, status: 'running', checkpoint: null, result: null };
    const activity = { beginDrive: async () => ({ ok: true, state }),
      admitDispatcher: async () => { throw new Error('lost admission'); },
      interruptDrive: async () => ({ ok: true, state: state = { ...state, generation: 2, status: 'unknown' } }),
    } as unknown as OperatorActivity;
    expect(await driveDispatcherRuntime({ activity, deadline: Date.now() + 1000,
      bundle, artifactDigest: await digest(bytes), invocation })).toMatchObject({ ok: true, state: { status: 'unknown' } });
  });
  it('resumes the exact persisted lease after reconstruction without re-admission', () => fixture(async f => {
    await start(f); f.settle(); const restarted = f.restart();
    await restarted.reconcileDispatcherLease();
    expect((await restarted.getBrowserDetail())?.executionStatus).toBe('waiting');
  }));
  it('fences before signaling facet abort and rejects late settlement and warmed effects', () => fixture(async f => {
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    await f.activity.cancelDrive(); expect(f.abortStatus()).toBe('cancel-requested');
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('cancel-requested');
    expect((await f.capability.fetch(read('read-2'))).status).toBe(403);
  }));
  it.each(['expire', 'revoke'] as const)('denies %s without new protected effects', action => fixture(async f => {
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    f[action](); expect((await f.capability.fetch(read('read-2'))).status).toBe(403);
    expect(f.sent.map(r => r.url)).toEqual(['https://api.github.com/repos/owner/repo/pulls/17']);
  }));
  it('reconciles completed operation output and conflicts on changed semantics', () => fixture(async f => {
    await start(f); const first = await f.capability.fetch(read());
    expect(await (await f.capability.fetch(read())).text()).toBe(await first.text());
    expect((await f.capability.fetch(read('read-1', { resource: 'files' }))).status).toBe(409);
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it('does not replay uncertain effects and cannot commit waiting afterward', () => fixture(async f => {
    await start(f); f.loseResponse(); expect((await f.capability.fetch(read())).status).toBe(409);
    expect((await f.capability.fetch(read())).status).toBe(403);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it('routes bounded inference through the parent interceptor without forwarding child authority', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/inference', {
      method: 'POST', headers: { authorization: 'child-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'inference-1', input: { messages: [{ role: 'user', content: 'assess' }] } }),
    }));
    expect(response.status).toBe(200); expect(await response.text()).toBe('data: [DONE]\n\n');
    expect(f.sent[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(f.sent[0].headers.has('authorization')).toBe(false);
  }));
  it('denies foreign resources, unknown routes, oversized input and foreign/root scheduling while allowed reads work', () => fixture(async f => {
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    for (const request of [read('x', { repository: 'other/repo' }), read('x', { resource: 'merge' }),
      read('x', { padding: 'x'.repeat(65537) }), new Request('https://operator.internal/v1/session'),
      new Request('https://example.test/v1/dispatcher/github/read', { method: 'POST', body: '{}' })]) {
      expect((await f.capability.fetch(request)).status).toBe(403);
    }
    await expect(f.capability._cf_scheduleForFacet([{ className: 'OperatorActivity', name: 'foreign' }],
      1, 'cancelDrive')).rejects.toThrow();
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it('delegates only the pinned child wake callback and scopes cancellation to that facet', () => fixture(async f => {
    await start(f);
    const plan = await f.activity.getRuntimePlan();
    const path = [{ className: 'OperatorActivity', name: plan!.activityId },
      { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const created = await f.capability._cf_scheduleForFacet(path, 1, '__flueWakeAgentSubmissions');
    expect(await f.capability._cf_getScheduleForFacet(path, created.schedule.id)).toMatchObject({ type: 'delayed' });
    await expect(f.capability._cf_scheduleForFacet(path, 1, 'cancelDrive')).rejects.toThrow();
    await expect(f.capability._cf_getScheduleForFacet([path[0], { ...path[1], name: 'foreign' }], created.schedule.id))
      .rejects.toThrow();
    expect(await f.capability._cf_cancelScheduleForFacet(path, created.schedule.id)).toMatchObject({ ok: true });
    expect(await f.capability._cf_getScheduleForFacet(path, created.schedule.id)).toBeUndefined();
  }));
  it('admits only the activity-bound, connection-free child notifications without widening authority', () => fixture(async f => {
    await start(f);
    const plan = await f.activity.getRuntimePlan();
    const path = [{ className: 'OperatorActivity', name: plan!.activityId },
      { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const bridge = f.capability as unknown as {
      _cf_subAgentConnectionMetas(ownerPath: typeof path): Promise<unknown>;
      _cf_broadcastToSubAgent(ownerPath: typeof path, message: unknown, without?: string[]): Promise<void>;
    };
    expect(await bridge._cf_subAgentConnectionMetas(path)).toEqual([]);
    await expect(bridge._cf_broadcastToSubAgent(path, { type: 'notice' })).resolves.toBeUndefined();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    const foreign = [{ ...path[0], name: 'other-activity' }, path[1]];
    await expect(bridge._cf_subAgentConnectionMetas(foreign)).rejects.toThrow();
    await expect(bridge._cf_broadcastToSubAgent(foreign, { type: 'notice' })).rejects.toThrow();
    await expect(bridge._cf_broadcastToSubAgent(path, 'x'.repeat(64 * 1024 + 1))).rejects.toThrow();
  }));
  it('orchestrates managed Dispatcher bundles without the default entrypoint path', () => fixture(async f => {
    const plan = await f.activity.getRuntimePlan();
    await runOperatorActivity(plan!.activityId, f.environment, () => { throw new Error('default capability must not be selected'); });
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));
});
