/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { OperatorActivity } from '../../operators/activity';

// Native storage/context supplies instrumented state coverage. The separate
// Wrangler fixture remains the authority for cross-DO RPC, SQLite and eviction.
async function withActivity(
  test: (objects: { activity: OperatorActivity; registry: OperatorRegistry; token: string }) => Promise<void>,
  admitted = true,
): Promise<void> {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  const stub = namespace.get(namespace.newUniqueId());
  await runInDurableObject(stub, async (_instance, ctx) => {
    // Registration/admission keys are distinct from the host DO's own storage.
    const registry = new OperatorRegistry(ctx, env as ConstructorParameters<typeof OperatorRegistry>[1]);
    const activity = new OperatorActivity(ctx, {
      REGISTRY: { getByName: () => registry } as unknown as DurableObjectNamespace<OperatorRegistry>,
    });
    const token = 's'.repeat(43);
    if (admitted) {
      expect((await registry.create('operator')).ok).toBe(true);
      expect((await registry.approve('operator', 'a'.repeat(64), 1)).ok).toBe(true);
      expect((await registry.setEnabled('operator', true, 2)).ok).toBe(true);
      const verifier = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      await activity.prepare({ operatorId: 'operator', activityId: 'activity', intentDigest: 'b'.repeat(64),
        expectedRevision: 3, deadline: Date.now() + 60_000, startExpiresAt: Date.now() + 60_000, startVerifier: verifier });
      expect(await activity.start(token)).toEqual({ ok: true, phase: 'queued' });
    }
    await test({ activity, registry, token });
  });
}
const update = { schemaVersion: 1, status: 'waiting', checkpoint: { step: 1 } };

describe('REQ-OPERATOR-003: instrumented activity state outcomes', () => {
  it('preserves checkpoint identity across waiting and rejects stale completion', () => withActivity(async ({ activity, registry, token }) => {
    expect(await activity.getAdmission()).toMatchObject({ phase: 'queued', receipt: { activityId: 'activity' } });
    expect(await activity.start(token)).toEqual({ ok: false, reason: 'already-started' });
    expect(await activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 1, checkpoint: null } });
    expect(await activity.beginDrive()).toEqual({ ok: false, reason: 'drive-active' });
    expect(await activity.commitDrive(1, update)).toMatchObject({ ok: true, state: { status: 'waiting' } });
    expect(await activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 2, checkpoint: { step: 1 } } });
    expect(await activity.commitDrive(1, update)).toEqual({ ok: false, reason: 'stale-drive' });
    expect(await activity.commitDrive(2, { ...update, status: 'completed', result: 'done' }))
      .toMatchObject({ ok: true, state: { status: 'completed', result: 'done' } });
    expect(await activity.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
    expect(await activity.cancelDrive()).toEqual({ ok: false, reason: 'drive-settled' });
    expect(await registry.getReceipt('activity')).toMatchObject({ ok: true, value: { artifactDigest: 'a'.repeat(64) } });
  }));

  it('fences interrupted work and rejects stale interruptions and late results', () => withActivity(async ({ activity }) => {
    await activity.beginDrive();
    expect(await activity.interruptDrive(5)).toEqual({ ok: false, reason: 'stale-drive' });
    expect(await activity.interruptDrive(1)).toMatchObject({ ok: true, state: { generation: 2, status: 'unknown' } });
    expect(await activity.commitDrive(1, update)).toEqual({ ok: false, reason: 'stale-drive' });
    expect(await activity.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
  }));

  it('cancellation fences execution without claiming stopped compute', () => withActivity(async ({ activity }) => {
    await activity.beginDrive();
    expect(await activity.cancelDrive()).toMatchObject({ ok: true, state: { generation: 2, status: 'cancel-requested' } });
    expect(await activity.commitDrive(1, update)).toEqual({ ok: false, reason: 'stale-drive' });
  }));

  it('rejects non-JSON, incompatible and oversized checkpoints without losing the current drive', () => withActivity(async ({ activity }) => {
    await activity.beginDrive();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const invalid of [undefined, cycle, { ...update, checkpoint: 1n },
      { ...update, schemaVersion: 2 }, { ...update, checkpoint: 'x'.repeat(65537) }]) {
      expect(await activity.commitDrive(1, invalid)).toEqual({ ok: false, reason: 'invalid-update' });
    }
    expect(await activity.commitDrive(1, { ...update, status: 'failed', result: { reason: 'fixture' } }))
      .toMatchObject({ ok: true, state: { status: 'failed' } });
  }));

  it('denies drive operations when admission does not exist', () => withActivity(async ({ activity }) => {
    expect(await activity.getAdmission()).toBeNull();
    expect(await activity.beginDrive()).toEqual({ ok: false, reason: 'not-admitted' });
    expect(await activity.commitDrive(1, update)).toEqual({ ok: false, reason: 'not-admitted' });
    expect(await activity.cancelDrive()).toEqual({ ok: false, reason: 'not-admitted' });
    expect(await activity.start('invalid')).toEqual({ ok: false, reason: 'invalid-capability' });
    expect(await activity.start('s'.repeat(43))).toEqual({ ok: false, reason: 'not-prepared' });
  }, false));
});
