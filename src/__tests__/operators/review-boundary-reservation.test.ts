/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';

const protectedEnv = { ENCRYPTION_KEY: btoa('k'.repeat(32)) };
const first = { repositoryId: 138, pullRequest: 34, contextDigest: 'a'.repeat(64),
  ownerKey: 'b'.repeat(64), installationId: 'review-install', deadline: Date.now() + 300_000,
  controlsRevision: 1, installationRevision: 1, operatorRevision: 1,
  releaseId: 'review-release', bundleDigest: 'e'.repeat(64), workflowId: 531, workflowDigest: 'c'.repeat(64),
  session: { bucket: 'review-owner', sessionId: 'review1234', generation: 1 },
  operatorId: 'review-operator', revision: { head: 'a'.repeat(40), base: 'b'.repeat(40),
    mergeBase: 'c'.repeat(40) } };
async function withRegistry(test: (registry: OperatorRegistry, ctx: DurableObjectState) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, protectedEnv);
    const policy = { capabilities: [], resourceProfileId: null };
    const controls = await registry.setManagementControls({ revision: 0,
      managers: { users: [], groups: [] }, ceiling: { capabilities: [], resourceProfileIds: [] },
      boundaryActions: [{ repositoryId: 138, installationId: 'review-install', workflowId: 531,
        workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main',
        workflowDigest: 'c'.repeat(64), events: ['pull_request_target'] }],
    }, { email: 'admin@example.test', expiresAt: Date.now() + 300_000 });
    if (!controls.ok) throw Error('Boundary fixture controls unavailable');
    ctx.storage.sql.exec('INSERT INTO operator_catalog VALUES(?,?,?,?,?,?)', 'review-operator', 'conductor',
      'internal', 1, 'review-operator', JSON.stringify({ id: 'review-operator', revision: 1,
        sourceRevision: 1, profile: 'conductor', realm: 'internal', repositoryId: 138,
        repositoryUrl: 'https://github.com/owner/repo', managers: { users: [], groups: [] },
        invokers: { users: ['owner@example.test'], groups: [] }, policy,
        approvedWorkflow: { id: 531, ref: 'refs/heads/main' } }));
    ctx.storage.sql.exec('INSERT INTO operator_releases VALUES(?,?,?,?)', 'review-release', 'review-operator',
      JSON.stringify({ id: 'review-release', bundleDigest: first.bundleDigest, approved: true }), '{}');
    ctx.storage.sql.exec('INSERT INTO operator_installations VALUES(?,?,?,?,?)', 'review-install', 'review-operator',
      'review-install', 1, JSON.stringify({ id: 'review-install', operatorId: 'review-operator',
        name: 'review-install', releaseId: 'review-release', revision: 1, enabled: true, policy,
        configurationJson: '{}', approvedSourceRevision: 1 }));
    await test(registry, ctx);
  });
}

describe('REQ-OPERATOR-053: exact-context preparation is one durable Registry reservation', () => {
  it('admits independent configured protected bases and never selects another base as fallback', () => withRegistry(async registry => {
    const current = await registry.getManagementControls();
    const main = current.boundaryActions![0];
    const bindings = [main, ...(['master', 'develop'] as const).map((name, index) => ({
      ...main, protectedRef: `refs/heads/${name}`, workflowDigest: String(index + 1).repeat(64),
    }))];
    expect((await registry.setManagementControls({ ...current, boundaryActions: bindings },
      { email: 'admin@example.test', expiresAt: Date.now() + 300_000 })).ok).toBe(true);
    const select = registry.getBoundaryAction as (repositoryId: number, protectedRef: string) =>
      ReturnType<OperatorRegistry['getBoundaryAction']>;
    for (const binding of bindings) {
      expect(await select.call(registry, 138, binding.protectedRef))
        .toMatchObject({ protectedRef: binding.protectedRef, workflowDigest: binding.workflowDigest });
    }
    expect(await select.call(registry, 138, 'refs/heads/other')).toBeNull();
    expect(await select.call(registry, 139, 'refs/heads/main')).toBeNull();
    await expect(registry.setManagementControls({ ...(await registry.getManagementControls()),
      boundaryActions: [...bindings, { ...main }] },
    { email: 'admin@example.test', expiresAt: Date.now() + 300_000 })).rejects.toThrow();
  }));
  it('does not reuse a prepared Activity when the authenticated PR base ref changes without a SHA change', () => withRegistry(async registry => {
    const main = { ...first, protectedRef: 'refs/heads/main' };
    const original = await registry.reserveBoundaryPreparation(main);
    expect(original.ok).toBe(true);
    expect(await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest))
      .toMatchObject({ protectedRef: 'refs/heads/main' });
    expect(await registry.reserveBoundaryPreparation({ ...main, protectedRef: 'refs/heads/develop' }))
      .toMatchObject({ ok: false });
  }));
  it('concurrent repeats for one actor and context converge on one activity without returning handoff authority in public lookup', () => withRegistry(async registry => {
    const [a, b] = await Promise.all([registry.reserveBoundaryPreparation(first), registry.reserveBoundaryPreparation(first)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.activityId).toBe(b.value.activityId);
    const visible = await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest);
    expect(visible).toMatchObject({ activityId: a.value.activityId, contextDigest: first.contextDigest, phase: 'pending' });
    expect(a.value).toMatchObject({ activityId: visible?.activityId });
    expect(b.value).toMatchObject({ activityId: visible?.activityId });
    expect([a.value.created, b.value.created].sort()).toEqual([false, true]);
    expect(JSON.stringify(visible)).not.toContain('startCapability');
    expect(await registry.listOwnedActivities(first.ownerKey)).toMatchObject([{
      activityId: a.value.activityId, executionStatus: 'unknown', attention: true,
    }]);
  }));
  it('persists one protected handoff only after exact Activity preparation without exposing the token on lookup', () => withRegistry(async registry => {
    const reserved = await registry.reserveBoundaryPreparation(first);
    if (!reserved.ok) throw Error('Expected reservation');
    const capability = 'z'.repeat(43);
    expect(await registry.markBoundaryPrepared(first.repositoryId, first.pullRequest,
      reserved.value.activityId, first.contextDigest, capability, first.deadline - 1_000)).toBe(true);
    const visible = await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest);
    expect(visible).toMatchObject({ activityId: reserved.value.activityId, phase: 'prepared' });
    expect(JSON.stringify(visible)).not.toContain(capability);
    expect(await registry.markBoundaryPrepared(first.repositoryId, first.pullRequest,
      reserved.value.activityId, first.contextDigest, capability, first.deadline - 1_000)).toBe(false);
  }));
  it('fences a pending handoff when an admin changes the protected Action binding', () => withRegistry(async registry => {
    const reserved = await registry.reserveBoundaryPreparation(first);
    if (!reserved.ok) throw Error('Expected reservation');
    const current = await registry.getManagementControls();
    const changed = await registry.setManagementControls({ ...current,
      boundaryActions: [{ ...current.boundaryActions![0], workflowDigest: 'f'.repeat(64) }],
    }, { email: 'admin@example.test', expiresAt: Date.now() + 300_000 });
    expect(changed.ok).toBe(true);
    expect(await registry.markBoundaryPrepared(first.repositoryId, first.pullRequest,
      reserved.value.activityId, first.contextDigest, 'z'.repeat(43), first.deadline - 1_000)).toBe(false);
    expect(await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest))
      .toMatchObject({ phase: 'pending' });
  }));
  it('denies a second human or installation for the same PR revision and cannot replace its reservation', () => withRegistry(async registry => {
    const original = await registry.reserveBoundaryPreparation(first);
    expect(original.ok).toBe(true);
    expect(await registry.reserveBoundaryPreparation({ ...first, ownerKey: 'c'.repeat(64) }))
      .toMatchObject({ ok: false });
    expect(await registry.reserveBoundaryPreparation({ ...first, installationId: 'another-install' }))
      .toMatchObject({ ok: false });
    const visible = await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest);
    expect(visible).toMatchObject({ contextDigest: first.contextDigest, ownerKey: first.ownerKey });
  }));
  it('permits a separately authenticated session only on a new PR revision with an exact CAS', () => withRegistry(async registry => {
    const original = await registry.reserveBoundaryPreparation(first);
    if (!original.ok) throw Error('Expected reservation');
    const anotherSession = { ...first, session: { ...first.session, sessionId: 'review5678', generation: 2 },
      ownerKey: 'd'.repeat(64), contextDigest: 'e'.repeat(64), expectedContextDigest: first.contextDigest };
    expect(await registry.reserveBoundaryPreparation(anotherSession))
      .toMatchObject({ ok: false, reason: 'revision-conflict' });
    const next = await registry.reserveBoundaryPreparation({ ...anotherSession,
      revision: { ...first.revision, head: 'f'.repeat(40) } });
    if (!next.ok) throw Error('Expected new-revision reservation');
    expect(next.value.activityId).not.toBe(original.value.activityId);
    expect(await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest))
      .toMatchObject({ ownerKey: anotherSession.ownerKey, session: anotherSession.session });
  }));
  it('does not turn an ambiguous prepare into a new activity; a new head fences the old context', () => withRegistry(async registry => {
    const firstResult = await registry.reserveBoundaryPreparation(first);
    if (!firstResult.ok) throw Error('Expected reservation');
    expect(await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest))
      .toMatchObject({ activityId: firstResult.value.activityId, phase: 'pending' });
    const same = await registry.reserveBoundaryPreparation(first);
    expect(same).toMatchObject({ ok: true, value: { activityId: firstResult.value.activityId } });
    const newer = { ...first, contextDigest: 'd'.repeat(64),
      revision: { ...first.revision, head: 'f'.repeat(40) }, expectedContextDigest: first.contextDigest };
    const next = await registry.reserveBoundaryPreparation(newer);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.activityId).not.toBe(firstResult.value.activityId);
    expect(await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest))
      .toMatchObject({ activityId: next.value.activityId, contextDigest: newer.contextDigest });
    expect(await registry.reserveBoundaryPreparation({ ...first, expectedContextDigest: first.contextDigest }))
      .toMatchObject({ ok: false, reason: 'revision-conflict' });
  }));

  const claim = { repositoryId: first.repositoryId, pullRequest: first.pullRequest,
    head: first.revision.head, base: first.revision.base, mergeBase: first.revision.mergeBase,
    workflowId: first.workflowId, runId: 87, runAttempt: 1 };
  async function prepared(registry: OperatorRegistry) {
    const reservation = await registry.reserveBoundaryPreparation(first);
    if (!reservation.ok) throw Error('Expected boundary reservation');
    const startCapability = 'z'.repeat(43);
    if (!await registry.markBoundaryPrepared(first.repositoryId, first.pullRequest,
      reservation.value.activityId, first.contextDigest, startCapability, first.deadline - 1_000)) {
      throw Error('Expected protected handoff');
    }
    return { activityId: reservation.value.activityId, startCapability };
  }

  it('REQ-OPERATOR-054: a verified run and attempt alone win the prepared exact revision once', () => withRegistry(async registry => {
    const handoff = await prepared(registry);
    const [winner, loser] = await Promise.all([
      registry.claimBoundaryPreparation(claim), registry.claimBoundaryPreparation({ ...claim, runAttempt: 2 }),
    ]);
    const results = [winner, loser];
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => result.ok)).toMatchObject({ ok: true, value: {
      activityId: handoff.activityId, startCapability: handoff.startCapability,
      repositoryId: claim.repositoryId, pullRequest: claim.pullRequest, runId: claim.runId,
    } });
    expect(await registry.claimBoundaryPreparation(claim)).toMatchObject({ ok: false });
    expect(await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest))
      .toMatchObject({ activityId: handoff.activityId, phase: 'claimed' });
    expect(JSON.stringify(await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest)))
      .not.toContain(handoff.startCapability);
  }));

  it('REQ-OPERATOR-054: stale head/base/merge-base or workflow cannot consume the start handoff', () => withRegistry(async registry => {
    await prepared(registry);
    for (const altered of [{ head: 'f'.repeat(40) }, { base: 'e'.repeat(40) },
      { mergeBase: 'd'.repeat(40) }, { workflowId: 532 }, { repositoryId: 139 }, { pullRequest: 35 }]) {
      expect(await registry.claimBoundaryPreparation({ ...claim, ...altered })).toMatchObject({ ok: false });
    }
    expect(await registry.claimBoundaryPreparation(claim)).toMatchObject({ ok: true });
  }));

  it('REQ-OPERATOR-054: changed binding or installation cannot claim an already-prepared handoff', () => withRegistry(async registry => {
    await prepared(registry);
    const current = await registry.getManagementControls();
    const changed = await registry.setManagementControls({ ...current,
      boundaryActions: [{ ...current.boundaryActions![0], workflowDigest: 'f'.repeat(64) }],
    }, { email: 'admin@example.test', expiresAt: Date.now() + 300_000 });
    expect(changed.ok).toBe(true);
    expect(await registry.claimBoundaryPreparation(claim)).toMatchObject({ ok: false });
  }));
});

// Internal parent-only owner API: the trusted publisher separately verifies OIDC, GitHub
// provenance and immutable bytes before calling these credential-free storage operations.
type PublicationIdentity = Parameters<OperatorRegistry['claimBoundaryPreparation']>[0] & {
  activityId: string; contextDigest: string;
  sessionGeneration: number; activityGeneration: number };
type PublicationInput = PublicationIdentity & { effect: 'artifact' | 'comment' | 'check'; digest: string };
type PublicationRegistry = OperatorRegistry & {
  beginBoundaryPublication(input: PublicationInput): Promise<{ status: string }>;
  completeBoundaryPublication(input: PublicationInput & { externalId: number }): Promise<{ status: string }>;
  getBoundaryPublication(input: PublicationInput): Promise<{ status: string; digest?: string; externalId?: number } | null>;
};
const publication = (registry: OperatorRegistry) => registry as PublicationRegistry;
const publicationIdentity = (activityId: string): PublicationIdentity => ({ repositoryId: first.repositoryId,
  pullRequest: first.pullRequest, head: first.revision.head, base: first.revision.base,
  mergeBase: first.revision.mergeBase, workflowId: first.workflowId, runId: 87, runAttempt: 1,
  activityId, contextDigest: first.contextDigest, sessionGeneration: first.session.generation,
  activityGeneration: 2 });
async function claimed(registry: OperatorRegistry): Promise<PublicationIdentity> {
  const reservation = await registry.reserveBoundaryPreparation(first);
  if (!reservation.ok) throw Error('Expected publication reservation');
  if (!await registry.markBoundaryPrepared(first.repositoryId, first.pullRequest, reservation.value.activityId,
    first.contextDigest, 'z'.repeat(43), first.deadline - 1_000)) throw Error('Expected prepared Action handoff');
  const result = await registry.claimBoundaryPreparation({ repositoryId: first.repositoryId,
    pullRequest: first.pullRequest, ...first.revision, workflowId: first.workflowId, runId: 87, runAttempt: 1 });
  if (!result.ok) throw Error('Expected protected Action claim');
  return publicationIdentity(result.value.activityId);
}

describe('REQ-OPERATOR-055: durable PR-wide publication ordering', () => {
  it('records separate pending artifact, comment and shadow-check intents once across owner reconstruction', () => withRegistry(async (registry, ctx) => {
    const reserved = await registry.reserveBoundaryPreparation(first);
    if (!reserved.ok) throw Error('Expected unclaimed reservation');
    expect(await publication(registry).beginBoundaryPublication({ ...publicationIdentity(reserved.value.activityId),
      effect: 'artifact', digest: '1'.repeat(64) })).toMatchObject({ status: 'stale' });
    const identity = await claimed(registry);
    const effects = ['artifact', 'comment', 'check'] as const;
    for (const effect of effects) {
      const input = { ...identity, effect, digest: effect === 'artifact' ? '1'.repeat(64) : effect === 'comment'
        ? '2'.repeat(64) : '3'.repeat(64) };
      const contenders = await Promise.all([
        publication(registry).beginBoundaryPublication(input),
        publication(new OperatorRegistry(ctx, protectedEnv)).beginBoundaryPublication(input),
      ]);
      expect(contenders.map(outcome => outcome.status).sort()).toEqual(['new', 'pending']);
      const pending = await publication(registry).getBoundaryPublication(input);
      expect(pending).toMatchObject({ status: 'pending', digest: input.digest });
      expect(JSON.stringify(pending)).not.toContain('z'.repeat(43));
      expect(await publication(registry).beginBoundaryPublication({ ...input, digest: '9'.repeat(64) }))
        .toMatchObject({ status: 'conflict' });
    }
  }));

  it('denies a foreign repo, run, session or drive generation and fences late old writes after a new PR reservation', () => withRegistry(async registry => {
    const identity = await claimed(registry);
    const old = { ...identity, effect: 'check' as const, digest: '3'.repeat(64) };
    for (const changed of [{ repositoryId: 139 }, { pullRequest: 35 }, { runAttempt: 2 },
      { runId: 88 }, { sessionGeneration: 2 }, { activityId: 'another-activity' },
      { contextDigest: '0'.repeat(64) }]) {
      expect(await publication(registry).beginBoundaryPublication({ ...old, ...changed }))
        .toMatchObject({ status: 'stale' });
    }
    expect(await publication(registry).beginBoundaryPublication(old)).toMatchObject({ status: 'new' });
    expect(await publication(registry).beginBoundaryPublication({ ...old, activityGeneration: 3 }))
      .toMatchObject({ status: 'stale' });
    const newer = { ...first, contextDigest: 'd'.repeat(64), expectedContextDigest: first.contextDigest,
      revision: { ...first.revision, head: 'f'.repeat(40) } };
    expect(await registry.reserveBoundaryPreparation(newer)).toMatchObject({ ok: true });
    expect(await publication(registry).completeBoundaryPublication({ ...old, externalId: 41 }))
      .toMatchObject({ status: 'stale' });
    expect(await publication(registry).beginBoundaryPublication(old)).toMatchObject({ status: 'stale' });
    expect((await publication(registry).getBoundaryPublication(old))?.status).not.toBe('published');
  }));

  it('reconciles a collected effect after execution expiry without granting a new publication write', () => withRegistry(async (registry, ctx) => {
    const identity = await claimed(registry);
    const input = { ...identity, effect: 'artifact' as const, digest: '1'.repeat(64) };
    expect(await registry.beginBoundaryPublication(input)).toMatchObject({ status: 'new' });
    ctx.storage.sql.exec(`UPDATE operator_boundary_preparations
      SET data=json_set(data,'$.deadline',?) WHERE repository_id=? AND pull_request=?`,
    Date.now() - 1, first.repositoryId, first.pullRequest);
    expect(await registry.getBoundaryStartGuard(identity.activityId)).toMatchObject({ claimed: false });
    expect(await registry.getBoundaryPublicationGuard(identity.activityId)).toMatchObject({ claimed: true });
    expect(await registry.beginBoundaryPublication(input)).toMatchObject({ status: 'pending' });
    expect(await registry.completeBoundaryPublication({ ...input, externalId: 77 }))
      .toMatchObject({ status: 'published', externalId: 77 });
    expect(await registry.beginBoundaryPublication({ ...input, effect: 'check', digest: '3'.repeat(64) }))
      .toMatchObject({ status: 'stale' });
  }));

  it('retains a publisher-reported exact ID after a lost acknowledgement without authorizing another create', () => withRegistry(async (registry, ctx) => {
    const identity = await claimed(registry);
    const input = { ...identity, effect: 'comment' as const, digest: '2'.repeat(64) };
    expect(await publication(registry).completeBoundaryPublication({ ...input, externalId: 71 }))
      .toMatchObject({ status: 'stale' });
    expect(await publication(registry).beginBoundaryPublication(input)).toMatchObject({ status: 'new' });
    expect(await publication(registry).completeBoundaryPublication({ ...input, externalId: 71 }))
      .toMatchObject({ status: 'published' });
    const rebuilt = publication(new OperatorRegistry(ctx, protectedEnv));
    expect(await rebuilt.getBoundaryPublication(input))
      .toMatchObject({ status: 'published', digest: input.digest, externalId: 71 });
    expect(await rebuilt.beginBoundaryPublication(input)).toMatchObject({ status: 'published' });
    expect(await rebuilt.completeBoundaryPublication({ ...input, externalId: 72 }))
      .toMatchObject({ status: 'conflict' });
    expect(await rebuilt.completeBoundaryPublication({ ...input, digest: '8'.repeat(64), externalId: 71 }))
      .toMatchObject({ status: 'conflict' });
  }));
});
