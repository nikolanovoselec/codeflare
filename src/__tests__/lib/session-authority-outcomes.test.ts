import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { D1SessionRepository } from '../../lib/session-repository';
import { validateSessionAndCheckLimits } from '../../routes/container/lifecycle-validation';
import type { Env } from '../../types';
import { getMaxSessions } from '../../lib/constants';
import { getDefaultTiers, resetTierConfigCache } from '../../lib/subscription';
import { getTiersConfigKey } from '../../lib/kv-keys';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import migration from '../../../migrations/usage/0002_runtime_sessions.sql?raw';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import boundary from '../../../migrations/usage/0004_boundary_activity.sql?raw';

const bindings = env as unknown as Env;
const db = bindings.USAGE_DB;
const time = '2027-01-01T00:00:00.000Z';
const input = (ownerKey = 'authority-owner', sessionId = 'session01'): Parameters<D1SessionRepository['create']>[0] => ({
  ownerKey, sessionId, name: 'Persistent workspace', createdAt: time, lastAccessedAt: time,
  workspace: 'terminal', terminalMode: 'classic', tabConfig: [],
  clone: { repo: 'example/primary', ref: 'main' }, clones: [{ repo: 'example/secondary' }],
});
const repository = () => new D1SessionRepository(db);

beforeAll(async () => {
  for (const source of [migration, boundary]) {
    for (const statement of source.split(';').map((part: string) => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
});
beforeEach(async () => {
  await db.prepare('DELETE FROM runtime_sessions').run();
  await db.prepare("UPDATE session_cutover SET state = 'complete', completed_at = '2027-01-01T00:00:00.000Z' WHERE id = 1").run();
  await bindings.KV.delete(getTiersConfigKey());
  resetTierConfigCache();
});

// Actual owner methods and real D1; SQL above is fixture setup, not behavioral proof.
describe('D1 production authority outcomes', () => {
  it('REQ-SESSION-001 AC3 / REQ-SESSION-018 AC2: optional creation survives a new repository instance with owner isolation', async () => {
    const created = await repository().create(input());
    const expected = { ...input(), lifecycleState: 'stopped', lifecycleGeneration: 0,
      responseRevision: 0, observationSequence: -1, editorReady: false, editorReadyError: false };
    expect(created).toEqual(expected);
    const restored = await repository().getSession('authority-owner', 'session01');
    expect(restored).toMatchObject({ ...expected, transitionedAt: time, agentType: undefined,
      cpu: undefined, memory: undefined, disk: undefined, syncStatus: undefined,
      unreachableIncidentId: undefined, unreachableDeadlineMs: undefined,
      terminationIntentId: undefined, terminationGeneration: undefined, boundaryActivityId: undefined });
    expect(await repository().getSession('another-owner', 'session01')).toBeNull();
    await repository().create(input('another-owner'));
    await expect(repository().create(input())).rejects.toThrow();
    expect(await repository().listSessions('authority-owner')).toEqual([restored]);
  });

  it('REQ-SESSION-001 AC3 / REQ-SESSION-031 AC1: valid agent and six configured tabs retain complete nonsecret creation data', async () => {
    const complete = { ...input(), agentType: 'pi' as const,
      tabConfig: Array.from({ length: 6 }, (_, index) => ({ id: String(index + 1), command: index ? '' : 'pi', label: `Workspace ${index + 1}` })) };
    await repository().create(complete);
    expect(await repository().getSession('authority-owner', 'session01')).toMatchObject({ ...complete,
      lifecycleState: 'stopped', lifecycleGeneration: 0, responseRevision: 0,
      observationSequence: -1, editorReady: false, editorReadyError: false, transitionedAt: time });
  });

  it('REQ-SESSION-001: mutable metadata preserves creation identity and workspace choices', async () => {
    const repo = repository();
    await repo.create(input());
    const before = await repo.getSession('authority-owner', 'session01');
    expect(before).not.toBeNull();
    const lastAccessedAt = '2027-01-01T00:01:00.000Z';
    const changed = await repo.updateMutable('authority-owner', 'session01', { name: 'Renamed workspace', lastAccessedAt });
    expect(changed).toEqual({ ...before, name: 'Renamed workspace', lastAccessedAt, responseRevision: before!.responseRevision + 1 });
    expect(await repository().getSession('authority-owner', 'session01')).toEqual(changed);
    expect(await repo.updateMutable('another-owner', 'session01', { name: 'Wrong owner', lastAccessedAt })).toBeNull();
    expect(await repository().getSession('authority-owner', 'session01')).toEqual(changed);
  });

  it('REQ-SESSION-018 AC3/5: stale generation and non-increasing sequence leave the durable projection unchanged', async () => {
    const repo = repository();
    await repo.create(input());
    expect(await repo.start('authority-owner', 'session01', time)).toMatchObject({ lifecycleState: 'starting', lifecycleGeneration: 1, responseRevision: 1 });
    const projection = { lifecycleState: 'running' as const, observedAt: time, lastInputAt: time,
      cpu: '1%', memory: '2MB', disk: '3MB', syncStatus: 'success', editorReady: true, editorReadyError: false };
    expect(await repo.project('authority-owner', 'session01', 1, 3, projection)).toBe(true);
    const accepted = await repository().getSession('authority-owner', 'session01');
    expect(accepted).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 1, responseRevision: 2, observationSequence: 3, cpu: '1%', editorReady: true });
    for (const [generation, sequence] of [[0, 99], [2, 99], [1, 3], [1, 2]]) {
      expect(await repo.project('authority-owner', 'session01', generation, sequence, { ...projection, cpu: '99%', editorReady: false })).toBe(false);
      expect(await repository().getSession('authority-owner', 'session01')).toEqual(accepted);
    }
    expect(await repo.project('another-owner', 'session01', 1, 4, projection)).toBe(false);
    expect(await repository().getSession('authority-owner', 'session01')).toEqual(accepted);
    expect(await repo.project('authority-owner', 'session01', 1, 4, { ...projection, cpu: '4%' })).toBe(true);
    expect(await repository().getSession('authority-owner', 'session01')).toMatchObject({ responseRevision: 3, observationSequence: 4, cpu: '4%' });
  });

  it('REQ-SESSION-018 AC5: accepted boundary, Stop and exit transitions advance durable response revisions', async () => {
    const repo = repository();
    await repo.create(input());
    await repo.start('authority-owner', 'session01', time);
    await repo.project('authority-owner', 'session01', 1, 0, { lifecycleState: 'running', observedAt: time });
    let previous = (await repo.getSession('authority-owner', 'session01'))!;
    const advanced = async (outcome: Record<string, unknown>) => {
      const current = (await repository().getSession('authority-owner', 'session01'))!;
      expect(current).toMatchObject({ ...outcome, responseRevision: previous.responseRevision + 1 });
      previous = current;
    };
    expect(await repo.recordBoundaryActionStart('authority-owner', 'session01', 1, 'review-one')).toBe(true);
    await advanced({ boundaryActivityId: 'review-one', lifecycleState: 'running' });
    expect(await repo.releaseCompletedBoundaryAction('authority-owner', 'session01', 1, 'review-one')).toBe(true);
    await advanced({ boundaryActivityId: undefined });
    expect(await repo.recordBoundaryActionStart('authority-owner', 'session01', 1, 'review-two')).toBe(true);
    await advanced({ boundaryActivityId: 'review-two' });
    expect(await repo.claimStop('authority-owner', 'session01', 'stop-one', time, 1)).not.toBeNull();
    await advanced({ lifecycleState: 'stopping', terminationIntentId: 'stop-one' });
    expect(await repo.confirmStopped('authority-owner', 'session01', 1, 'stop-one', time)).toBe(false);
    expect(await repository().getSession('authority-owner', 'session01')).toEqual(previous);
    expect(await repo.acknowledgeBoundaryCancellation('authority-owner', 'session01', 1, 'review-two')).toBe(true);
    await advanced({ boundaryActivityId: undefined });
    expect(await repo.recordTerminationSignal('authority-owner', 'session01', 1, 'stop-one', time)).toBe(true);
    await advanced({ lifecycleState: 'stopping' });
    expect(await repo.confirmStopped('authority-owner', 'session01', 1, 'stop-one', time)).toBe(true);
    await advanced({ lifecycleState: 'stopped', terminationIntentId: undefined });
  });

  it('REQ-SESSION-018 AC4 / REQ-SESSION-028 AC4: retained stopped row restarts and Delete fences late writers', async () => {
    const repo = repository();
    await repo.create(input());
    await repo.start('authority-owner', 'session01', time);
    await repo.project('authority-owner', 'session01', 1, 0, { lifecycleState: 'running', observedAt: time });
    expect(await repo.deleteConfirmed('authority-owner', 'session01')).toBe(false);
    expect(await repo.claimStop('authority-owner', 'session01', 'stop-one', time, 1)).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 1 });
    expect(await repo.start('authority-owner', 'session01', time)).toBeNull();
    expect(await repository().getSession('authority-owner', 'session01')).toMatchObject({
      lifecycleState: 'stopping', lifecycleGeneration: 1, terminationIntentId: 'stop-one',
    });
    expect(await repo.confirmStopped('authority-owner', 'session01', 1, 'stop-one', time)).toBe(true);
    const stopped = await repository().getSession('authority-owner', 'session01');
    expect(stopped).toMatchObject({ ...input(), lifecycleState: 'stopped', lifecycleGeneration: 1 });
    expect(await repo.project('authority-owner', 'session01', 1, 9, { lifecycleState: 'running', observedAt: time })).toBe(false);
    expect(await repository().getSession('authority-owner', 'session01')).toEqual(stopped);
    const restarted = await repo.start('authority-owner', 'session01', time);
    expect(restarted).toMatchObject({ ...input(), lifecycleState: 'starting', lifecycleGeneration: 2 });
    expect(await repo.project('authority-owner', 'session01', 1, 99, { observedAt: time })).toBe(false);
    expect(await repository().getSession('authority-owner', 'session01')).toEqual(restarted);
    await repo.claimStop('authority-owner', 'session01', 'stop-two', time, 2);
    expect(await repo.confirmStopped('authority-owner', 'session01', 2, 'stop-two', time)).toBe(true);
    expect(await repo.deleteConfirmed('authority-owner', 'session01')).toBe(true);
    expect(await repo.project('authority-owner', 'session01', 2, 100, { observedAt: time })).toBe(false);
    expect(await repo.updateReadiness('authority-owner', 'session01', 2, true, false)).toBe(false);
    expect(await repo.updateTrackedClones('authority-owner', 'session01', [{ repo: 'example/late' }], { generation: 2, sequence: 101 })).toBe(false);
    expect(await repo.updateMutable('authority-owner', 'session01', { name: 'Late rename', lastAccessedAt: time })).toBeNull();
    expect(await repo.start('authority-owner', 'session01', time)).toBeNull();
    expect(await repository().listSessions('authority-owner')).toEqual([]);
  });
});

describe('REQ-SESSION-007: actual D1-backed capacity outcomes', () => {
  const admission = (sessionId = 'session01', maxSessions = 1, overrides: Partial<Env> = {}) =>
    validateSessionAndCheckLimits({ env: { ...bindings, SAAS_MODE: undefined, STRESS_TEST_MODE: undefined, ...overrides },
      bucketName: 'authority-owner', sessionId, maxSessions });

  it.each(['starting', 'running', 'unreachable', 'stopping'] as const)('AC1/2: %s denies another Start at cap without counting another owner', async state => {
    const repo = repository();
    await repo.create(input());
    await repo.create(input('authority-owner', 'session02'));
    await repo.create(input('another-owner', 'session03'));
    await repo.start('another-owner', 'session03', time);
    expect(await admission()).toMatchObject({ id: 'session01' });
    await repo.start('authority-owner', 'session02', time);
    if (state !== 'starting') await repo.project('authority-owner', 'session02', 1, 0, { lifecycleState: 'running', observedAt: time });
    if (state === 'unreachable') await repo.observeUnreachable('authority-owner', 'session02', 1, 1, 'incident', Date.parse(time));
    if (state === 'stopping') await repo.claimStop('authority-owner', 'session02', 'intent', time, 1);
    expect(await repo.getSession('authority-owner', 'session02')).toMatchObject({ lifecycleState: state });
    await expect(admission()).rejects.toThrow('Session limit reached (1/1)');
    expect(await repo.getSession('authority-owner', 'session01')).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 0 });
  });

  it('AC2/4: zero blocks empty capacity while stopped creation consumes no slot', async () => {
    await repository().create(input());
    await repository().create(input('authority-owner', 'session02'));
    await expect(admission('session01', 0)).rejects.toThrow('Session limit reached (0/0)');
    expect(await admission()).toMatchObject({ id: 'session01', status: 'stopped' });
  });

  it('AC3: existing non-SaaS stress bypass preserves the zero-cap exception', async () => {
    await repository().create(input());
    expect(await admission('session01', 0, { STRESS_TEST_MODE: 'active' })).toMatchObject({ id: 'session01' });
  });

  it('AC3: SaaS tier capacity wins over role cap and preserves explicit zero', async () => {
    await repository().create(input());
    const validate = () => validateSessionAndCheckLimits({ env: { ...bindings, SAAS_MODE: 'active', STRESS_TEST_MODE: undefined, ENTERPRISE_MODE: undefined },
      bucketName: 'authority-owner', sessionId: 'session01', maxSessions: 10, subscriptionTier: 'free' });
    await bindings.KV.put(getTiersConfigKey(), JSON.stringify(getDefaultTiers().map(tier => tier.id === 'free' ? { ...tier, maxSessions: 0 } : tier)));
    await expect(validate()).rejects.toThrow('Session limit reached (0/0)');
    await bindings.KV.put(getTiersConfigKey(), JSON.stringify(getDefaultTiers().map(tier => tier.id === 'free' ? { ...tier, maxSessions: 1, monthlySeconds: null } : tier)));
    resetTierConfigCache();
    expect(await validate()).toMatchObject({ id: 'session01' });
  });

  it('AC3: role defaults and deployment overrides do not lose explicit zero', async () => {
    await repository().create(input());
    for (const id of ['session02', 'session03', 'session04']) {
      await repository().create(input('authority-owner', id));
      await repository().start('authority-owner', id, time);
    }
    await expect(admission('session01', getMaxSessions('user', {}))).rejects.toThrow('Session limit reached (3/3)');
    expect(await admission('session01', getMaxSessions('admin', {}))).toMatchObject({ id: 'session01' });
    expect(await admission('session01', getMaxSessions('user', { MAX_SESSIONS_USER: '4' }))).toMatchObject({ id: 'session01' });
    await expect(admission('session01', getMaxSessions('admin', { MAX_SESSIONS_ADMIN: '3' }))).rejects.toThrow('Session limit reached (3/3)');
    await expect(admission('session01', getMaxSessions('user', { MAX_SESSIONS_USER: '0' }))).rejects.toThrow('Session limit reached (3/0)');
    await expect(admission('session01', getMaxSessions('admin', { MAX_SESSIONS_ADMIN: '0' }))).rejects.toThrow('Session limit reached (3/0)');
  });

  it('AC5: unavailable D1 rejects admission without changing durable authority', async () => {
    await repository().create(input());
    const before = await repository().getSession('authority-owner', 'session01');
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
      if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
      if (key === 'all') return async () => { throw new Error('injected D1 outage'); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const unavailable = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(admission('session01', 1, { USAGE_DB: unavailable })).rejects.toThrow('injected D1 outage');
    expect(await repository().getSession('authority-owner', 'session01')).toEqual(before);
  });

  it('AC6: concurrent validations and later Start claims retain the specified best-effort semantics', async () => {
    const repo = repository();
    await repo.create(input());
    await repo.create(input('authority-owner', 'session02'));
    const validated = await Promise.all([admission('session01'), admission('session02')]);
    expect(validated.map(session => session.id)).toEqual(['session01', 'session02']);
    const started = await Promise.all([repo.start('authority-owner', 'session01', time), repo.start('authority-owner', 'session02', time)]);
    expect(started.map(session => session?.lifecycleState)).toEqual(['starting', 'starting']);
    expect((await repository().listSessions('authority-owner')).filter(session => session.lifecycleState === 'starting').map(session => session.sessionId).sort())
      .toEqual(['session01', 'session02']);
  });
});
