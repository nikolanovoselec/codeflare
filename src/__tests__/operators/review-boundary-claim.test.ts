/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { OperatorActivity } from '../../operators/activity';
import { D1SessionRepository } from '../../lib/session-repository';
import { prepareOperatorActivity } from '../../operators/orchestrator';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { claimVerifiedBoundaryAction } from '../../operators/review-boundary-claim';
import webhookRoutes from '../../routes/operator-webhook';
// @ts-expect-error Workers test loader supports raw SQL fixtures.
import migration from '../../../migrations/usage/0002_runtime_sessions.sql?raw';
// @ts-expect-error Workers test loader supports raw SQL fixtures.
import boundaryMigration from '../../../migrations/usage/0004_boundary_activity.sql?raw';

const trust = vi.hoisted(() => ({ signed: true, current: true, human: true, selection: true }));
vi.mock('../../operators/boundary-action-oidc', () => ({ verifyBoundaryActionOidc: async (_token: string, expected: {
  repositoryId: number; repository: string; workflowPath: string; protectedRef: string; workflowSha: string;
  runId: number; runAttempt: number;
}) => trust.signed ? { repositoryId: expected.repositoryId, repository: expected.repository,
  eventName: 'pull_request_target', workflowRef: `${expected.repository}/${expected.workflowPath}@${expected.protectedRef}`,
  workflowSha: expected.workflowSha, runId: expected.runId, runAttempt: expected.runAttempt } : null }));
vi.mock('../../lib/github-token', () => ({ getValidGithubToken: async () => 'parent-owned-github-credential' }));
vi.mock('../../lib/access', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/access')>();
  return { ...actual, requireOperatorHumanContext: async () => {
    if (!trust.human) throw Error('Human authority revoked');
    return { human: { subject: 'owner', email: 'owner@example.test',
      issuer: 'https://access.example.test', audiences: ['aud'], issuedAt: Math.floor(Date.now() / 1000) - 10,
      expiresAt: Math.floor(Date.now() / 1000) + 300 }, accessJwt: 'sealed-access-jwt' };
  } };
});

const db = (env as unknown as { USAGE_DB: D1Database }).USAGE_DB;
const head = 'a'.repeat(40), base = 'b'.repeat(40), mergeBase = 'c'.repeat(40);
const workflowSha = 'd'.repeat(40), workflowSource = 'name: Boundary Reviews\non: pull_request_target\njobs: {}\n';
const actionDigest = '5d25cbe537cab5e78efad44b51b472c4e278ca6510342b3eb34914dc6ee4e95d';
const request = { repositoryId: 138, pullRequest: 34, head, base, mergeBase, runId: 87, runAttempt: 1 };
const session = { bucket: 'owner-bucket', sessionId: 'session01', generation: 1 };
const protectedEnv = { ...env, ENCRYPTION_KEY: btoa('k'.repeat(32)) };

beforeAll(async () => {
  for (const sql of migration.split(';').map((part: string) => part.trim()).filter(Boolean)) {
    await db.prepare(sql).run();
  }
  for (const sql of boundaryMigration.split(';').map((part: string) => part.trim()).filter(Boolean)) {
    await db.prepare(sql).run();
  }
});
beforeEach(async () => {
  trust.signed = trust.current = trust.human = trust.selection = true;
  await db.prepare('DELETE FROM runtime_sessions').run();
  await db.prepare("UPDATE session_cutover SET state='complete' WHERE id=1").run();
  await db.prepare(`INSERT INTO runtime_sessions (owner_key,session_id,name,created_at,last_accessed_at,workspace,
    terminal_mode,lifecycle_state,lifecycle_generation,response_revision,observation_sequence,editor_ready,
    editor_ready_error,transitioned_at) VALUES ('owner-bucket','session01','Review','2027-01-01','2027-01-01',
    'terminal','classic','running',1,0,-1,0,0,'2027-01-01')`).run();
});

async function scenario(run: (fixture: {
  registry: OperatorRegistry; activity: OperatorActivity; repo: D1SessionRepository;
  claim: (change?: Partial<typeof request>) => Promise<unknown>; activityId: string;
  startCapability: string;
}) => Promise<void>) {
  const registryNamespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  const activityNamespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  await runInDurableObject(registryNamespace.get(registryNamespace.newUniqueId()), async (_instance, registryCtx) => {
    const registry = new OperatorRegistry(registryCtx, protectedEnv);
    const policy = { capabilities: [], resourceProfileId: null };
    expect((await registry.setManagementControls({ revision: 0, managers: { users: [], groups: [] },
      ceiling: { capabilities: [], resourceProfileIds: [] }, boundaryActions: [{ repositoryId: 138,
        installationId: 'review-install', workflowId: 531, workflowPath: '.github/workflows/boundary-reviews.yml',
        protectedRef: 'refs/heads/main', workflowDigest: actionDigest, events: ['pull_request_target'] }],
    }, { email: 'admin@example.test', expiresAt: Date.now() + 300_000 })).ok).toBe(true);
    registryCtx.storage.sql.exec('INSERT INTO operator_catalog VALUES(?,?,?,?,?,?)', 'review-operator', 'conductor',
      'internal', 1, 'review-operator', JSON.stringify({ id: 'review-operator', revision: 1,
        sourceRevision: 1, profile: 'conductor', realm: 'internal', repositoryId: 138,
        repositoryUrl: 'https://github.com/owner/repo', managers: { users: [], groups: [] },
        invokers: { users: ['owner@example.test'], groups: [] }, policy,
        approvedWorkflow: { id: 531, ref: 'refs/heads/main' } }));
    registryCtx.storage.sql.exec('INSERT INTO operator_releases VALUES(?,?,?,?)', 'review-release', 'review-operator',
      JSON.stringify({ id: 'review-release', bundleDigest: 'e'.repeat(64), approved: true }), '{}');
    registryCtx.storage.sql.exec('INSERT INTO operator_installations VALUES(?,?,?,?,?)', 'review-install', 'review-operator',
      'review-install', 1, JSON.stringify({ id: 'review-install', operatorId: 'review-operator',
        name: 'review-install', releaseId: 'review-release', revision: 1, enabled: true, policy,
        configurationJson: '{}', approvedSourceRevision: 1 }));
    const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
      audiences: ['aud'], issuedAt: Math.floor(Date.now() / 1000) - 10,
      expiresAt: Math.floor(Date.now() / 1000) + 300 };
    const reservation = await registry.reserveBoundaryPreparation({ repositoryId: 138, pullRequest: 34,
      contextDigest: 'f'.repeat(64), ownerKey: await operatorOwnerKey(human), installationId: 'review-install',
      deadline: Date.now() + 300_000, controlsRevision: 1, installationRevision: 1, operatorRevision: 1,
      releaseId: 'review-release', bundleDigest: 'e'.repeat(64), workflowId: 531, workflowDigest: actionDigest,
      session, operatorId: 'review-operator', revision: { head, base, mergeBase } });
    if (!reservation.ok) throw Error('Expected real Registry preparation');
    const activityId = reservation.value.activityId;
    const repo = new D1SessionRepository(db);
    await runInDurableObject(activityNamespace.get(activityNamespace.newUniqueId()), async (_inner, activityCtx) => {
      const activityEnv = { ...protectedEnv, OPERATOR_REGISTRY: { getByName: () => registry } };
      const activity = new OperatorActivity(activityCtx,
        activityEnv as unknown as ConstructorParameters<typeof OperatorActivity>[1]);
      const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'boundary-reviews',
        activityId, operatorId: 'review-operator', runId: activityId,
        source: { kind: 'session', reference: 'owner/repo' },
        revision: { reference: head, digest: 'f'.repeat(64) }, inputDigest: 'd'.repeat(64), input: {},
        attachments: [], resources: { inference: null, session: null, storage: { scopeId: activityId } } };
      const binding = { repositoryId: 138, pullRequest: 34, contextDigest: 'f'.repeat(64), session };
      const prepared = await prepareOperatorActivity({ installationId: 'review-install', invocation },
        { human, accessJwt: 'sealed-access-jwt' }, { ...activityEnv,
          OPERATOR_ACTIVITY: { getByName: () => activity },
        } as never, { activityId, expectedManagement: { controlsRevision: 1, installationRevision: 1,
          operatorRevision: 1, releaseId: 'review-release', bundleDigest: 'e'.repeat(64) }, boundary: binding });
      if (!await registry.markBoundaryPrepared(138, 34, activityId, 'f'.repeat(64),
        prepared.startCapability, prepared.startExpiresAt)) throw Error('Expected exact prepared handoff');
      const container = { openReviewHuman: async () => {
        if (!trust.human) throw Error('Session authority revoked');
        return { human, accessJwt: 'sealed-access-jwt' };
      } };
      const github = async (input: RequestInfo | URL): Promise<Response> => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        const revision = trust.current ? head : '9'.repeat(40);
        if (path === '/repos/owner/repo') return Response.json({ id: 138, full_name: 'owner/repo', default_branch: 'main' });
        if (path.endsWith('/pulls/34')) return Response.json({ number: 34, state: 'open',
          head: { sha: revision, ref: 'feature', repo: { id: 138 } },
          base: { sha: base, ref: 'main', repo: { id: 138 } } });
        if (path.endsWith('/pulls')) return Response.json([{ number: 34 }]);
        if (path.endsWith(`/commits/${head}/pulls`)) return Response.json([{ number: 34, state: 'open',
          head: { sha: revision } }]);
        if (path.includes('/compare/')) return Response.json({ merge_base_commit: { sha: mergeBase } });
        if (path.endsWith('/actions/runs/87') || path.endsWith('/actions/runs/87/attempts/1')) {
          return Response.json({ id: 87, run_attempt: 1, workflow_id: 531, event: 'pull_request_target',
            path: '.github/workflows/boundary-reviews.yml', head_sha: '7'.repeat(40),
            repository: { id: 138 }, pull_requests: [{ number: 34 }] });
        }
        if (path.endsWith('/actions/workflows/531')) return Response.json({ id: 531,
          path: '.github/workflows/boundary-reviews.yml', state: 'active' });
        if (path.endsWith('/branches/main')) return Response.json({ name: 'main', protected: trust.selection,
          commit: { sha: workflowSha } });
        if (path.endsWith('/contents/.github/workflows/boundary-reviews.yml')) {
          return Response.json({ encoding: 'base64', content: btoa(workflowSource) });
        }
        return new Response('unknown', { status: 404 });
      };
      vi.spyOn(globalThis, 'fetch').mockImplementation(github as typeof fetch);
      const actionEnv = { ...activityEnv, OPERATOR_ACTIVITY: { getByName: () => activity },
        CONTAINER: { getByName: () => container }, USAGE_DB: db,
        KV: { get: async (key: string) => key === 'setup:custom_domain' ? 'enterprise.example.test' : null },
      } as never;
      const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-')
        .replace(/\//g, '_').replace(/=+$/, '');
      const signedFixture = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'test' })}.${encode({
        repository: 'owner/repo', workflow_sha: workflowSha,
      })}.signature`;
      const claim = (change: Partial<typeof request> = {}) => claimVerifiedBoundaryAction(actionEnv,
        signedFixture, { ...request, ...change });
      try { await run({ registry, activity, repo, claim, activityId, startCapability: prepared.startCapability }); }
      finally { vi.restoreAllMocks(); }
    });
  });
}

describe('REQ-OPERATOR-053: real prepared Registry and Activity owners at protected Action claim', () => {
  it('releases only the successfully consumed terminal result for the next review on this session', async () => {
    const repository = new D1SessionRepository(db);
    expect(await repository.recordBoundaryActionStart(session.bucket, session.sessionId, 1, 'review-activity')).toBe(true);
    const activity = { redeemWebhookResult: async () => ({ ok: true, terminal: true, status: 'completed' }),
      getBoundaryStartBinding: async () => ({ repositoryId: 138, pullRequest: 34,
        contextDigest: 'f'.repeat(64), session }) };
    const response = await webhookRoutes.fetch(new Request(
      'https://enterprise.example.test/operator-webhook/v1/activities/review-activity/result', {
        method: 'POST', headers: { authorization: `Bearer ${'r'.repeat(43)}` },
      }), { ENTERPRISE_MODE: 'active', OPERATOR_ACTIVITY: { getByName: () => activity }, USAGE_DB: db } as never);
    expect(response.status).toBe(200);
    expect(await repository.recordBoundaryActionStart(session.bucket, session.sessionId, 1, 'next-review')).toBe(true);
  });
  it('claims once for the exact current run, then only the Action webhook start admits the bound activity', () => scenario(async f => {
    expect(await f.activity.start(f.startCapability)).toMatchObject({ ok: false });
    expect(await f.activity.startWebhook(f.startCapability)).toMatchObject({ ok: false });
    expect(await f.claim()).toMatchObject({ activityId: f.activityId, startCapability: f.startCapability,
      repositoryId: 138, pullRequest: 34, head, base, mergeBase, workflowId: 531, runId: 87, runAttempt: 1 });
    expect(await f.claim()).not.toMatchObject({ startCapability: f.startCapability });
    expect(await f.activity.start(f.startCapability)).toMatchObject({ ok: false });
    expect(await f.activity.startWebhook(f.startCapability)).toMatchObject({ ok: true, phase: 'queued' });
    expect(await f.activity.startWebhook(f.startCapability)).toMatchObject({ ok: false });
  }));

  it('denies wrong OIDC, moved PR, changed protected binding, revoked human and wrong run before consuming the handoff', () => scenario(async f => {
    for (const [key, value] of [['signed', false], ['current', false], ['selection', false], ['human', false]] as const) {
      trust[key] = value;
      expect(await f.claim()).not.toMatchObject({ startCapability: f.startCapability });
      trust[key] = true;
    }
    for (const change of [{ runId: 88 }, { runAttempt: 2 }, { head: '9'.repeat(40) },
      { base: '8'.repeat(40) }, { mergeBase: '7'.repeat(40) }]) {
      expect(await f.claim(change)).not.toMatchObject({ startCapability: f.startCapability });
    }
    expect(await f.activity.getAdmission()).toMatchObject({ phase: 'prepared' });
    expect(await f.claim()).toMatchObject({ startCapability: f.startCapability });
  }));

  it('a changed protected binding remains non-green even if the old handoff was prepared', () => scenario(async f => {
    const controls = await f.registry.getManagementControls();
    expect((await f.registry.setManagementControls({ ...controls, boundaryActions: [{
      ...controls.boundaryActions![0], workflowDigest: '8'.repeat(64),
    }] }, { email: 'admin@example.test', expiresAt: Date.now() + 300_000 })).ok).toBe(true);
    expect(await f.claim()).not.toMatchObject({ startCapability: f.startCapability });
    expect(await f.activity.getAdmission()).toMatchObject({ phase: 'prepared' });
  }));

  it('a lost accepted Registry claim never redelivers the start capability on retry', () => scenario(async f => {
    const original = f.registry.claimBoundaryPreparation.bind(f.registry);
    const lost = vi.spyOn(f.registry, 'claimBoundaryPreparation').mockImplementation(async input => {
      await original(input);
      throw Error('accepted claim response lost');
    });
    expect(await f.claim()).not.toMatchObject({ startCapability: f.startCapability });
    lost.mockRestore();
    expect(await f.claim()).not.toMatchObject({ startCapability: f.startCapability });
    expect(await f.activity.getAdmission()).toMatchObject({ phase: 'prepared' });
  }));

  it('Stop wins before an Action claim; the old generation cannot consume or start', () => scenario(async f => {
    const stopped = await f.repo.claimStop(session.bucket, session.sessionId, 'stop-before', new Date().toISOString());
    expect(stopped?.lifecycleState).toBe('stopping');
    expect(await f.claim()).not.toMatchObject({ startCapability: f.startCapability });
    expect(await f.activity.startWebhook(f.startCapability)).toMatchObject({ ok: false });
    expect(await f.repo.confirmStopped(session.bucket, session.sessionId, 1, 'stop-before', new Date().toISOString()))
      .toBe(true);
  }));

  it('a replacement session generation cannot adopt the earlier human-bound handoff', () => scenario(async f => {
    expect(await f.repo.claimStop(session.bucket, session.sessionId, 'stop-old', new Date().toISOString()))
      .toMatchObject({ lifecycleState: 'stopping' });
    expect(await f.repo.confirmStopped(session.bucket, session.sessionId, 1, 'stop-old', new Date().toISOString()))
      .toBe(true);
    expect((await f.repo.start(session.bucket, session.sessionId, new Date().toISOString()))?.lifecycleGeneration)
      .toBe(2);
    expect(await f.claim()).not.toMatchObject({ startCapability: f.startCapability });
    expect(await f.activity.startWebhook(f.startCapability)).toMatchObject({ ok: false });
  }));

  it('Stop fences a suspended Registry claim before it can hand authority to the Action', () => scenario(async f => {
    const original = f.registry.claimBoundaryPreparation.bind(f.registry);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.registry, 'claimBoundaryPreparation').mockImplementation(async input => {
      entered(); await gate; return original(input);
    });
    const pending = f.claim();
    await reached;
    expect(await f.repo.claimStop(session.bucket, session.sessionId, 'stop-during', new Date().toISOString()))
      .toMatchObject({ boundaryActivityId: f.activityId, lifecycleState: 'stopping' });
    expect(await f.activity.cancelBoundaryStart({ repositoryId: 138, pullRequest: 34,
      contextDigest: 'f'.repeat(64), session })).toMatchObject({ ok: true });
    expect(await f.repo.acknowledgeBoundaryCancellation(session.bucket, session.sessionId, 1, f.activityId))
      .toBe(true);
    expect(await f.repo.confirmStopped(session.bucket, session.sessionId, 1, 'stop-during', new Date().toISOString()))
      .toBe(true);
    release();
    expect(await pending).not.toMatchObject({ startCapability: f.startCapability });
    expect(await f.activity.startWebhook(f.startCapability)).toMatchObject({ ok: false });
    expect(await f.activity.getRuntimePlan()).toBeNull();
  }));

  it('Stop cancellation wins over a delayed Registry admission response before the final Activity queue', () => scenario(async f => {
    expect(await f.claim()).toMatchObject({ activityId: f.activityId });
    const original = f.registry.admitManagement.bind(f.registry);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.registry, 'admitManagement').mockImplementation(async input => {
      entered(); await gate; return original(input);
    });
    const pendingStart = f.activity.startWebhook(f.startCapability);
    await reached;
    expect(await f.repo.claimStop(session.bucket, session.sessionId, 'stop-admission', new Date().toISOString()))
      .toMatchObject({ boundaryActivityId: f.activityId, lifecycleState: 'stopping' });
    expect(await f.activity.cancelBoundaryStart({ repositoryId: 138, pullRequest: 34,
      contextDigest: 'f'.repeat(64), session })).toMatchObject({ ok: true });
    expect(await f.repo.acknowledgeBoundaryCancellation(session.bucket, session.sessionId, 1, f.activityId))
      .toBe(true);
    expect(await f.repo.confirmStopped(session.bucket, session.sessionId, 1, 'stop-admission', new Date().toISOString()))
      .toBe(true);
    release();
    expect(await pendingStart).toMatchObject({ ok: false });
    expect(await f.activity.getRuntimePlan()).toBeNull();
  }));
});
