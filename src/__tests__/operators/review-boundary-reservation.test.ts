/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';

const protectedEnv = { ENCRYPTION_KEY: btoa('k'.repeat(32)) };
const first = { repositoryId: 138, pullRequest: 34, contextDigest: 'a'.repeat(64),
  ownerKey: 'b'.repeat(64), installationId: 'review-install', deadline: Date.now() + 300_000 };
async function withRegistry(test: (registry: OperatorRegistry) => Promise<void>) {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    await test(new OperatorRegistry(ctx, protectedEnv));
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
    expect(JSON.stringify(visible)).not.toContain(a.value.startCapability);
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
  it('does not turn an ambiguous prepare into a new activity; a new head fences the old context', () => withRegistry(async registry => {
    const firstResult = await registry.reserveBoundaryPreparation(first);
    if (!firstResult.ok) throw Error('Expected reservation');
    expect(await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest))
      .toMatchObject({ activityId: firstResult.value.activityId, phase: 'pending' });
    const same = await registry.reserveBoundaryPreparation(first);
    expect(same).toMatchObject({ ok: true, value: { activityId: firstResult.value.activityId } });
    const newer = { ...first, contextDigest: 'd'.repeat(64) };
    const next = await registry.reserveBoundaryPreparation(newer);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.activityId).not.toBe(firstResult.value.activityId);
    expect(await registry.getBoundaryPreparation(first.repositoryId, first.pullRequest))
      .toMatchObject({ activityId: next.value.activityId, contextDigest: newer.contextDigest });
  }));
});
