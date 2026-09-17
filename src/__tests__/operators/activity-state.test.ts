/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Test navigation: Instrumented native-context admission/checkpoint/fencing outcomes; separate workerd fixtures cover RPC and eviction.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { OperatorActivity, createOperatorIntentDigest } from '../../operators/activity';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import type { VerifiedHumanAccessClaims } from '../../lib/jwt';

// Native storage/context supplies instrumented state coverage. The separate
// Wrangler fixture remains the authority for cross-DO RPC, SQLite and eviction.
async function withActivity(
  test: (objects: { activity: OperatorActivity; registry: OperatorRegistry; token: string;
    ctx: DurableObjectState; activityEnv: ConstructorParameters<typeof OperatorActivity>[1] }) => Promise<void>,
  admitted = true,
  started = true,
): Promise<void> {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  const stub = namespace.get(namespace.newUniqueId());
  await runInDurableObject(stub, async (_instance, ctx) => {
    // Registration/admission keys are distinct from the host DO's own storage.
    const registry = new OperatorRegistry(ctx, env as ConstructorParameters<typeof OperatorRegistry>[1]);
    const activityEnv = {
      OPERATOR_REGISTRY: { getByName: () => registry } as unknown as DurableObjectNamespace<OperatorRegistry>,
    };
    const activity = new OperatorActivity(ctx, activityEnv);
    const token = 's'.repeat(43);
    if (admitted) {
      expect((await registry.create('operator')).ok).toBe(true);
      expect((await registry.approve('operator', 'a'.repeat(64), 1)).ok).toBe(true);
      expect((await registry.setEnabled('operator', true, 2)).ok).toBe(true);
      const verifier = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      await activity.prepare({ operatorId: 'operator', activityId: 'activity', intentDigest: 'b'.repeat(64),
        expectedRevision: 3, deadline: Date.now() + 60_000, startExpiresAt: Date.now() + 60_000, startVerifier: verifier });
      if (started) expect(await activity.start(token)).toEqual({ ok: true, phase: 'queued' });
    }
    await test({ activity, registry, token, ctx, activityEnv });
  });
}
const update = { schemaVersion: 1, status: 'waiting', checkpoint: { step: 1 } };

describe('REQ-OPERATOR-003: instrumented activity state outcomes', () => {
  it('exposes the production activity namespace and reconstructs a safe empty projection', async () => {
    const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace<OperatorActivity> }).OPERATOR_ACTIVITY;
    expect(namespace).toBeDefined();
    expect(await namespace.getByName(`binding-${crypto.randomUUID()}`).getExecutionContext()).toBeNull();
  });

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

  it('fences a failed request-attached runtime before code loading and never replays it', () => withActivity(async ({ activity }) => {
    expect(await activity.fenceRuntimeFailure()).toMatchObject({ ok: true, state: { generation: 1, status: 'unknown' } });
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

  it('persists protected parent identity without exposing credentials and permits same-owner reauthentication', () => withActivity(async ({ ctx, activityEnv }) => {
    const claims: VerifiedHumanAccessClaims = { subject: 'owner', email: 'owner@example.test',
      issuer: 'https://access.example.test', audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
      expiresAt: Math.floor(Date.now() / 1000) + 300 };
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const context = await createOperatorExecutionContext({ activityId: 'activity', operatorId: 'operator',
      artifactDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), human: claims, accessJwt: 'private.jwt' }, encryption);
    const secured = new OperatorActivity(ctx, { ...activityEnv, ...encryption });
    const intentDigest = await createOperatorIntentDigest('operator', 'activity', 'null');
    expect(await secured.prepareAuthorized({ operatorId: 'operator', activityId: 'activity', intentDigest,
      expectedRevision: 1, deadline: claims.expiresAt * 1000, startExpiresAt: Date.now() + 60_000,
      startVerifier: 'd'.repeat(64) }, context)).toEqual({ ok: true, phase: 'prepared' });
    expect(await secured.getExecutionContext()).toMatchObject({ activityId: 'activity', operatorId: 'operator',
      owner: { email: 'owner@example.test' }, artifactDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64) });
    expect(JSON.stringify(await secured.getExecutionContext())).not.toContain('private.jwt');
    const renewed = { ...claims, expiresAt: claims.expiresAt + 300 };
    expect(await secured.reauthenticate(renewed, 'renewed.jwt')).toMatchObject({ expiresAt: renewed.expiresAt });
    await expect(secured.reauthenticate({ ...renewed, subject: 'other' }, 'attacker.jwt')).rejects.toThrow('owner');
  }, false));

  it('queues authorized intent only when registry artifact and policy identities match', () => withActivity(async ({ registry, ctx, activityEnv, token }) => {
    const policyJson = JSON.stringify({ schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
      storage: { readPrefixes: [], writePrefixes: [] }, inference: { routeIds: [], defaultRouteId: null,
        reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } });
    expect((await registry.create('operator')).ok).toBe(true);
    expect((await registry.setPolicy('operator', policyJson, 1)).ok).toBe(true);
    expect((await registry.approve('operator', 'a'.repeat(64), 2)).ok).toBe(true);
    expect((await registry.setEnabled('operator', true, 3)).ok).toBe(true);
    const policyDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(policyJson))))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const claims: VerifiedHumanAccessClaims = { subject: 'owner', email: 'owner@example.test',
      issuer: 'https://access.example.test', audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
      expiresAt: Math.floor(Date.now() / 1000) + 300 };
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const context = await createOperatorExecutionContext({ activityId: 'activity', operatorId: 'operator',
      artifactDigest: 'a'.repeat(64), policyDigest, human: claims, accessJwt: 'private.jwt' }, encryption);
    const secured = new OperatorActivity(ctx, { ...activityEnv, ...encryption });
    const verifier = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const intentDigest = await createOperatorIntentDigest('operator', 'activity', 'null');
    expect(await secured.prepareAuthorized({ operatorId: 'operator', activityId: 'activity', intentDigest,
      expectedRevision: 4, deadline: claims.expiresAt * 1000, startExpiresAt: Date.now() + 60_000,
      startVerifier: verifier }, context)).toEqual({ ok: true, phase: 'prepared' });
    expect(await secured.start(token)).toEqual({ ok: true, phase: 'queued' });
    expect(await secured.getExecutionContext()).toMatchObject({ artifactDigest: 'a'.repeat(64), policyDigest });
    expect(await secured.getRuntimePlan()).toMatchObject({ activityId: 'activity', invocationJson: 'null',
      receipt: { operatorId: 'operator' }, executionContext: { protectedAccessCiphertext: expect.stringMatching(/^v1:/) } });
    expect(JSON.stringify(await secured.getAdmission())).not.toContain('protectedAccessCiphertext');
    expect(JSON.stringify(await secured.getBrowserDetail())).not.toContain('protectedAccessCiphertext');

    const sync = { operationId: 'sync-1', sessionId: 'session-1', requestDigest: 'd'.repeat(64), policyDigest,
      prefix: 'Remote Reviews/activity/session-1/sync-1/', deadline: Date.now() + 60_000 };
    expect(await secured.prepareSync(sync)).toEqual({ ok: true, phase: 'prepared' });
    expect(await secured.prepareSync(sync)).toEqual({ ok: true, phase: 'prepared' });
    expect(await secured.authorizeSyncWrite('sync-1', `${sync.prefix}report.txt`)).toEqual({ ok: true });
    expect(await secured.recordSyncUploaded('sync-1', 'e'.repeat(64))).toEqual({ ok: true, phase: 'uploaded' });
    expect(await secured.authorizeSyncWrite('sync-1', `${sync.prefix}late.txt`)).toEqual({ ok: false, reason: 'sealed' });
    expect(await secured.recordSyncVerified('sync-1', { manifestDigest: 'f'.repeat(64), filesVerified: 1, bytesVerified: 6 }))
      .toEqual({ ok: false, reason: 'evidence-mismatch' });
    expect(await secured.recordSyncVerified('sync-1', { manifestDigest: 'e'.repeat(64), filesVerified: 1, bytesVerified: 6 }))
      .toEqual({ ok: true, phase: 'verified' });
    expect(await secured.getSync('sync-1')).toMatchObject({ phase: 'verified', manifestDigest: 'e'.repeat(64),
      evidence: { filesVerified: 1, bytesVerified: 6 } });
    expect(JSON.stringify(await secured.getSync('sync-1'))).not.toContain('private.jwt');
  }, false));

  it('rejects context/intent substitution and authority extending beyond the signed expiry', () => withActivity(async ({ ctx, activityEnv }) => {
    const claims: VerifiedHumanAccessClaims = { subject: 'owner', email: 'owner@example.test',
      issuer: 'https://access.example.test', audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
      expiresAt: Math.floor(Date.now() / 1000) + 300 };
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const context = await createOperatorExecutionContext({ activityId: 'activity', operatorId: 'operator',
      artifactDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), human: claims, accessJwt: 'private.jwt' }, encryption);
    const secured = new OperatorActivity(ctx, { ...activityEnv, ...encryption });
    const base = { operatorId: 'operator', activityId: 'activity',
      intentDigest: await createOperatorIntentDigest('operator', 'activity', 'null'), expectedRevision: 1,
      deadline: claims.expiresAt * 1000, startExpiresAt: Date.now() + 60_000, startVerifier: 'd'.repeat(64) };
    expect(await secured.prepareAuthorized({ ...base, intentDigest: 'c'.repeat(64) }, context))
      .toEqual({ ok: false, reason: 'admission-denied' });
    expect(await secured.prepareAuthorized({ ...base, operatorId: 'substitute' }, context)).toEqual({ ok: false, reason: 'admission-denied' });
    expect(await secured.prepareAuthorized({ ...base, deadline: claims.expiresAt * 1000 + 1 }, context)).toEqual({ ok: false, reason: 'authority-expired' });
    expect(await secured.getExecutionContext()).toBeNull();
  }, false));

  it('issues a distinct read capability only to the single start winner and consumes one terminal redemption', () => withActivity(async ({ activity, token }) => {
    const started = await activity.startWebhook(token);
    expect(started).toMatchObject({ ok: true, phase: 'queued' });
    expect(started.ok && started.readCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (!started.ok) throw new Error('expected webhook start');
    expect(await activity.getWebhookStatus(started.readCapability)).toMatchObject({ ok: true, terminal: false });
    expect(await activity.redeemWebhookResult(started.readCapability)).toEqual({ ok: false, reason: 'not-ready' });
    const drive = await activity.beginDrive();
    expect(drive).toMatchObject({ ok: true, state: { generation: 1 } });
    expect(await activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { output: 'bounded' } })).toMatchObject({ ok: true });
    const redemptions = await Promise.all([
      activity.redeemWebhookResult(started.readCapability),
      activity.redeemWebhookResult(started.readCapability),
    ]);
    expect(redemptions.filter(result => result.ok)).toHaveLength(1);
    expect(redemptions.filter(result => !result.ok)).toEqual([{ ok: false, reason: 'consumed' }]);
    expect(await activity.getWebhookStatus(started.readCapability)).toEqual({ ok: false, reason: 'consumed' });
  }, true, false));

  it('denies drive operations when admission does not exist', () => withActivity(async ({ activity }) => {
    expect(await activity.getAdmission()).toBeNull();
    expect(await activity.beginDrive()).toEqual({ ok: false, reason: 'not-admitted' });
    expect(await activity.commitDrive(1, update)).toEqual({ ok: false, reason: 'not-admitted' });
    expect(await activity.cancelDrive()).toEqual({ ok: false, reason: 'not-admitted' });
    expect(await activity.start('invalid')).toEqual({ ok: false, reason: 'invalid-capability' });
    expect(await activity.start('s'.repeat(43))).toEqual({ ok: false, reason: 'not-prepared' });
  }, false));
});
