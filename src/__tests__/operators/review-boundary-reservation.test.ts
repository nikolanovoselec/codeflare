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
async function withRegistry(test: (registry: OperatorRegistry) => Promise<void>) {
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
    await test(registry);
  });
}

describe('REQ-OPERATOR-053: exact-context preparation is one durable Registry reservation', () => {
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
