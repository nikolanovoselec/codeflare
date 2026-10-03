/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Test navigation: Instrumented native-context admission/checkpoint/fencing outcomes; separate workerd fixtures cover RPC and eviction.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { OperatorActivity, createOperatorIntentDigest } from '../../operators/activity';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import type { VerifiedHumanAccessClaims } from '../../lib/jwt';

// Native SQLite Activity storage/context supplies instrumented state coverage.
// The separate Wrangler fixture remains the authority for cross-DO RPC and eviction.
async function withActivity(
  test: (objects: { activity: OperatorActivity; registry: OperatorRegistry; token: string;
    ctx: DurableObjectState; activityEnv: ConstructorParameters<typeof OperatorActivity>[1]; deadline: number }) => Promise<void>,
  admitted = true,
  started = true,
): Promise<void> {
  const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  const stub = namespace.get(namespace.newUniqueId());
  await runInDurableObject(stub, async (_instance, ctx) => {
    // Registration/admission keys are distinct from the host DO's own storage.
    const registry = new OperatorRegistry(ctx, env as ConstructorParameters<typeof OperatorRegistry>[1]);
    const activityEnv = {
      ...env,
      OPERATOR_REGISTRY: { getByName: () => registry } as unknown as DurableObjectNamespace<OperatorRegistry>,
    } as unknown as ConstructorParameters<typeof OperatorActivity>[1];
    const activity = new OperatorActivity(ctx, activityEnv);
    const token = 's'.repeat(43);
    const deadline = Date.now() + 60_000;
    if (admitted) {
      expect((await registry.create('operator')).ok).toBe(true);
      expect((await registry.approve('operator', 'a'.repeat(64), 1)).ok).toBe(true);
      expect((await registry.setEnabled('operator', true, 2)).ok).toBe(true);
      const verifier = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      await activity.prepare({ operatorId: 'operator', activityId: 'activity', intentDigest: 'b'.repeat(64),
        expectedRevision: 3, deadline, startExpiresAt: Date.now() + 60_000, startVerifier: verifier });
      if (started) expect(await activity.start(token)).toEqual({ ok: true, phase: 'queued' });
    }
    await test({ activity, registry, token, ctx, activityEnv, deadline });
  });
}
const update = { schemaVersion: 1, status: 'waiting', checkpoint: { step: 1 } };
function ownedSessionFixture() {
  return {
    schemaVersion: 1 as const, requestId: 'request-1', requestDigest: 'd'.repeat(64), activityId: 'activity',
    ownerBucket: 'owner-bucket', sessionId: 'session-1', status: 'reserved' as const,
    profile: { schemaVersion: 1 as const, activityId: 'activity', operatorId: 'operator', sessionId: 'session-1',
      ownerBucket: 'owner-bucket', policyDigest: 'e'.repeat(64), deadline: Date.now() + 60_000,
      outputPrefix: 'Operators/',
      human: { subject: 'human', email: 'human@example.test', issuer: 'https://access.example.test/', audiences: ['aud'] },
      policy: { schemaVersion: 1 as const, networkHosts: [], github: { repositories: [], methods: [] },
        storage: { readPrefixes: ['operator-fixtures/'], writePrefixes: ['operator-fixtures/'] },
        inference: { routeIds: ['route'], defaultRouteId: 'route', reasoningLevels: ['off'],
          defaultReasoningLevel: 'off', inheritUserDefaults: false } },
      jwtPolicy: { mode: 'off' as const, destinations: [] },
      piProfile: { provider: 'codeflare-gateway', model: 'route', thinkingLevel: 'off',
        systemPrompt: 'fixed', tools: ['write'] },
    },
  };
}

describe('REQ-OPERATOR-003: instrumented activity state outcomes', () => {
  it('REQ-OPERATOR-027: projects only trusted pinned name and allowlisted admitted task coordinates', async () => withActivity(async ({ activity, ctx }) => {
    const admission = await ctx.storage.get<{ receipt: Record<string, unknown> }>('admission');
    expect(admission).toBeTruthy();
    const ownerKey = await operatorOwnerKey({ subject: 'owner', email: 'owner@example.test',
      issuer: 'https://access.example.test', audiences: ['account-audience'] });
    await ctx.storage.put('admission', { ...admission, ownerKey, boundary: { repositoryId: 123, pullRequest: 42,
      contextDigest: 'd'.repeat(64), session: { bucket: 'owner-bucket', sessionId: 'session-1', generation: 1 } },
      receipt: { ...admission!.receipt, manifestJson: JSON.stringify({ name: 'Trusted Reviewer' }) },
      invocationJson: JSON.stringify({ schemaVersion: 1, interfaceVersion: 1,
        consumerId: 'boundary-reviews', input: { context: { repositoryId: 123, pullRequest: 42,
          head: 'a'.repeat(40), base: 'b'.repeat(40), mergeBase: 'c'.repeat(40) } },
        source: { kind: 'session', reference: 'owner/repo' }, accessToken: 'secret-token', notes: 'private notes' }),
      drive: { generation: 1, status: 'waiting', checkpoint: { stage: 'checking' },
        result: { privateReport: 'private report bytes' } } });
    const detail = await activity.getBrowserDetail();
    expect(detail).toMatchObject({ operatorName: 'Trusted Reviewer', context: 'owner/repo · PR #42',
      progress: 'checking' });
    expect(JSON.stringify(detail)).not.toContain('secret-token');
    expect(JSON.stringify(detail)).not.toContain('private notes');
    const readSummary = (key: string) => (activity as unknown as {
      getBrowserSummary: (ownerKey: string) => Promise<unknown> }).getBrowserSummary(key);
    const historical = await readSummary(ownerKey);
    expect(historical).toMatchObject({ operatorName: 'Trusted Reviewer', context: 'owner/repo · PR #42' });
    expect(JSON.stringify(historical)).not.toContain('secret-token');
    expect(JSON.stringify(historical)).not.toContain('private notes');
    expect(JSON.stringify(historical)).not.toContain('private report bytes');
    expect(historical).not.toHaveProperty('checkpoint');
    expect(historical).not.toHaveProperty('result');
    expect(await readSummary('f'.repeat(64))).toBeNull();
    const longRepository = `${'a'.repeat(128)}/${'b'.repeat(127)}`;
    const currentAdmission = await ctx.storage.get<Record<string, unknown>>('admission');
    await ctx.storage.put('admission', { ...currentAdmission!,
      invocationJson: JSON.stringify({ input: { context: { repositoryId: 123, pullRequest: 42 } },
        source: { kind: 'session', reference: longRepository } }) });
    const longDetail = await activity.getBrowserDetail();
    expect(longDetail?.context?.length).toBeLessThanOrEqual(256);
    expect(longDetail?.context).toContain('PR #42');
    const unowned = await ctx.storage.get<Record<string, unknown>>('admission');
    await ctx.storage.put('admission', { ...unowned, ownerKey: undefined });
    expect(await readSummary(ownerKey)).toBeNull();
  }));

  it('REQ-OPERATOR-027: counts still-working activities after their historical rows leave the 100-entry index', async () => withActivity(async ({ registry }) => {
    const owner = 'c'.repeat(64);
    const base = { operatorId: 'reviewer', executionStatus: 'running' as const, cleanupStatus: 'pending' as const,
      collectionStatus: 'unavailable' as const, attention: false, sessionId: null, source: null, updatedAt: Date.now() };
    await registry.upsertOwnedActivity(owner, { ...base, activityId: 'older-still-working' });
    for (let i = 1; i <= 100; i++) await registry.upsertOwnedActivity(owner,
      { ...base, activityId: `finished-${i}`, executionStatus: 'completed' });
    expect((await registry.listOwnedActivityPage(owner, null)).workingCount).toBe(1);
    await registry.upsertOwnedActivity(owner,
      { ...base, activityId: 'older-still-working', executionStatus: 'completed' });
    expect((await registry.listOwnedActivityPage(owner, null)).workingCount).toBe(0);
  }));

  it('REQ-OPERATOR-027: recovers persisted working count beyond 1,000 historical summaries', async () => withActivity(async ({ registry, ctx }) => {
    const owner = 'f'.repeat(64);
    const base = { operatorId: 'reviewer', executionStatus: 'completed' as const, cleanupStatus: 'stopped' as const,
      collectionStatus: 'ready' as const, attention: false, sessionId: null, source: null, updatedAt: Date.now() };
    for (let start = 0; start <= 1000; start += 100) {
      const saved = Object.fromEntries(Array.from({ length: Math.min(100, 1001 - start) }, (_, offset) => {
        const i = start + offset;
        return [`owner-activity:${owner}:past-${i}`, { ...base, activityId: `past-${i}`,
          executionStatus: i === 0 || i === 1000 ? 'running' : 'completed' }];
      }));
      await ctx.storage.put(saved);
    }
    await registry.upsertOwnedActivity(owner, { ...base, activityId: 'new-activity', executionStatus: 'running' });
    expect((await registry.listOwnedActivityPage(owner, null)).workingCount).toBe(3);
    await registry.upsertOwnedActivity(owner, { ...base, activityId: 'past-0' });
    expect((await registry.listOwnedActivityPage(owner, null)).workingCount).toBe(2);
  }));

  it('REQ-OPERATOR-027: retains at most 20 browsable summaries per operator without discarding owned results', async () => withActivity(async ({ registry }) => {
    const owner = 'e'.repeat(64);
    const base = { executionStatus: 'completed' as const, cleanupStatus: 'stopped' as const,
      collectionStatus: 'ready' as const, attention: false, sessionId: null, source: null, updatedAt: Date.now() };
    for (let i = 1; i <= 26; i++) await registry.upsertOwnedActivity(owner, { ...base,
      activityId: `alpha-${i}`, operatorId: 'alpha' });
    for (let i = 1; i <= 22; i++) await registry.upsertOwnedActivity(owner, { ...base,
      activityId: `beta-${i}`, operatorId: 'beta' });
    const browsable = await registry.listOwnedActivities(owner);
    expect(browsable.filter(item => item.operatorId === 'alpha')).toHaveLength(20);
    expect(browsable.filter(item => item.operatorId === 'beta')).toHaveLength(20);
    expect(await registry.getOwnedActivity(owner, 'alpha-1')).toMatchObject({ activityId: 'alpha-1' });
  }));

  it('REQ-OPERATOR-059: counts only new admissions, resets through the observed revision and preserves later arrivals', async () => withActivity(async ({ registry }) => {
    const owner = 'd'.repeat(64);
    const base = { operatorId: 'reviewer', executionStatus: 'running' as const, cleanupStatus: 'pending' as const,
      collectionStatus: 'unavailable' as const, attention: false, sessionId: null, source: null, updatedAt: Date.now() };
    await registry.upsertOwnedActivity(owner, { ...base, activityId: 'new-1' });
    const first = await registry.listOwnedActivityPage(owner, null);
    expect(first).toMatchObject({ unreadCount: 1, latestSequence: 1 });
    await registry.upsertOwnedActivity(owner, { ...base, activityId: 'new-1', executionStatus: 'completed' });
    await registry.upsertOwnedActivity(owner, { ...base, activityId: 'new-2' });
    expect(await registry.acknowledgeOwnedActivities(owner, first.latestSequence)).toEqual({ unreadCount: 1 });
    expect(await registry.acknowledgeOwnedActivities(owner, 999)).toEqual({ unreadCount: 0 });
    await registry.upsertOwnedActivity(owner, { ...base, activityId: 'new-3' });
    expect((await registry.listOwnedActivityPage(owner, null)).unreadCount).toBe(1);
    expect(await registry.acknowledgeOwnedActivities('a'.repeat(64), 999)).toEqual({ unreadCount: 0 });
    expect((await registry.listOwnedActivityPage(owner, null)).unreadCount).toBe(1);
  }));

  it('REQ-OPERATOR-059: does not acknowledge an admission arriving during page construction', async () => withActivity(async ({ registry }) => {
    const owner = '7'.repeat(64);
    const base = { operatorId: 'reviewer', executionStatus: 'running' as const, cleanupStatus: 'pending' as const,
      collectionStatus: 'unavailable' as const, attention: false, sessionId: null, source: null, updatedAt: Date.now() };
    await registry.upsertOwnedActivity(owner, { ...base, activityId: 'before' });
    const originalList = registry.listOwnedActivities.bind(registry);
    registry.listOwnedActivities = async (key) => {
      const items = await originalList(key);
      await registry.upsertOwnedActivity(owner, { ...base, activityId: 'during' });
      return items;
    };
    const page = await registry.listOwnedActivityPage(owner, null);
    expect(page.items.map(item => item.activityId)).toEqual(['before']);
    expect(page.latestSequence).toBe(1);
    expect(await registry.acknowledgeOwnedActivities(owner, page.latestSequence)).toEqual({ unreadCount: 1 });
  }));

  it('REQ-OPERATOR-027: retains only 20 per operator and pages by last seen ID across a new arrival and status update', async () => withActivity(async ({ registry }) => {
    const owner = 'a'.repeat(64);
    const base = { operatorId: 'reviewer', executionStatus: 'running' as const, cleanupStatus: 'pending' as const,
      collectionStatus: 'unavailable' as const, attention: false, sessionId: null, source: null, updatedAt: Date.now() };
    for (let i = 1; i <= 103; i++) await registry.upsertOwnedActivity(owner, { ...base, activityId: `run-${i}` });
    const page = await registry.listOwnedActivityPage(owner, null);
    expect(page.items.map(item => item.activityId)).toEqual(['run-103', 'run-102', 'run-101', 'run-100', 'run-99']);
    expect(page.workingCount).toBe(103);
    await registry.upsertOwnedActivity(owner, { ...base, activityId: 'run-102', executionStatus: 'completed' });
    await registry.upsertOwnedActivity(owner, { ...base, activityId: 'run-98', executionStatus: 'completed' });
    await registry.upsertOwnedActivity(owner, { ...base, activityId: 'run-104' });
    const older = await registry.listOwnedActivityPage(owner, page.nextCursor);
    expect(older.items.map(item => item.activityId)).toEqual(['run-98', 'run-97', 'run-96', 'run-95', 'run-94']);
    expect(older.workingCount).toBe(102);
    let cursor = older.nextCursor;
    let last = older;
    while (cursor) { last = await registry.listOwnedActivityPage(owner, cursor); cursor = last.nextCursor; }
    expect(last.items.at(-1)?.activityId).toBe('run-85');
    await registry.upsertOwnedActivity('b'.repeat(64), { ...base, activityId: 'other-owner' });
    expect((await registry.listOwnedActivityPage('b'.repeat(64), null)).items.map(item => item.activityId)).toEqual(['other-owner']);
    await expect(registry.listOwnedActivityPage('b'.repeat(64), page.nextCursor)).rejects.toThrow('Activity history changed');
    await expect(registry.listOwnedActivityPage(owner, 'run-4')).rejects.toThrow('Activity history changed');
  }));

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
    expect(await activity.getCurrentDriveCheckpointJson(1)).toBeNull();
    expect(await activity.getCurrentDriveCheckpointJson(2)).toBe(JSON.stringify({ step: 1 }));
    expect(await activity.commitDrive(1, update)).toEqual({ ok: false, reason: 'stale-drive' });
    expect(await activity.commitDrive(2, { ...update, status: 'completed', result: 'done' }))
      .toMatchObject({ ok: true, state: { status: 'completed', result: 'done' } });
    expect(await activity.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
    expect(await activity.getCurrentDriveCheckpointJson(2)).toBeNull();
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

  it('durably owns one immutable session request while allowing status reconciliation', () => withActivity(async ({ activity }) => {
    const session = ownedSessionFixture();
    expect(await activity.saveOwnedSession(session)).toEqual({ ok: true });
    expect(await activity.getOwnedSession()).toEqual(session);
    expect(await activity.saveOwnedSession({ ...session, status: 'configuring' })).toEqual({ ok: true });
    expect(await activity.saveOwnedSession({ ...session, requestId: 'different' })).toEqual({ ok: false, reason: 'conflict' });
    expect(await activity.getOwnedSession()).toMatchObject({ requestId: 'request-1', status: 'configuring' });
  }));

  it.each(['reserved', 'configuring', 'configured', 'starting', 'ready'] as const)(
    'permits an owned-session stop from %s without accepting new work', status => withActivity(async ({ activity }) => {
      const session = ownedSessionFixture();
      expect(await activity.saveOwnedSession(session)).toMatchObject({ ok: true });
      const before = ['configuring', 'configured', 'starting', 'ready'] as const;
      for (const step of before) {
        if (status === 'reserved' || before.indexOf(step) > before.indexOf(status as typeof before[number])) break;
        expect(await activity.saveOwnedSession({ ...session, status: step })).toMatchObject({ ok: true });
      }
      expect(await activity.saveOwnedSession({ ...session, status: 'stopping' })).toMatchObject({ ok: true });
      expect(await activity.saveOwnedSession({ ...session, status: 'stopped' })).toMatchObject({ ok: true });
      expect((await activity.getOwnedSession())?.status).toBe('stopped');
      expect(await activity.saveOwnedSession({ ...session, status: 'starting' })).toMatchObject({ ok: false });
    }),
  );

  it('accepts cleanup-only unknown → stopping → stopped for the same owned session', () => withActivity(async ({ activity }) => {
    const session = ownedSessionFixture();
    expect(await activity.saveOwnedSession(session)).toMatchObject({ ok: true });
    expect(await activity.saveOwnedSession({ ...session, status: 'configuring' })).toMatchObject({ ok: true });
    expect(await activity.saveOwnedSession({ ...session, status: 'unknown' })).toMatchObject({ ok: true });
    expect(await activity.saveOwnedSession({ ...session, status: 'stopping' })).toMatchObject({ ok: true });
    expect(await activity.saveOwnedSession({ ...session, status: 'stopped' })).toMatchObject({ ok: true });
    expect(await activity.saveOwnedSession({ ...session, status: 'starting' })).toMatchObject({ ok: false });
  }));

  it('accepts cleanup-only unknown → stopping → stopped for the same owned session', () => withActivity(async ({ activity }) => {
    const session = ownedSessionFixture();
    expect(await activity.saveOwnedSession(session)).toMatchObject({ ok: true });
    expect(await activity.saveOwnedSession({ ...session, status: 'configuring' })).toMatchObject({ ok: true });
    expect(await activity.saveOwnedSession({ ...session, status: 'unknown' })).toMatchObject({ ok: true });
    expect(await activity.saveOwnedSession({ ...session, status: 'stopping' })).toMatchObject({ ok: true });
    expect(await activity.saveOwnedSession({ ...session, status: 'stopped' })).toMatchObject({ ok: true });
    expect(await activity.saveOwnedSession({ ...session, status: 'starting' })).toMatchObject({ ok: false });
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

  it('REQ-OPERATOR-053: stopping the bound session durably fences a prepared Action activity before either start path', () => withActivity(async ({ ctx, activityEnv, token }) => {
    const human: VerifiedHumanAccessClaims = { subject: 'owner', email: 'owner@example.test',
      issuer: 'https://access.example.test', audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
      expiresAt: Math.floor(Date.now() / 1000) + 300 };
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const secured = new OperatorActivity(ctx, { ...activityEnv, ...encryption });
    const context = await createOperatorExecutionContext({ activityId: 'activity', operatorId: 'operator',
      artifactDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), human, accessJwt: 'private.jwt' }, encryption);
    const binding = { repositoryId: 138, pullRequest: 34, contextDigest: 'c'.repeat(64),
      session: { bucket: 'owner-bucket', sessionId: 'session01', generation: 1 } };
    const verifier = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const deadline = human.expiresAt * 1000;
    const intentDigest = await createOperatorIntentDigest('operator', 'activity', 'null');
    expect(await secured.prepareAuthorized({ operatorId: 'operator', activityId: 'activity', intentDigest,
      expectedRevision: 1, deadline, startExpiresAt: deadline - 1_000, startVerifier: verifier }, context,
    'null', binding)).toMatchObject({ ok: true, phase: 'prepared' });
    expect(await secured.cancelBoundaryStart(binding)).toMatchObject({ ok: true });
    expect(await secured.getAdmission()).toMatchObject({ phase: 'cancelled' });
    expect(await secured.start(token)).toMatchObject({ ok: false });
    expect(await secured.startWebhook(token)).toMatchObject({ ok: false });
    expect(await secured.getRuntimePlan()).toBeNull();
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
    const ownerKey = await operatorOwnerKey(context.owner);
    expect(await registry.listOwnedActivities(ownerKey)).toEqual([]);
    expect(await secured.ownsPrepared(ownerKey)).toBe(true);
    expect(await secured.ownsPrepared('f'.repeat(64))).toBe(false);
    expect(await secured.start(token)).toEqual({ ok: true, phase: 'queued' });
    expect(await secured.ownsPrepared(ownerKey)).toBe(false);
    expect(await registry.listOwnedActivities(ownerKey)).toHaveLength(1);
    expect(await secured.getExecutionContext()).toMatchObject({ artifactDigest: 'a'.repeat(64), policyDigest });
    expect(await secured.getRuntimePlan()).toMatchObject({ activityId: 'activity', invocationJson: 'null',
      receipt: { operatorId: 'operator' }, executionContext: { protectedAccessCiphertext: expect.stringMatching(/^v1:/) } });
    expect(JSON.stringify(await secured.getAdmission())).not.toContain('protectedAccessCiphertext');
    expect(JSON.stringify(await secured.getBrowserDetail())).not.toContain('protectedAccessCiphertext');

    const sync = { operationId: 'sync-1', sessionId: 'session-1', requestDigest: 'd'.repeat(64), policyDigest,
      prefix: '.codeflare/operators/activity/sync-1/', keys: ['Operators/Gate 1/result.txt'],
      deadline: Date.now() + 60_000 };
    expect(await secured.prepareSync(sync)).toEqual({ ok: true, phase: 'prepared' });
    expect(await secured.prepareSync(sync)).toEqual({ ok: true, phase: 'prepared' });
    expect(await secured.authorizeSyncWrite('sync-1', `${sync.prefix}manifest.json`)).toEqual({ ok: true });
    expect(await secured.authorizeSyncWrite('sync-1', sync.keys[0])).toEqual({ ok: true });
    expect(await secured.authorizeSyncWrite('sync-1', 'Operators/Gate 1/undeclared.txt'))
      .toEqual({ ok: false, reason: 'invalid-scope' });
    expect(await secured.recordSyncUploaded('sync-1', 'e'.repeat(64))).toEqual({ ok: true, phase: 'uploaded' });
    expect(await secured.authorizeSyncWrite('sync-1', `${sync.prefix}late.txt`)).toEqual({ ok: false, reason: 'sealed' });
    expect(await secured.recordSyncVerified('sync-1', { manifestDigest: 'f'.repeat(64), filesVerified: 1, bytesVerified: 6 }))
      .toEqual({ ok: false, reason: 'evidence-mismatch' });
    expect(await secured.recordSyncVerified('sync-1', { manifestDigest: 'e'.repeat(64), filesVerified: 1, bytesVerified: 6 }))
      .toEqual({ ok: true, phase: 'verified' });
    expect(await secured.getSync('sync-1')).toMatchObject({ phase: 'verified', manifestDigest: 'e'.repeat(64),
      evidence: { filesVerified: 1, bytesVerified: 6 } });
    expect(await secured.authorizeSyncRead(`${sync.prefix}manifest.json`, 64 * 1024)).toEqual({ ok: true });
    expect(await secured.authorizeSyncRead(sync.keys[0], 64 * 1024)).toEqual({ ok: true });
    expect(await secured.authorizeSyncRead('Operators/foreign.txt', 64 * 1024)).toEqual({ ok: false });
    expect(JSON.stringify(await secured.getSync('sync-1'))).not.toContain('private.jwt');

    expect(await secured.beginDrive()).toMatchObject({ ok: true, state: { generation: 1 } });
    expect(await secured.operatorGenerationCurrent(1)).toBe(true);
    expect(await secured.operatorGenerationCurrent(2)).toBe(false);
    const review = { generation: 1, repositoryId: 12, pullRequest: 34, head: '1'.repeat(40),
      releaseDigest: 'a'.repeat(64), packageDigest: '6'.repeat(64), resourceDigest: '7'.repeat(64),
      packetDigest: '2'.repeat(64), requiredLanes: ['security', 'contract'] };
    expect(await secured.prepareReviewState(review)).toMatchObject({ ok: true, state: { requiredLanes: ['security', 'contract'] } });
    expect(await secured.recordReviewLane(2, review.head, 'security', '3'.repeat(64)))
      .toEqual({ ok: false, reason: 'stale-generation' });
    expect(await secured.recordReviewLane(1, review.head, 'undeclared', '3'.repeat(64)))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(await secured.recordReviewLane(1, review.head, 'security', '3'.repeat(64))).toMatchObject({ ok: true });
    expect(await secured.sealReview(1, review.head, 'sync-1')).toEqual({ ok: false, reason: 'incomplete' });
    expect(await secured.recordReviewLane(1, review.head, 'contract', '4'.repeat(64))).toMatchObject({ ok: true });
    expect(await secured.sealReview(1, review.head, 'sync-1')).toMatchObject({ ok: true, state: { sealedSyncOperationId: 'sync-1' } });

    expect(await secured.reserveReviewPublication(1, review.head, 'publish-1', '5'.repeat(64)))
      .toMatchObject({ ok: true, state: { publication: { phase: 'reserved' } } });
    expect(await secured.reserveReviewPublication(1, review.head, 'publish-1', '6'.repeat(64)))
      .toEqual({ ok: false, reason: 'conflict' });
    expect(await secured.markReviewPublicationUnknown(1, review.head, 'publish-1', '5'.repeat(64)))
      .toMatchObject({ ok: true, state: { publication: { phase: 'unknown' } } });
    expect(await secured.reserveReviewPublication(1, review.head, 'publish-1', '5'.repeat(64)))
      .toEqual({ ok: false, reason: 'unknown' });
    expect(await secured.completeReviewPublication(1, review.head, 'publish-1', '5'.repeat(64), { checkId: 1, recordId: 2 }))
      .toEqual({ ok: false, reason: 'unknown' });
    expect(await secured.reconcileReviewPublication(1, review.head, 'publish-1', '5'.repeat(64), { checkId: 1, recordId: 2 }))
      .toMatchObject({ ok: true, state: { publication: { phase: 'completed', receipt: { checkId: 1, recordId: 2 } } } });
    expect(await secured.reconcileReviewPublication(1, review.head, 'publish-1', '8'.repeat(64), { checkId: 1, recordId: 2 }))
      .toEqual({ ok: false, reason: 'conflict' });
    const reconstructed = new OperatorActivity(ctx, { ...activityEnv, ...encryption });
    expect(await reconstructed.getReviewState()).toMatchObject({ ...review,
      sealedSyncOperationId: 'sync-1', publication: { phase: 'completed', receipt: { checkId: 1, recordId: 2 } } });
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

  it('rereads identical immutable terminal bytes after lost delivery only with the original read capability', () => withActivity(async ({ activity, token, ctx, activityEnv }) => {
    const started = await activity.startWebhook(token);
    expect(started).toMatchObject({ ok: true, phase: 'queued' });
    expect(started.ok && started.readCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (!started.ok) throw new Error('expected webhook start');
    expect(await activity.getWebhookStatus(started.readCapability)).toMatchObject({ ok: true, terminal: false });
    expect(await activity.redeemWebhookResult(started.readCapability)).toEqual({ ok: false, reason: 'not-ready' });
    expect(await activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 1 } });
    expect(await activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { output: 'bounded' } })).toMatchObject({ ok: true });
    const first = await activity.redeemWebhookResult(started.readCapability);
    expect(first).toMatchObject({ ok: true, terminal: true, generation: 1, result: { output: 'bounded' } });
    const reconstructed = new OperatorActivity(ctx, activityEnv);
    const redemptions = await Promise.all([
      activity.redeemWebhookResult(started.readCapability),
      reconstructed.redeemWebhookResult(started.readCapability),
    ]);
    expect(redemptions).toEqual([first, first]);
    expect(await reconstructed.redeemWebhookResult('r'.repeat(43))).toEqual({ ok: false, reason: 'invalid-capability' });
    expect(await activity.getWebhookStatus(started.readCapability)).toEqual({ ok: false, reason: 'consumed' });
    expect(await reconstructed.continueWebhook(started.readCapability, 1)).toEqual({ ok: false, reason: 'consumed' });
    expect(await reconstructed.startWebhook(token)).toMatchObject({ ok: false });
  }, true, false));

  it('REQ-OPERATOR-053: original read authority survives only until activity deadline plus two hours', () => withActivity(async ({ activity, token, deadline }) => {
    const started = await activity.startWebhook(token);
    if (!started.ok) throw Error('Expected start');
    expect(await activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 1 } });
    expect(await activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { output: 'bounded' } })).toMatchObject({ ok: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(deadline + 2 * 60 * 60_000 - 1);
      expect(await activity.redeemWebhookResult(started.readCapability))
        .toMatchObject({ ok: true, terminal: true, result: { output: 'bounded' } });
      vi.setSystemTime(deadline + 2 * 60 * 60_000);
      expect(await activity.redeemWebhookResult(started.readCapability))
        .toEqual({ ok: false, reason: 'capability-expired' });
    } finally { vi.useRealTimers(); }
  }, true, false));

  it('caps an already-issued read capability at the deadline plus two hours', () => withActivity(async ({ activity, token, ctx, deadline }) => {
    const started = await activity.startWebhook(token);
    if (!started.ok) throw Error('Expected start');
    expect(await activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 1 } });
    expect(await activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { output: 'bounded' } })).toMatchObject({ ok: true });
    // A previously issued capability may carry the older seven-day persisted expiry.
    const existing = await ctx.storage.get<{ webhook: { expiresAt: number } }>('admission');
    await ctx.storage.put('admission', { ...existing, webhook: { ...existing!.webhook,
      expiresAt: deadline + 7 * 24 * 60 * 60_000 } });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(deadline + 2 * 60 * 60_000);
      expect(await activity.redeemWebhookResult(started.readCapability))
        .toEqual({ ok: false, reason: 'capability-expired' });
      expect(await activity.getWebhookStatus(started.readCapability))
        .toEqual({ ok: false, reason: 'capability-expired' });
    } finally { vi.useRealTimers(); }
  }, true, false));

  it('rejects terminal reread when its original read authority has expired', () => withActivity(async ({ activity, token, ctx, activityEnv }) => {
    const started = await activity.startWebhook(token);
    if (!started.ok) throw Error('Expected start');
    expect(await activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 1 } });
    expect(await activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { output: 'bounded' } })).toMatchObject({ ok: true });
    expect(await activity.redeemWebhookResult(started.readCapability)).toMatchObject({ ok: true, terminal: true });
    const state = await ctx.storage.get<{ webhook: { expiresAt: number } }>('admission');
    if (!state) throw Error('Expected admitted read authority');
    await ctx.storage.put('admission', { ...state, webhook: { ...state.webhook, expiresAt: Date.now() - 1 } });
    expect(await new OperatorActivity(ctx, activityEnv).redeemWebhookResult(started.readCapability))
      .toEqual({ ok: false, reason: 'capability-expired' });
  }, true, false));

  it('REQ-OPERATOR-053: webhook continuation is single-use for each durable waiting generation', () => withActivity(async ({ activity, token, ctx, activityEnv }) => {
    const started = await activity.startWebhook(token);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('expected webhook start');
    expect(await activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 1 } });
    expect(await activity.continueWebhook(started.readCapability, 1)).toEqual({ ok: false, reason: 'not-ready' });
    expect(await activity.commitDrive(1, { schemaVersion: 1, status: 'waiting', checkpoint: { step: 1 } }))
      .toMatchObject({ ok: true });
    expect(await activity.getWebhookStatus(started.readCapability))
      .toMatchObject({ ok: true, terminal: false, status: 'waiting', generation: 1 });
    const contenders = await Promise.all([
      activity.continueWebhook(started.readCapability, 1), activity.continueWebhook(started.readCapability, 1),
    ]);
    expect(contenders.filter(outcome => outcome.ok)).toEqual([{ ok: true, phase: 'queued' }]);
    expect(contenders.filter(outcome => !outcome.ok)).toEqual([{ ok: false, reason: 'already-started' }]);
    const reconstructed = new OperatorActivity(ctx, activityEnv);
    expect(await reconstructed.continueWebhook(started.readCapability, 1))
      .toEqual({ ok: false, reason: 'already-started' });
    expect(await activity.getWebhookStatus(started.readCapability))
      .toMatchObject({ ok: true, status: 'waiting', generation: 1 });
    expect(await activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 2 } });
    expect(await activity.commitDrive(2, { schemaVersion: 1, status: 'waiting', checkpoint: { step: 2 } }))
      .toMatchObject({ ok: true });
    expect(await activity.getWebhookStatus(started.readCapability))
      .toMatchObject({ ok: true, status: 'waiting', generation: 2 });
    expect(await activity.continueWebhook(started.readCapability, 1))
      .toEqual({ ok: false, reason: 'stale-generation' });
    expect(await activity.beginDrive(1)).toEqual({ ok: false, reason: 'stale-drive' });
    expect(await activity.fenceRuntimeFailure(1)).toEqual({ ok: false, reason: 'stale-drive' });
    expect(await activity.getWebhookStatus(started.readCapability))
      .toMatchObject({ ok: true, status: 'waiting', generation: 2 });
    expect(await activity.continueWebhook(started.readCapability, 2)).toEqual({ ok: true, phase: 'queued' });
    expect(await activity.beginDrive(2)).toMatchObject({ ok: true, state: { generation: 3 } });
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
