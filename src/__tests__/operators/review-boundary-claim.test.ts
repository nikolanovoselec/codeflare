/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { OperatorActivity } from '../../operators/activity';
import { D1SessionRepository } from '../../lib/session-repository';
import { prepareOperatorActivity } from '../../operators/orchestrator';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { claimVerifiedBoundaryAction, operateBoundaryPublication, verifyCurrentClaimedBoundaryPacket,
  type BoundaryPublicationRequest } from '../../operators/review-boundary-claim';
import webhookRoutes from '../../routes/operator-webhook';
import { fencePendingBoundaryStart } from '../../routes/session/boundary-stop';
// @ts-expect-error Workers test loader supports raw SQL fixtures.
import migration from '../../../migrations/usage/0002_runtime_sessions.sql?raw';
// @ts-expect-error Workers test loader supports raw SQL fixtures.
import boundaryMigration from '../../../migrations/usage/0004_boundary_activity.sql?raw';

const trust = vi.hoisted(() => ({ signed: true, current: true, human: true,
  selection: true, workflowRevision: 'd'.repeat(40) }));
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
const protectedEnv = { ...env, ENCRYPTION_KEY: btoa('k'.repeat(32)), ENTERPRISE_MODE: 'active' as const };

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
  trust.workflowRevision = 'd'.repeat(40);
  await db.prepare('DELETE FROM runtime_sessions').run();
  await db.prepare("UPDATE session_cutover SET state='complete' WHERE id=1").run();
  await db.prepare(`INSERT INTO runtime_sessions (owner_key,session_id,name,created_at,last_accessed_at,workspace,
    terminal_mode,lifecycle_state,lifecycle_generation,response_revision,observation_sequence,editor_ready,
    editor_ready_error,transitioned_at) VALUES ('owner-bucket','session01','Review','2027-01-01','2027-01-01',
    'terminal','classic','running',1,0,-1,0,0,'2027-01-01')`).run();
});

async function scenario(run: (fixture: {
  registry: OperatorRegistry; activity: OperatorActivity; repo: D1SessionRepository;
  claim: (change?: Partial<typeof request>) => Promise<unknown>;
  publish: (change?: Partial<BoundaryPublicationRequest>) => Promise<unknown>;
  packetCurrent: () => Promise<boolean>;
  expireBoundary: () => Promise<void>; activityId: string; startCapability: string; rehydrate: () => OperatorActivity;
}) => Promise<void>) {
  const registryNamespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  const activityNamespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  const registryName = `boundary-${crypto.randomUUID()}`;
  const registryStub = registryNamespace.getByName(registryName);
  let activityId!: string;
  let human!: { subject: string; email: string; issuer: string; audiences: string[];
    issuedAt: number; expiresAt: number };
  await runInDurableObject(registryStub, async (_instance, registryCtx) => {
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
    human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
      audiences: ['aud'], issuedAt: Math.floor(Date.now() / 1000) - 10,
      expiresAt: Math.floor(Date.now() / 1000) + 300 };
    const reservation = await registry.reserveBoundaryPreparation({ repositoryId: 138, pullRequest: 34,
      contextDigest: 'f'.repeat(64), ownerKey: await operatorOwnerKey(human), installationId: 'review-install',
      deadline: Date.now() + 300_000, controlsRevision: 1, installationRevision: 1, operatorRevision: 1,
      releaseId: 'review-release', bundleDigest: 'e'.repeat(64), workflowId: 531, workflowDigest: actionDigest,
      session, operatorId: 'review-operator', revision: { head, base, mergeBase } });
    if (!reservation.ok) throw Error('Expected real Registry preparation');
    activityId = reservation.value.activityId;
  });
  // Reacquire the same owner by name in the calling context; neither a stub nor storage is shared across DOs.
  const inRegistry = <T>(call: (owner: OperatorRegistry) => Promise<T>) =>
    runInDurableObject(registryNamespace.getByName(registryName), (_instance, registryCtx) =>
      call(new OperatorRegistry(registryCtx, protectedEnv)));
  const registryOwner = {
    resolveManagementExecution: (id: string) => inRegistry(owner => owner.resolveManagementExecution(id)),
    getBoundaryStartGuard: (id: string) => inRegistry(owner => owner.getBoundaryStartGuard(id)),
    getBoundaryPublicationGuard: (id: string) => inRegistry(owner => owner.getBoundaryPublicationGuard(id)),
    admitManagement: (input: Parameters<OperatorRegistry['admitManagement']>[0]) =>
      inRegistry(owner => owner.admitManagement(input)),
    markBoundaryPrepared: (...args: Parameters<OperatorRegistry['markBoundaryPrepared']>) =>
      inRegistry(owner => owner.markBoundaryPrepared(...args)),
    reserveBoundaryPreparation: (input: Parameters<OperatorRegistry['reserveBoundaryPreparation']>[0]) =>
      inRegistry(owner => owner.reserveBoundaryPreparation(input)),
    claimBoundaryPreparation: (input: Parameters<OperatorRegistry['claimBoundaryPreparation']>[0]) =>
      inRegistry(owner => owner.claimBoundaryPreparation(input)),
    getBoundaryPreparation: (repositoryId: number, pullRequest: number) =>
      inRegistry(owner => owner.getBoundaryPreparation(repositoryId, pullRequest)),
    getBoundaryAction: (repositoryId: number) => inRegistry(owner => owner.getBoundaryAction(repositoryId)),
    getManagementControls: () => inRegistry(owner => owner.getManagementControls()),
    setManagementControls: (...args: Parameters<OperatorRegistry['setManagementControls']>) =>
      inRegistry(owner => owner.setManagementControls(...args)),
    upsertOwnedActivity: (...args: Parameters<OperatorRegistry['upsertOwnedActivity']>) =>
      inRegistry(owner => owner.upsertOwnedActivity(...args)),
    beginBoundaryPublication: (input: Parameters<OperatorRegistry['beginBoundaryPublication']>[0]) =>
      inRegistry(owner => owner.beginBoundaryPublication(input)),
    completeBoundaryPublication: (input: Parameters<OperatorRegistry['completeBoundaryPublication']>[0]) =>
      inRegistry(owner => owner.completeBoundaryPublication(input)),
    getBoundaryPublication: (input: Parameters<OperatorRegistry['getBoundaryPublication']>[0]) =>
      inRegistry(owner => owner.getBoundaryPublication(input)),
  } as unknown as OperatorRegistry;
  const repo = new D1SessionRepository(db);
  await runInDurableObject(activityNamespace.get(activityNamespace.newUniqueId()), async (_inner, activityCtx) => {
      const activityEnv = { ...protectedEnv, OPERATOR_REGISTRY: { getByName: () => registryOwner } };
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
      if (!await registryOwner.markBoundaryPrepared(138, 34, activityId, 'f'.repeat(64),
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
          commit: { sha: trust.workflowRevision } });
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
      const publish = (change: Partial<BoundaryPublicationRequest> = {}) => operateBoundaryPublication(actionEnv,
        signedFixture, { ...request, workflowId: 531, activityId, contextDigest: 'f'.repeat(64),
          sessionGeneration: 1, activityGeneration: 2, effect: 'check', digest: 'e'.repeat(64),
          operation: 'begin', ...change });
      const expireBoundary = () => runInDurableObject(registryNamespace.getByName(registryName), (_owner, ctx) => {
        ctx.storage.sql.exec(`UPDATE operator_boundary_preparations SET data=json_set(data,'$.deadline',?)
          WHERE repository_id=? AND pull_request=?`, Date.now() - 1, 138, 34);
      });
      try { await run({ registry: registryOwner, activity, repo, claim, publish,
        packetCurrent: () => verifyCurrentClaimedBoundaryPacket(actionEnv, activityId, 'owner/repo'), expireBoundary,
        activityId, startCapability: prepared.startCapability,
        rehydrate: () => new OperatorActivity(activityCtx, activityEnv as ConstructorParameters<typeof OperatorActivity>[1]) }); }
      finally { vi.restoreAllMocks(); }
  });
}

// Packet identity is immutable across drives; the parent supplies the captured drive generation.
const packetBytes = new TextEncoder().encode('{"round":"review"}');
const packetDigest = 'ce8f9bff099c3431037f6a3908ddcabfe4bd73af1a66198f44edd1cf13a4156e';
const packet = { preparationId: 'round-1', lane: 'security', name: 'packet.json',
  mediaType: 'application/json', locator: 'packet-1', size: packetBytes.length,
  sha256: packetDigest, bytes: packetBytes };

describe('REQ-OPERATOR-050/052/053/054: Activity-owned approved packet preparation', () => {
  it('rechecks the claimed Action and exact live PR before authorizing parent packet I/O', () => scenario(async f => {
    expect(await f.packetCurrent()).toBe(false);
    await f.claim();
    expect(await f.packetCurrent()).toBe(true);
    trust.current = false;
    expect(await f.packetCurrent()).toBe(false);
    trust.current = true;
    trust.selection = false;
    expect(await f.packetCurrent()).toBe(false);
    trust.selection = true;
    trust.workflowRevision = 'f'.repeat(40);
    expect(await f.packetCurrent()).toBe(false);
    trust.workflowRevision = workflowSha;
    await f.expireBoundary();
    expect(await f.packetCurrent()).toBe(false);
  }));
  it('denies packet preparation before Action claim and preserves the admitted projection after Activity reconstruction', () => scenario(async f => {
    expect(await f.activity.saveApprovedPacketAttachment({ ...packet, driveGeneration: 1 })).toMatchObject({ ok: false });
    await f.claim();
    expect(await f.activity.startWebhook(f.startCapability)).toMatchObject({ ok: true });
    expect(await f.activity.beginDrive()).toMatchObject({ ok: true });
    const saved = await f.activity.saveApprovedPacketAttachment({ ...packet, driveGeneration: 1 });
    expect(saved).toMatchObject({ ok: true, preparationId: 'round-1', attachment: {
      name: 'packet.json', locator: 'packet-1', size: packetBytes.length, sha256: packetDigest } });
    expect(saved).not.toHaveProperty('generation');
    expect(await f.rehydrate().readApprovedPacketAttachments()).toMatchObject({ files: [saved.attachment] });
  }));

  it('replays the exact identity across waiting and a later drive but rejects changed bytes and conflicting lane', () => scenario(async f => {
    await f.claim();
    await f.activity.startWebhook(f.startCapability);
    await f.activity.beginDrive();
    const first = await f.activity.saveApprovedPacketAttachment({ ...packet, driveGeneration: 1 });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw Error('Expected accepted packet');
    expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'waiting',
      checkpoint: { stage: 'packet', contextDigest: 'f'.repeat(64), attachments: [
        { ...first.attachment, locator: 'substituted' },
      ] } })).toMatchObject({ ok: false });
    expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'waiting',
      checkpoint: { stage: 'packet', contextDigest: 'f'.repeat(64), attachments: [first.attachment] } }))
      .toMatchObject({ ok: true });
    expect(await f.activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 2 } });
    expect(await f.activity.saveApprovedPacketAttachment({ ...packet, driveGeneration: 1 })).toMatchObject({ ok: false });
    expect(await f.activity.saveApprovedPacketAttachment({ ...packet, driveGeneration: 2 })).toEqual(first);
    for (const altered of [
      { ...packet, driveGeneration: 2, bytes: new TextEncoder().encode('different bytes') },
      { ...packet, driveGeneration: 2, preparationId: 'round-2' },
      { ...packet, driveGeneration: 2, lane: 'contract' },
      { ...packet, driveGeneration: 2, locator: 'packet-2' },
    ]) expect(await f.activity.saveApprovedPacketAttachment(altered)).toMatchObject({ ok: false });
    expect(await f.activity.readApprovedPacketAttachments()).toMatchObject({ files: [first.attachment] });
  }));

  it('does not replay a packet when the signed Action identity changes with the same PR revision', () => scenario(async f => {
    await f.claim();
    await f.activity.startWebhook(f.startCapability);
    await f.activity.beginDrive();
    const accepted = await f.activity.saveApprovedPacketAttachment({ ...packet, driveGeneration: 1 });
    expect(accepted).toMatchObject({ ok: true });
    const original = f.registry.getBoundaryStartGuard.bind(f.registry);
    vi.spyOn(f.registry, 'getBoundaryStartGuard').mockImplementation(async id => {
      const guard = await original(id);
      return guard?.claimed ? { ...guard, workflowSha: 'a'.repeat(40) } : guard;
    });
    expect(await f.activity.readApprovedPacketAttachments()).toMatchObject({ files: [] });
    expect(await f.activity.saveApprovedPacketAttachment({ ...packet, driveGeneration: 1 }))
      .toMatchObject({ ok: false });
  }));

  it('freezes the accepted attachment set at the owned session reservation', () => scenario(async f => {
    await f.claim();
    await f.activity.startWebhook(f.startCapability);
    await f.activity.beginDrive();
    expect(await f.activity.saveApprovedPacketAttachment({ ...packet, driveGeneration: 1 })).toMatchObject({ ok: true });
    const plan = await f.activity.getRuntimePlan();
    if (!plan) throw Error('Expected admitted boundary plan');
    const attachments = await f.activity.readApprovedPacketAttachments();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
      JSON.stringify({ invocationJson: plan.invocationJson, attachments }))));
    const requestDigest = Array.from(hash).map(byte => byte.toString(16).padStart(2, '0')).join('');
    const ownerSession = { schemaVersion: 1, requestId: 'packet-session', requestDigest,
      activityId: f.activityId, ownerBucket: 'owner-bucket', sessionId: 'review-session', status: 'reserved',
      profile: { schemaVersion: 1, activityId: f.activityId, operatorId: 'review-operator',
        sessionId: 'review-session', ownerBucket: 'owner-bucket', policyDigest: 'e'.repeat(64),
        deadline: Date.now() + 60_000, outputPrefix: 'Operators/',
        human: { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test/', audiences: ['aud'] },
        policy: { schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
          storage: { readPrefixes: ['Operators/'], writePrefixes: ['Operators/'] },
          inference: { routeIds: ['route'], defaultRouteId: 'route', reasoningLevels: ['off'],
            defaultReasoningLevel: 'off', inheritUserDefaults: false } },
        jwtPolicy: { mode: 'off', destinations: [] },
        piProfile: { provider: 'codeflare-gateway', model: 'route', thinkingLevel: 'off',
          systemPrompt: 'fixed', tools: ['write'] },
      },
    };
    const second = { ...packet, driveGeneration: 1, preparationId: 'round-2', lane: 'contract',
      name: 'contract.json', locator: 'packet-2' };
    const [reservation, added] = await Promise.all([
      f.activity.saveOwnedSession(ownerSession), f.activity.saveApprovedPacketAttachment(second),
    ]);
    expect(reservation.ok && added.ok).toBe(false);
    if (reservation.ok) {
      expect(await f.activity.readApprovedPacketAttachments()).toMatchObject({ files: [{ name: 'packet.json' }] });
      expect(await f.activity.saveApprovedPacketAttachment(second)).toMatchObject({ ok: false });
    } else {
      expect(added.ok).toBe(true);
      expect(await f.activity.readApprovedPacketAttachments()).toMatchObject({ files: [
        { name: 'packet.json' }, { name: 'contract.json' },
      ] });
      expect(await f.activity.saveOwnedSession(ownerSession)).toMatchObject({ ok: false });
    }
  }));

  it('denies expired, stopped and unclaimed source generations rather than accepting a packet', () => scenario(async f => {
    await f.claim();
    await f.activity.startWebhook(f.startCapability);
    await f.activity.beginDrive();
    expect(await f.activity.saveApprovedPacketAttachment({ ...packet, driveGeneration: 999 })).toMatchObject({ ok: false });
    await f.expireBoundary();
    expect(await f.activity.saveApprovedPacketAttachment({ ...packet, driveGeneration: 1 })).toMatchObject({ ok: false });
    expect(await f.activity.readApprovedPacketAttachments()).toMatchObject({ files: [] });
  }));
  it('REQ-OPERATOR-054: Stop fences packet preparation for the claimed activity', () => scenario(async f => {
    await f.claim();
    await f.activity.startWebhook(f.startCapability);
    await f.activity.beginDrive();
    expect(await f.repo.claimStop(session.bucket, session.sessionId, 'stop-packet', new Date().toISOString(), 1)).toBeTruthy();
    expect(await f.activity.saveApprovedPacketAttachment({ ...packet, driveGeneration: 1 })).toMatchObject({ ok: false });
  }));
});

describe('REQ-OPERATOR-054: real prepared Registry and Activity owners at protected Action claim', () => {
  it('REQ-OPERATOR-053: successful completed-result consumption releases the pending Activity', async () => {
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
      repositoryId: 138, pullRequest: 34, head, base, mergeBase, workflowId: 531, runId: 87, runAttempt: 1,
      generation: 1, contextDigest: 'f'.repeat(64) });
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

  it('REQ-OPERATOR-055: Activity publishes only non-driving collected terminal generation metadata', () => scenario(async f => {
    expect(await f.activity.getBoundaryPublicationState(f.activityId)).toBeNull();
    expect(await f.claim()).toMatchObject({ activityId: f.activityId });
    const started = await f.activity.startWebhook(f.startCapability);
    if (!started.ok) throw Error('Expected Action-started activity');
    expect(await f.activity.getBoundaryPublicationState(f.activityId)).toBeNull();
    expect(await f.activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 1 } });
    expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { status: 'complete', reports: ['original-private-bytes'] } })).toMatchObject({ ok: true });
    expect(await f.activity.getBoundaryPublicationState(f.activityId))
      .toMatchObject({ generation: 1, status: 'completed', collected: false });
    expect(await f.activity.redeemWebhookResult(started.readCapability)).toMatchObject({ ok: true, terminal: true });
    const metadata = await f.activity.getBoundaryPublicationState(f.activityId);
    expect(metadata).toMatchObject({ generation: 1, status: 'completed', collected: true,
      binding: { repositoryId: 138, pullRequest: 34, contextDigest: 'f'.repeat(64), session } });
    expect(JSON.stringify(metadata)).not.toContain('original-private-bytes');
    expect(await f.activity.getBoundaryPublicationState('foreign-activity')).toBeNull();
    expect(await f.publish({ activityGeneration: 1 })).toMatchObject({ status: 'new' });
    expect(await f.publish({ activityGeneration: 1 })).toMatchObject({ status: 'pending' });
  }));

  it('REQ-OPERATOR-055: protected run and collected terminal drive alone reach the PR journal', () => scenario(async f => {
    expect(await f.publish()).toMatchObject({ status: 'stale' });
    expect(await f.claim()).toMatchObject({ activityId: f.activityId });
    expect(await f.publish()).toMatchObject({ status: 'stale' });
    vi.spyOn(f.activity, 'getBoundaryPublicationState').mockResolvedValue({
      binding: { repositoryId: 138, pullRequest: 34, contextDigest: 'f'.repeat(64), session },
      generation: 2, status: 'completed', collected: true,
    });
    trust.signed = false;
    expect(await f.publish()).toMatchObject({ status: 'denied' });
    trust.signed = true;
    trust.selection = false;
    expect(await f.publish()).toMatchObject({ status: 'stale' });
    trust.selection = true;
    trust.current = false;
    expect(await f.publish()).toMatchObject({ status: 'stale' });
    trust.current = true;
    expect(await f.publish({ runAttempt: 2 })).not.toMatchObject({ status: 'new' });
    expect(await f.publish({ repositoryId: 139 })).not.toMatchObject({ status: 'new' });
    expect(await f.publish({ activityGeneration: 3 })).toMatchObject({ status: 'stale' });
    expect(await f.publish()).toMatchObject({ status: 'new' });
    expect(await f.publish()).toMatchObject({ status: 'pending' });
    expect(await f.publish({ operation: 'complete', externalId: 71 }))
      .toMatchObject({ status: 'published', externalId: 71 });
    expect(await f.publish({ operation: 'read' })).toMatchObject({ status: 'published', externalId: 71 });
    await f.expireBoundary();
    expect(await f.registry.getBoundaryStartGuard(f.activityId)).toMatchObject({ claimed: false });
    expect(await f.publish({ operation: 'read' })).toMatchObject({ status: 'published', externalId: 71 });
    expect(await f.publish({ effect: 'comment', digest: '4'.repeat(64) })).toMatchObject({ status: 'stale' });
    const old = await f.registry.getBoundaryPreparation(138, 34);
    if (!old) throw Error('Expected earlier PR reservation');
    const { activityId: _activityId, phase: _phase, ...reservation } = old;
    expect(await f.registry.reserveBoundaryPreparation({ ...reservation,
      deadline: Date.now() + 300_000, contextDigest: '9'.repeat(64),
      revision: { ...old.revision, head: '8'.repeat(40) }, expectedContextDigest: old.contextDigest }))
      .toMatchObject({ ok: true });
    expect(await f.registry.getBoundaryPublication({ ...request, workflowId: 531,
      activityId: f.activityId, contextDigest: old.contextDigest, sessionGeneration: 1,
      activityGeneration: 2, effect: 'check', digest: 'e'.repeat(64) }))
      .toMatchObject({ status: 'published', externalId: 71 });
    expect(await f.publish({ operation: 'read' })).toMatchObject({ status: 'stale' });
  }));

  it('REQ-OPERATOR-055: changed protected controls invalidate a previously claimed publication', () => scenario(async f => {
    expect(await f.claim()).toMatchObject({ activityId: f.activityId });
    vi.spyOn(f.activity, 'getBoundaryPublicationState').mockResolvedValue({
      binding: { repositoryId: 138, pullRequest: 34, contextDigest: 'f'.repeat(64), session },
      generation: 2, status: 'completed', collected: true,
    });
    const controls = await f.registry.getManagementControls();
    expect(await f.registry.setManagementControls({ ...controls,
      boundaryActions: [{ ...controls.boundaryActions![0], workflowDigest: '0'.repeat(64) }],
    }, { email: 'admin@example.test', expiresAt: Date.now() + 300_000 })).toMatchObject({ ok: true });
    expect(await f.publish()).toMatchObject({ status: 'stale' });
    expect(await f.registry.getBoundaryPublication({ ...request, workflowId: 531,
      activityId: f.activityId, contextDigest: 'f'.repeat(64), sessionGeneration: 1,
      activityGeneration: 2, effect: 'check', digest: 'e'.repeat(64) })).toBeNull();
  }));

  it('REQ-OPERATOR-055: cancellation during GitHub verification fences journal admission', () => scenario(async f => {
    expect(await f.claim()).toMatchObject({ activityId: f.activityId });
    const binding = { repositoryId: 138, pullRequest: 34, contextDigest: 'f'.repeat(64), session };
    let observation = 0;
    vi.spyOn(f.activity, 'getBoundaryPublicationState').mockImplementation(async () => {
      if (++observation === 2) {
        expect(await f.activity.cancelBoundaryStart(binding)).toMatchObject({ ok: true });
        return null;
      }
      return { binding, generation: 2, status: 'completed', collected: true };
    });
    expect(await f.publish()).toMatchObject({ status: 'stale' });
    expect(await f.registry.getBoundaryPublication({ ...request, workflowId: 531,
      activityId: f.activityId, contextDigest: binding.contextDigest, sessionGeneration: 1,
      activityGeneration: 2, effect: 'check', digest: 'e'.repeat(64) })).toBeNull();
    expect(await f.activity.getAdmission()).toMatchObject({ phase: 'cancelled' });
  }));

  it('REQ-OPERATOR-054: a lost durable cancellation response retains pending Stop until exact reconciliation', () => scenario(async f => {
    expect(await f.claim()).toMatchObject({ activityId: f.activityId });
    const stopping = await f.repo.claimStop(session.bucket, session.sessionId, 'stop-lost', new Date().toISOString());
    expect(stopping).toMatchObject({ lifecycleState: 'stopping', boundaryActivityId: f.activityId });
    if (!stopping) throw Error('Expected stopping session');
    const lostActivity = {
      getBoundaryStartBinding: (id: string) => f.activity.getBoundaryStartBinding(id),
      cancelBoundaryStart: async (binding: Parameters<OperatorActivity['cancelBoundaryStart']>[0]) => {
        await f.activity.cancelBoundaryStart(binding);
        throw Error('Durable cancellation response lost');
      },
    };
    await expect(fencePendingBoundaryStart({ OPERATOR_ACTIVITY: { getByName: () => lostActivity } } as never,
      f.repo, stopping)).rejects.toThrow('response lost');
    expect(await f.repo.getSession(session.bucket, session.sessionId))
      .toMatchObject({ lifecycleState: 'stopping', boundaryActivityId: f.activityId });
    expect(await f.repo.confirmStopped(session.bucket, session.sessionId, 1, 'stop-lost', new Date().toISOString()))
      .toBe(false);
    expect(await f.repo.start(session.bucket, session.sessionId, new Date().toISOString())).toBeNull();
    expect(await f.activity.startWebhook(f.startCapability)).toMatchObject({ ok: false });
    await fencePendingBoundaryStart({ OPERATOR_ACTIVITY: { getByName: () => f.activity } } as never,
      f.repo, stopping);
    expect(await f.repo.confirmStopped(session.bucket, session.sessionId, 1, 'stop-lost', new Date().toISOString()))
      .toBe(true);
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
