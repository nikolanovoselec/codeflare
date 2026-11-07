import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1SessionRepository } from '../../lib/session-repository';
import { confirmMonitoredExit } from '../../container/container-lifecycle';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import migration from '../../../migrations/usage/0002_runtime_sessions.sql?raw';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import boundaryMigration from '../../../migrations/usage/0004_boundary_activity.sql?raw';

const db = (env as unknown as { USAGE_DB: D1Database }).USAGE_DB;

async function row(owner = 'owner-a', sessionId = 'session01') {
  return db.prepare(`SELECT lifecycle_state, lifecycle_generation, response_revision,
      observation_sequence, unreachable_incident_id, unreachable_deadline_ms,
      termination_intent_id, termination_generation
    FROM runtime_sessions WHERE owner_key = ?1 AND session_id = ?2`)
    .bind(owner, sessionId).first<Record<string, string | number | null>>();
}

async function createSession(owner = 'owner-a', sessionId = 'session01') {
  await db.prepare(`INSERT INTO runtime_sessions
    (owner_key, session_id, name, created_at, last_accessed_at, workspace, terminal_mode,
     lifecycle_state, lifecycle_generation, response_revision, observation_sequence,
     editor_ready, editor_ready_error, transitioned_at)
    VALUES (?1, ?2, 'Terminal', '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z',
      'terminal', 'classic', 'stopped', 0, 0, -1, 0, 0, '2027-01-01T00:00:00.000Z')`)
    .bind(owner, sessionId).run();
}

beforeAll(async () => {
  for (const statement of migration.split(';').map((part: string) => part.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
  for (const statement of boundaryMigration.split(';').map((part: string) => part.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
});

beforeEach(async () => {
  await db.prepare('DELETE FROM runtime_sessions').run();
  await db.prepare("UPDATE session_cutover SET state = 'complete', completed_at = '2027-01-01T00:00:00.000Z' WHERE id = 1").run();
});

describe('REQ-SESSION-031: complete D1 session authority', () => {
  it('migration creates a pending singleton gate and one owner-led projection index', async () => {
    await db.prepare("UPDATE session_cutover SET state = 'pending', completed_at = NULL WHERE id = 1").run();
    expect(await db.prepare('SELECT id, state FROM session_cutover').first()).toEqual({ id: 1, state: 'pending' });

    const indexes = await db.prepare("PRAGMA index_list('runtime_sessions')").all<{ name: string }>();
    const named = indexes.results.filter(({ name }) => !name.startsWith('sqlite_autoindex'));
    expect(named).toHaveLength(1);
    const columns = await db.prepare(`PRAGMA index_info('${named[0]?.name}')`).all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual(['owner_key', 'last_accessed_at', 'session_id']);
  });

  it('retries a confirmed exit after a pending boundary cancellation fails, then releases ownership', async () => {
    await createSession();
    const repository = new D1SessionRepository(db);
    await repository.start('owner-a', 'session01', '2027-01-01T00:00:01.000Z');
    await db.prepare("UPDATE runtime_sessions SET lifecycle_state='running' WHERE owner_key='owner-a' AND session_id='session01'").run();
    expect(await repository.recordBoundaryActionStart('owner-a', 'session01', 1, 'activity-1')).toBe(true);
    const binding = { session: { bucket: 'owner-a', sessionId: 'session01', generation: 1 } };
    const cancelBoundaryStart = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    const actor = { getBoundaryStartBinding: vi.fn().mockResolvedValue(binding), cancelBoundaryStart };
    const storage = new Map<string, unknown>([['lifecycleGeneration', 1]]);
    const ctx = { storage: { transaction: async (work: (tx: unknown) => Promise<void>) => work({
      get: async (key: string) => storage.get(key), put: async (key: string, value: unknown) => { storage.set(key, value); },
    }) } };
    const runtimeEnv = { USAGE_DB: db, OPERATOR_ACTIVITY: { getByName: () => actor } };
    await expect(confirmMonitoredExit(ctx as never, runtimeEnv as never, 'owner-a', 'session01', 1)).rejects.toThrow('cancellation unavailable');
    expect(await repository.getSession('owner-a', 'session01')).toMatchObject({ lifecycleState: 'stopping', boundaryActivityId: 'activity-1' });
    expect(await confirmMonitoredExit(ctx as never, runtimeEnv as never, 'owner-a', 'session01', 1)).toBe(true);
    expect(await repository.getSession('owner-a', 'session01')).toMatchObject({ lifecycleState: 'stopped' });
  });

  it('rejects an old monitor generation before claiming Stop on a replacement', async () => {
    await createSession();
    const repository = new D1SessionRepository(db);
    expect(await repository.start('owner-a', 'session01', '2027-01-01T00:00:01.000Z')).toMatchObject({ lifecycleGeneration: 1 });
    expect(await repository.claimStop('owner-a', 'session01', 'old-exit', '2027-01-01T00:00:02.000Z', 0)).toBeNull();
    expect(await repository.getSession('owner-a', 'session01')).toMatchObject({ lifecycleState: 'starting', lifecycleGeneration: 1 });
  });

  it('REQ-SESSION-035: aged Stop ownership remains fenced until its current-generation exit is confirmed', async () => {
    const repository = new D1SessionRepository(db);
    for (const [owner, sessionId] of [
      ['owner-a', 'expired01'], ['owner-a', 'boundary1'], ['owner-a', 'starting1'],
      ['owner-a', 'running01'], ['owner-a', 'unreach01'], ['owner-a', 'stopped01'],
      ['owner-b', 'expired02'],
    ] as const) await createSession(owner, sessionId);
    await db.prepare(`UPDATE runtime_sessions SET
      lifecycle_state='stopping', lifecycle_generation=2, response_revision=4,
      transitioned_at=?3, lifecycle_reason='idle-stop', last_started_at='2027-01-01T00:00:10.000Z',
      last_active_at='2027-01-01T00:00:20.000Z', editor_ready=1, editor_ready_error=1,
      unreachable_incident_id='incident', unreachable_first_observed_at=?3, unreachable_deadline_ms=60000,
      termination_intent_id='intent', termination_generation=2, termination_claimed_at=?3,
      termination_signal_accepted_at=?3
      WHERE owner_key=?1 AND session_id=?2`)
      .bind('owner-a', 'expired01', '2027-01-01T00:00:00.000Z').run();
    for (const [owner, sessionId] of [['owner-a', 'boundary1'], ['owner-b', 'expired02']] as const) {
      await db.prepare(`UPDATE runtime_sessions SET lifecycle_state='stopping', transitioned_at=?3,
        termination_intent_id='intent', termination_generation=0, termination_claimed_at=?3
        WHERE owner_key=?1 AND session_id=?2`)
        .bind(owner, sessionId, owner === 'owner-a' ? '2027-01-01T00:00:00.001Z' : '2027-01-01T00:00:00.000Z').run();
    }
    for (const [sessionId, state] of [
      ['starting1', 'starting'], ['running01', 'running'], ['unreach01', 'unreachable'],
    ] as const) {
      await db.prepare(`UPDATE runtime_sessions SET lifecycle_state=?3, transitioned_at='2027-01-01T00:00:00.000Z'
        WHERE owner_key=?1 AND session_id=?2`).bind('owner-a', sessionId, state).run();
    }

    const expired = await repository.getSession('owner-a', 'expired01');
    expect(expired).toMatchObject({
      lifecycleState: 'stopping', lifecycleGeneration: 2, responseRevision: 4,
      editorReady: true, editorReadyError: true, terminationIntentId: 'intent',
      unreachableIncidentId: 'incident', unreachableDeadlineMs: 60000,
    });
    const reason = async () => (await db.prepare('SELECT lifecycle_reason FROM runtime_sessions WHERE owner_key=?1 AND session_id=?2')
      .bind('owner-a', 'expired01').first<{ lifecycle_reason: string }>())?.lifecycle_reason;
    expect(await reason()).toBe('idle-stop');
    expect(await repository.start('owner-a', 'expired01', '2027-01-01T00:10:00.000Z')).toBeNull();
    expect(await reason()).toBe('idle-stop');
    expect(await repository.confirmStopped('owner-a', 'expired01', 1, 'intent', '2027-01-01T00:10:00.000Z')).toBe(false);
    expect(await repository.confirmStopped('owner-a', 'expired01', 2, 'intent', '2027-01-01T00:10:00.000Z')).toBe(true);
    // A positive process monitor can beat a concurrent completed destroy;
    // only the matching generation makes the second confirmation idempotent.
    expect(await repository.confirmStoppedOrObserved('owner-a', 'expired01', 2, 'intent', '2027-01-01T00:10:01.000Z')).toBe(true);
    expect(await repository.confirmStoppedOrObserved('owner-a', 'expired01', 1, 'intent', '2027-01-01T00:10:01.000Z')).toBe(false);
    expect(await repository.getSession('owner-a', 'expired01')).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 2 });
    expect(await reason()).toBe('idle-stop');
    for (const [owner, sessionId, state] of [
      ['owner-a', 'boundary1', 'stopping'], ['owner-a', 'starting1', 'starting'],
      ['owner-a', 'running01', 'running'], ['owner-a', 'unreach01', 'unreachable'],
      ['owner-a', 'stopped01', 'stopped'], ['owner-b', 'expired02', 'stopping'],
    ] as const) {
      expect((await db.prepare('SELECT lifecycle_state FROM runtime_sessions WHERE owner_key=?1 AND session_id=?2')
        .bind(owner, sessionId).first())?.lifecycle_state).toBe(state);
    }
  });

  it('creates stopped and accepts one conditional Start generation claim', async () => {
    await createSession();
    const start = await db.prepare(`UPDATE runtime_sessions SET
        lifecycle_state = 'starting', lifecycle_generation = lifecycle_generation + 1,
        response_revision = response_revision + 1, observation_sequence = -1
      WHERE owner_key = ?1 AND session_id = ?2 AND lifecycle_state = 'stopped'
        AND termination_intent_id IS NULL
        AND EXISTS (SELECT 1 FROM session_cutover WHERE id = 1 AND state = 'complete')`)
      .bind('owner-a', 'session01').run();
    const duplicate = await db.prepare(`UPDATE runtime_sessions SET lifecycle_generation = lifecycle_generation + 1
      WHERE owner_key = ?1 AND session_id = ?2 AND lifecycle_state = 'stopped'`)
      .bind('owner-a', 'session01').run();

    expect(start.meta.changes).toBe(1);
    expect(duplicate.meta.changes).toBe(0);
    expect(await row()).toMatchObject({ lifecycle_state: 'starting', lifecycle_generation: 1, response_revision: 1, observation_sequence: -1 });
  });

  it('REQ-OPERATOR-054: Stop wins before claim or retains the exact Action activity until durable cancellation', async () => {
    const repository = new D1SessionRepository(db);
    for (const sessionId of ['session01', 'session02']) {
      await createSession('owner-a', sessionId);
      await db.prepare("UPDATE runtime_sessions SET lifecycle_state='running', lifecycle_generation=2 WHERE owner_key='owner-a' AND session_id=?1")
        .bind(sessionId).run();
    }
    const firstStop = await repository.claimStop('owner-a', 'session02', 'stop-first', new Date().toISOString());
    expect(firstStop?.lifecycleState).toBe('stopping');
    expect(await repository.recordBoundaryActionStart('owner-a', 'session02', 2, 'review-two')).toBe(false);
    expect(await repository.recordBoundaryActionStart('owner-b', 'session01', 2, 'review-one')).toBe(false);
    expect(await repository.recordBoundaryActionStart('owner-a', 'session01', 1, 'review-one')).toBe(false);
    expect(await repository.recordBoundaryActionStart('owner-a', 'session01', 2, 'review-one')).toBe(true);
    expect(await repository.getSession('owner-a', 'session01'))
      .toMatchObject({ lifecycleState: 'running', boundaryActivityId: 'review-one' });
    expect(await repository.recordBoundaryActionStart('owner-a', 'session01', 2, 'review-one')).toBe(true);
    const stopped = await repository.claimStop('owner-a', 'session01', 'stop-second', new Date().toISOString());
    expect(stopped).toMatchObject({ lifecycleState: 'stopping', boundaryActivityId: 'review-one' });
    expect(await repository.recordBoundaryActionStart('owner-a', 'session01', 2, 'review-other')).toBe(false);
    expect(await repository.isBoundaryActionPending('owner-a', 'session01', 2, 'review-one')).toBe(true);
    expect(await repository.isBoundaryActionPending('owner-a', 'session01', 2, 'review-one', true)).toBe(false);
    expect(await repository.isBoundaryActionPending('owner-a', 'session01', 1, 'review-one')).toBe(false);
    expect(await repository.acknowledgeBoundaryCancellation('owner-a', 'session01', 2, 'review-other')).toBe(false);
    expect(await repository.acknowledgeBoundaryCancellation('owner-b', 'session01', 2, 'review-one')).toBe(false);
    expect(await repository.confirmStopped('owner-a', 'session01', 2, 'stop-second', new Date().toISOString())).toBe(false);
    expect(await repository.acknowledgeBoundaryCancellation('owner-a', 'session01', 2, 'review-one')).toBe(true);
    expect(await repository.isBoundaryActionPending('owner-a', 'session01', 2, 'review-one')).toBe(false);
    expect(await repository.confirmStopped('owner-a', 'session01', 2, 'stop-second', new Date().toISOString())).toBe(true);
    const restarted = await repository.start('owner-a', 'session01', new Date().toISOString());
    expect(restarted?.lifecycleGeneration).toBe(3);
    await db.prepare("UPDATE runtime_sessions SET lifecycle_state='running' WHERE owner_key='owner-a' AND session_id='session01'").run();
    expect(await repository.recordBoundaryActionStart('owner-a', 'session01', 2, 'review-one')).toBe(false);
    expect(await repository.recordBoundaryActionStart('owner-a', 'session01', 3, 'review-three')).toBe(true);
  });

  it('REQ-OPERATOR-053: only the exact completed review releases the running session for a second review', async () => {
    const repository = new D1SessionRepository(db);
    await createSession();
    await db.prepare("UPDATE runtime_sessions SET lifecycle_state='running', lifecycle_generation=1 WHERE owner_key='owner-a' AND session_id='session01'").run();
    expect(await repository.recordBoundaryActionStart('owner-a', 'session01', 1, 'review-one')).toBe(true);
    expect(await repository.recordBoundaryActionStart('owner-a', 'session01', 1, 'review-two')).toBe(false);
    expect(await repository.releaseCompletedBoundaryAction('owner-a', 'session01', 1, 'review-other')).toBe(false);
    expect(await repository.releaseCompletedBoundaryAction('owner-b', 'session01', 1, 'review-one')).toBe(false);
    expect(await repository.releaseCompletedBoundaryAction('owner-a', 'session01', 2, 'review-one')).toBe(false);
    expect(await repository.releaseCompletedBoundaryAction('owner-a', 'session01', 1, 'review-one')).toBe(true);
    expect(await repository.recordBoundaryActionStart('owner-a', 'session01', 1, 'review-two')).toBe(true);
    expect(await repository.claimStop('owner-a', 'session01', 'stop-review-two', new Date().toISOString()))
      .toMatchObject({ boundaryActivityId: 'review-two' });
    expect(await repository.releaseCompletedBoundaryAction('owner-a', 'session01', 1, 'review-two')).toBe(false);
    expect(await repository.confirmStopped('owner-a', 'session01', 1, 'stop-review-two', new Date().toISOString())).toBe(false);
  });

  it('REQ-OPERATOR-054: owner cleanup cannot erase unfenced Action work', async () => {
    const repository = new D1SessionRepository(db);
    await createSession();
    await db.prepare("UPDATE runtime_sessions SET lifecycle_state='running', lifecycle_generation=1 WHERE owner_key='owner-a' AND session_id='session01'").run();
    expect(await repository.recordBoundaryActionStart('owner-a', 'session01', 1, 'review-one')).toBe(true);
    expect(await repository.claimStop('owner-a', 'session01', 'stop-one', new Date().toISOString()))
      .toMatchObject({ boundaryActivityId: 'review-one' });
    expect(await repository.deleteOwnerSessions('owner-a')).toBe(0);
    expect(await repository.getSession('owner-a', 'session01'))
      .toMatchObject({ lifecycleState: 'stopping', boundaryActivityId: 'review-one' });
    expect(await repository.confirmStopped('owner-a', 'session01', 1, 'stop-one', new Date().toISOString())).toBe(false);
    expect(await repository.start('owner-a', 'session01', new Date().toISOString())).toBeNull();
    expect(await repository.deleteConfirmed('owner-a', 'session01')).toBe(false);
    expect(await repository.acknowledgeBoundaryCancellation('owner-a', 'session01', 1, 'review-one')).toBe(true);
    expect(await repository.getSession('owner-a', 'session01')).toMatchObject({ lifecycleState: 'stopping', terminationIntentId: 'stop-one' });
  });

  it('rejects old generations and delayed or equal observation sequences', async () => {
    await createSession();
    await db.prepare("UPDATE runtime_sessions SET lifecycle_state='running', lifecycle_generation=2, response_revision=4, observation_sequence=3 WHERE owner_key='owner-a' AND session_id='session01'").run();
    const project = (generation: number, sequence: number, cpu: string) => db.prepare(`UPDATE runtime_sessions SET
        cpu = ?1, observation_sequence = ?2, response_revision = response_revision + 1
      WHERE owner_key = 'owner-a' AND session_id = 'session01'
        AND lifecycle_generation = ?3 AND ?2 > observation_sequence`)
      .bind(cpu, sequence, generation).run();

    expect((await project(1, 99, 'old-generation')).meta.changes).toBe(0);
    expect((await project(2, 3, 'equal-sequence')).meta.changes).toBe(0);
    expect((await project(2, 2, 'delayed-sequence')).meta.changes).toBe(0);
    expect((await project(2, 4, 'accepted')).meta.changes).toBe(1);
    expect(await db.prepare("SELECT cpu, observation_sequence, response_revision FROM runtime_sessions WHERE owner_key='owner-a' AND session_id='session01'").first())
      .toEqual({ cpu: 'accepted', observation_sequence: 4, response_revision: 5 });
  });

  it('opens one incident, preserves its absolute deadline, and fences recovery by identity', async () => {
    await createSession();
    await db.prepare("UPDATE runtime_sessions SET lifecycle_state='running', lifecycle_generation=1 WHERE owner_key='owner-a' AND session_id='session01'").run();
    const open = (id: string, deadline: number) => db.prepare(`UPDATE runtime_sessions SET
        lifecycle_state='unreachable', unreachable_incident_id=?1,
        unreachable_first_observed_at='2027-01-01T00:01:00.000Z', unreachable_deadline_ms=?2,
        response_revision=response_revision+1
      WHERE owner_key='owner-a' AND session_id='session01' AND lifecycle_generation=1
        AND lifecycle_state='running' AND unreachable_incident_id IS NULL`).bind(id, deadline).run();

    expect((await open('incident-a', 120_000)).meta.changes).toBe(1);
    expect((await open('incident-b', 240_000)).meta.changes).toBe(0);
    expect(await row()).toMatchObject({ lifecycle_state: 'unreachable', unreachable_incident_id: 'incident-a', unreachable_deadline_ms: 120_000 });

    const wrongRecovery = await db.prepare(`UPDATE runtime_sessions SET lifecycle_state='running', unreachable_incident_id=NULL,
      unreachable_first_observed_at=NULL, unreachable_deadline_ms=NULL WHERE owner_key='owner-a' AND session_id='session01'
      AND lifecycle_generation=1 AND unreachable_incident_id='incident-b'`).run();
    expect(wrongRecovery.meta.changes).toBe(0);
  });

  it('claims termination once and requires confirmed exit before stopped', async () => {
    await createSession();
    await db.prepare(`UPDATE runtime_sessions SET lifecycle_state='unreachable', lifecycle_generation=3,
      unreachable_incident_id='incident-a', unreachable_first_observed_at='2027-01-01T00:01:00.000Z',
      unreachable_deadline_ms=120000 WHERE owner_key='owner-a' AND session_id='session01'`).run();
    const claim = await db.prepare(`UPDATE runtime_sessions SET lifecycle_state='stopping',
      termination_intent_id='term-a', termination_generation=3,
      termination_claimed_at='2027-01-01T00:03:00.000Z', response_revision=response_revision+1
      WHERE owner_key='owner-a' AND session_id='session01' AND lifecycle_generation=3
      AND lifecycle_state='unreachable' AND unreachable_incident_id='incident-a'
      AND unreachable_deadline_ms <= 180000 AND termination_intent_id IS NULL`).run();
    expect(claim.meta.changes).toBe(1);
    expect(await row()).toMatchObject({ lifecycle_state: 'stopping', termination_intent_id: 'term-a', termination_generation: 3 });

    await expect(new D1SessionRepository(db).project('owner-a', 'session01', 3, 99, {
      lifecycleState: 'running', observedAt: '2027-01-01T00:03:00.500Z',
    })).resolves.toBe(false);
    expect((await row())?.lifecycle_state).toBe('stopping');

    await db.prepare("UPDATE runtime_sessions SET termination_signal_accepted_at='2027-01-01T00:03:01.000Z' WHERE owner_key='owner-a' AND session_id='session01'").run();
    expect((await row())?.lifecycle_state).toBe('stopping');
    const confirmed = await db.prepare(`UPDATE runtime_sessions SET lifecycle_state='stopped',
      unreachable_incident_id=NULL, unreachable_first_observed_at=NULL, unreachable_deadline_ms=NULL,
      termination_intent_id=NULL, termination_generation=NULL, termination_claimed_at=NULL,
      termination_signal_accepted_at=NULL, response_revision=response_revision+1
      WHERE owner_key='owner-a' AND session_id='session01' AND lifecycle_generation=3
      AND lifecycle_state='stopping' AND termination_intent_id='term-a'`).run();
    expect(confirmed.meta.changes).toBe(1);
    expect((await row())?.lifecycle_state).toBe('stopped');
  });

  it('hard delete cannot be undone by a delayed UPDATE-only writer', async () => {
    await createSession();
    await db.prepare("DELETE FROM runtime_sessions WHERE owner_key='owner-a' AND session_id='session01'").run();
    const delayed = await db.prepare(`UPDATE runtime_sessions SET lifecycle_state='running'
      WHERE owner_key='owner-a' AND session_id='session01' AND lifecycle_generation=0`).run();
    expect(delayed.meta.changes).toBe(0);
    expect(await row()).toBeNull();
  });
});

describe('REQ-SESSION-018/020–026/035: bounded unreachable runtime ownership', () => {
  const at = 1_800_000_000_000;
  const owner = 'owner-a';
  const id = 'session01';
  const pin = { ownerKey: owner, sessionId: id, generation: 1 };
  const repository = () => new D1SessionRepository(db);
  async function running() {
    await createSession();
    await repository().start(owner, id, new Date(at).toISOString());
    await repository().project(owner, id, 1, 0, { lifecycleState: 'running', observedAt: new Date(at).toISOString() });
  }
  async function incident(sequence = 1) {
    return repository().observeUnreachable(owner, id, 1, sequence, 'incident-a', at);
  }

  it('persists the first complete failure, joins replay/reconstruction without extending its 120s deadline', async () => {
    await running();
    const first = await incident();
    expect(first).toMatchObject({ lifecycleState: 'unreachable', observationSequence: 1,
      unreachableIncidentId: 'incident-a', unreachableFirstObservedAt: new Date(at).toISOString(), unreachableDeadlineMs: at + 120_000 });
    await repository().observeUnreachable(owner, id, 1, 2, 'incident-b', at + 60_000);
    const joined = await repository().getSession(owner, id);
    expect(joined).toMatchObject({ lifecycleState: 'unreachable', observationSequence: 2,
      unreachableIncidentId: 'incident-a', unreachableDeadlineMs: at + 120_000 });
    expect(joined!.responseRevision).toBe(first!.responseRevision + 1);
    await repository().observeUnreachable(owner, id, 1, 2, 'replay', at + 90_000);
    expect(await repository().getSession(owner, id)).toEqual(joined);
  });

  it('an unreachable workload retains capacity and managed reconciliation ownership', async () => {
    await running(); await incident();
    const { countWorkloadOwningSessions } = await import('../../lib/session-authority');
    const { hasOwningSessionContainer } = await import('../../lib/session-helpers');
    expect(await countWorkloadOwningSessions(repository(), owner)).toBe(1);
    expect(await hasOwningSessionContainer({ USAGE_DB: db }, owner)).toBe(true);
    expect(await hasOwningSessionContainer({ USAGE_DB: db }, 'other-owner')).toBe(false);
  });

  it('ordinary projections cannot clear an incident; exact incident recovery fences older failures', async () => {
    await running(); await incident();
    expect(await repository().project(owner, id, 1, 2, { lifecycleState: 'running', observedAt: new Date(at).toISOString() })).toBe(false);
    expect(await repository().recoverUnreachable(owner, id, 1, 2, 'wrong', new Date(at).toISOString())).toBe(false);
    expect(await repository().recoverUnreachable(owner, id, 1, 2, 'incident-a', new Date(at).toISOString())).toBe(true);
    expect(await repository().observeUnreachable(owner, id, 1, 1, 'late', at)).toBeNull();
    expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running', observationSequence: 2 });
  });

  it('claims only the exact expired incident, blocks Start, and never treats signal acceptance as exit', async () => {
    await running(); await incident();
    const claim = (now: number, incidentId = 'incident-a', deadline = at + 120_000) =>
      repository().claimUnreachableTermination(owner, id, 1, incidentId, deadline, 'intent-a', now);
    expect(await claim(at + 119_999)).toBeNull();
    expect(await claim(at + 120_000, 'wrong')).toBeNull();
    expect(await claim(at + 120_000, 'incident-a', at + 119_999)).toBeNull();
    expect(await claim(at + 120_000)).toMatchObject({ lifecycleState: 'stopping', terminationIntentId: 'intent-a',
      terminationClaimedAt: new Date(at + 120_000).toISOString() });
    expect(await claim(at + 150_000)).toMatchObject({ terminationClaimedAt: new Date(at + 120_000).toISOString() });
    await repository().recordTerminationSignal(owner, id, 1, 'intent-a', new Date(at + 120_001).toISOString());
    expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopping',
      terminationSignalAcceptedAt: new Date(at + 120_001).toISOString() });
    expect(await repository().start(owner, id, new Date(at + 999_999).toISOString())).toBeNull();
    expect(await repository().confirmStopped(owner, id, 1, 'intent-a', new Date(at + 999_999).toISOString())).toBe(true);
  });

  it('the automatic force CAS consumes only the exact intent with no pending boundary and preserves its grace origin', async () => {
    await running(); await incident();
    await repository().claimUnreachableTermination(owner, id, 1, 'incident-a', at + 120_000, 'intent-a', at + 120_000);
    const mark = (ownerKey = owner, sessionId = id, generation = 1, intent = 'intent-a', incidentId = 'incident-a', deadline = at + 120_000) =>
      repository().markRecoveryForceStarted(ownerKey, sessionId, generation, intent, incidentId, deadline);
    expect(await mark('other')).toBe(false);
    expect(await mark(owner, 'other')).toBe(false);
    expect(await mark(owner, id, 2)).toBe(false);
    expect(await mark(owner, id, 1, 'other')).toBe(false);
    expect(await mark(owner, id, 1, 'intent-a', 'other')).toBe(false);
    expect(await mark(owner, id, 1, 'intent-a', 'incident-a', at)).toBe(false);
    await db.prepare('UPDATE runtime_sessions SET boundary_activity_id=?1 WHERE owner_key=?2 AND session_id=?3').bind('protected', owner, id).run();
    expect(await mark()).toBe(false);
    await repository().acknowledgeBoundaryCancellation(owner, id, 1, 'protected');
    expect(await mark()).toBe(true);
    const consumed = await repository().getSession(owner, id);
    expect(consumed).toMatchObject({ lifecycleState: 'stopping', lifecycleReason: 'recovery_force_started',
      terminationClaimedAt: new Date(at + 120_000).toISOString() });
    expect(await mark()).toBe(false);
    expect(await repository().getSession(owner, id)).toEqual(consumed);
  });

  it('fences owners, generations, sequence and deleted rows without recreating anything', async () => {
    await running();
    expect(await repository().observeUnreachable('other', id, 1, 1, 'wrong', at)).toBeNull();
    expect(await repository().observeUnreachable(owner, id, 0, 1, 'wrong', at)).toBeNull();
    await repository().project(owner, id, 1, 5, { observedAt: new Date(at).toISOString() });
    expect(await incident(4)).toBeNull();
    await db.prepare('DELETE FROM runtime_sessions').run();
    expect(await incident(6)).toBeNull();
    expect(await repository().getSession(owner, id)).toBeNull();
  });

  function ambiguousDatabase(failReads = false): D1Database {
    return { prepare(sql: string) {
      const statement = db.prepare(sql);
      const wrap = (bound: D1PreparedStatement): D1PreparedStatement => new Proxy(bound, { get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === 'run' && sql.includes("lifecycle_state='unreachable'")) return async () => {
          await target.run(); throw new Error('D1 acknowledgement lost');
        };
        if (key === 'first' && failReads) return async () => { throw new Error('D1 unavailable'); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      return wrap(statement);
    } } as D1Database;
  }

  it('reconciles a lost write acknowledgement idempotently; unreadable D1 grants no authority', async () => {
    await running();
    const uncertain = new D1SessionRepository(ambiguousDatabase());
    expect(await uncertain.observeUnreachable(owner, id, 1, 1, 'incident-a', at)).toMatchObject({ unreachableDeadlineMs: at + 120_000 });
    expect(await uncertain.observeUnreachable(owner, id, 1, 1, 'incident-a', at + 90_000)).toMatchObject({ unreachableDeadlineMs: at + 120_000 });
    await expect(new D1SessionRepository(ambiguousDatabase(true)).observeUnreachable(owner, id, 1, 2, 'incident-a', at)).rejects.toThrow('D1 unavailable');
  });

  async function runtimeFixture() {
    await running();
    let now = at;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const stored = new Map<string, unknown>([['bucketName', owner], ['_sessionId', id], ['lifecycleGeneration', 1],
      ['observationSequence', 0], ['containerAuthToken', 'test-token'], ['sleepAfter', '12h']]);
    const effects: string[] = [];
    const hostRequests: Array<{ url: string; final: boolean }> = [];
    let response: () => Promise<Response> = async () => { throw new Error('Connection refused'); };
    let provider: () => Promise<void> = async () => { effects.push('destroy-complete'); };
    const storage = { get: async (key: string) => stored.get(key), put: async (key: string, value: unknown) => { stored.set(key, value); },
      delete: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) stored.delete(key); }, sync: async () => {} };
    const ctx = { id: { toString: () => 'fixture' }, storage: { ...storage,
      transaction: async (work: (tx: typeof storage) => Promise<unknown>) => work(storage) },
      container: { running: false, getTcpPort: () => ({ fetch: async (_url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { final?: boolean } : {};
        hostRequests.push({ url: _url, final: body.final === true });
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
        return response();
      } }), signal: (signal: number) => { effects.push(`signal:${signal}`); }, destroy: () => { effects.push('destroy'); return provider(); } },
      abort: () => { effects.push('reset'); throw Error('fixture reset'); } };
    const host = { ctx, env: { USAGE_DB: db }, _bucketName: owner, _sessionId: id, _containerAuthToken: 'test-token',
      _userEmail: 'test@example.com', _usageSeconds: 0, containerStartedAt: at, lastSeenInputAt: null,
      _shutdownStartedAt: 0, _teardownEpoch: 0, idleTimeoutPref: '12h',
      logger: { info: (message: string) => { logs.push(message); }, warn: (message: string) => { logs.push(message); },
        error: (message: string) => { logs.push(message); } },
      stop: async () => { effects.push('sdk-stop'); }, schedule: async (delay: number, _method: string, payload: unknown) => {
        schedules.push(payload); alarms.push({ delay, payload });
      },
      deleteSchedules: () => { alarms.length = 0; }, superDestroy: async () => { effects.push('sdk-destroy'); } };
    const schedules: unknown[] = [];
    const alarms: Array<{ delay: number; payload: unknown }> = [];
    const logs: string[] = [];
    const { collectMetrics } = await import('../../container/container-lifecycle');
    const tick = async () => { alarms.length = 0; try { await collectMetrics(host as never, pin); } catch (error) {
      if (!(error instanceof Error && error.message === 'fixture reset')) throw error;
    } };
    return { host, ctx, stored, effects, hostRequests, schedules, alarms, logs, tick, time: (value: number) => { now = value; },
      respond: (value: () => Promise<Response>) => { response = value; }, provider: (value: () => Promise<void>) => { provider = value; } };
  }

  it('D1 remains authoritative across both bounded reconstructions and exhaustion, without restarting the incident', async () => {
    const f = await runtimeFixture();
    try {
      const { collectMetrics } = await import('../../container/container-lifecycle');
      await f.tick();
      const first = await repository().getSession(owner, id);
      // Recreate the coordinator object over the same assigned generation and storage.
      for (let tick = 1; tick < 10; tick++) {
        f.time(at + tick * 5_000);
        const reconstructed = { ...f.host, _teardownEpoch: 0 };
        try { await collectMetrics(reconstructed as never, pin); } catch (error) {
          if (!(error instanceof Error && error.message === 'fixture reset')) throw error;
        }
        expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'unreachable',
          unreachableIncidentId: first!.unreachableIncidentId, unreachableDeadlineMs: at + 120_000 });
      }
      expect(f.effects).toEqual(['reset', 'reset']);
      expect(f.schedules.every(value => JSON.stringify(value) === JSON.stringify(pin))).toBe(true);
      f.time(at + 120_000); await collectMetrics({ ...f.host } as never, pin);
      expect(f.effects).toEqual(['reset', 'reset', 'signal:15']);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopping' });
    } finally { vi.restoreAllMocks(); }
  });

  it('any HTTP response clears the reconstruction streak; a subsequent failure opens a fresh incident, not an immediate reset', async () => {
    const f = await runtimeFixture();
    try {
      await f.tick(); await f.tick();
      f.respond(async () => new Response('host unavailable', { status: 503 })); await f.tick();
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running' });
      f.time(at + 30_000); f.respond(async () => { throw Error('new transport failure'); });
      await f.tick(); await f.tick();
      expect(f.effects).toEqual([]);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'unreachable', unreachableDeadlineMs: at + 150_000 });
    } finally { vi.restoreAllMocks(); }
  });

  it('an exhausted incident recovers without billing, then ordinary healthy usage and the single projection resume', async () => {
    const f = await runtimeFixture();
    try {
      Object.assign(f.host.env, { TIMEKEEPER: { idFromName: () => 'timekeeper', get: () => ({ fetch: async () => {
        f.effects.push('timekeeper-ping'); return Response.json({ quotaExceeded: false });
      } }) } });
      for (let tick = 0; tick < 10; tick++) await f.tick();
      expect(f.effects).toEqual(['reset', 'reset']);
      f.respond(async () => new Response('host unavailable', { status: 503 })); await f.tick();
      const recovered = await repository().getSession(owner, id);
      expect(recovered).toMatchObject({ lifecycleState: 'running' });
      expect(f.host._usageSeconds).toBe(0);
      expect(f.alarms.at(-1)).toEqual({ delay: 60, payload: pin });
      f.ctx.container.running = true;
      f.respond(async () => Response.json({ lastInputAt: at, observedAt: new Date(at).toISOString() })); await f.tick();
      expect(f.effects).toEqual(['reset', 'reset', 'timekeeper-ping']);
      expect(f.host._usageSeconds).toBe(60);
      expect((await repository().getSession(owner, id))!.responseRevision).toBe(recovered!.responseRevision + 1);
    } finally { vi.restoreAllMocks(); }
  });

  it('all failure, reconstruction, recovery and stopping ticks skip actual Timekeeper I/O and quota-stop drains', async () => {
    const f = await runtimeFixture();
    try {
      Object.assign(f.host.env, { SAAS_MODE: 'active', TIMEKEEPER: {
        idFromName: () => 'timekeeper', get: () => ({ fetch: async () => {
          f.effects.push('timekeeper-ping'); return Response.json({ quotaExceeded: true });
        } }),
      } });
      await f.tick(); await f.tick(); await f.tick();
      f.respond(async () => new Response('bad-json')); await f.tick();
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running' });
      f.respond(async () => { throw Error('transport failed'); }); await f.tick();
      f.time(at + 120_000); await f.tick(); await f.tick();
      expect(f.effects).toEqual(['reset', 'signal:15']);
      expect(f.host._usageSeconds).toBe(0);
    } finally { vi.restoreAllMocks(); }
  });

  it('a healthy host with a failed D1 projection or local timing read never opens a transport incident', async () => {
    const f = await runtimeFixture();
    try {
      f.ctx.container.running = true;
      f.respond(async () => Response.json({ lastInputAt: at, observedAt: new Date(at).toISOString() }));
      const real = f.host.env.USAGE_DB;
      f.host.env.USAGE_DB = { prepare(sql: string) {
        const target = real.prepare(sql);
        if (!sql.includes('lifecycle_state=COALESCE')) return target;
        const failed = { bind: () => failed, run: async () => { throw Error('D1 projection unavailable'); } };
        return failed;
      } } as D1Database;
      await f.tick();
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running' });
      f.host.env.USAGE_DB = real;
      f.host.containerStartedAt = 0;
      f.respond(async () => Response.json({ lastInputAt: null, observedAt: new Date(at).toISOString() }));
      const get = f.ctx.storage.get;
      f.ctx.storage.get = async key => { if (key === 'containerStartedAt') throw Error('storage unavailable'); return get(key); };
      await f.tick();
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running' });
      expect(f.effects).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });

  it.each([
    ['projection', 'sequence'], ['projection', 'generation'], ['clones', 'sequence'], ['clones', 'generation'],
  ] as const)('a hung %s is bounded and nonbillable; late SQL cannot overwrite a newer %s', async (operation, supersession) => {
    const f = await runtimeFixture();
    try {
      f.ctx.container.running = true;
      Object.assign(f.host.env, { SAAS_MODE: 'active', TIMEKEEPER: { idFromName: () => 'timekeeper', get: () => ({ fetch: async () => {
        f.effects.push('timekeeper-ping'); return Response.json({ quotaExceeded: true });
      } }) } });
      f.respond(async () => Response.json({ lastInputAt: at, cpu: 'old', workspaceRepos: [{ repo: 'old/work' }], observedAt: new Date(at).toISOString() }));
      const real = f.host.env.USAGE_DB;
      let release!: () => void;
      let lateSQL!: Promise<unknown>;
      f.host.env.USAGE_DB = { prepare(sql: string) {
        const wrap = (target: D1PreparedStatement): D1PreparedStatement => new Proxy(target, { get(statement, key) {
          if (key === 'bind') return (...args: unknown[]) => wrap(statement.bind(...args));
          const selected = operation === 'projection' ? sql.includes('lifecycle_state=COALESCE') : sql.includes('SET clones_json=');
          if (key === 'run' && selected) return () => {
            lateSQL = new Promise<void>(resolve => { release = resolve; }).then(() => statement.run());
            return lateSQL;
          };
          const value = Reflect.get(statement, key); return typeof value === 'function' ? value.bind(statement) : value;
        } });
        return wrap(real.prepare(sql));
      } } as D1Database;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = f.tick(); await vi.waitFor(() => expect(release).toBeDefined());
      await vi.advanceTimersByTimeAsync(10_000); await pending;
      expect(f.alarms).toEqual([{ delay: 60, payload: pin }]);
      expect(f.effects).toEqual([]);
      expect(f.host._usageSeconds).toBe(0);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running', workspace: 'terminal' });
      f.host.env.USAGE_DB = real;
      let generation = 1;
      if (supersession === 'generation') {
        await confirmMonitoredExit(f.ctx as never, f.host.env as never, owner, id, 1);
        generation = (await repository().start(owner, id, new Date(at + 1).toISOString()))!.lifecycleGeneration;
      }
      await repository().updateTrackedClones(owner, id, [{ repo: 'new/work' }], { generation, sequence: 10 });
      await repository().project(owner, id, generation, 10, { lifecycleState: 'running', cpu: 'new', observedAt: new Date(at + 1).toISOString() });
      release(); await lateSQL;
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: generation,
        observationSequence: 10, cpu: 'new', clones: [{ repo: 'new/work' }], workspace: 'terminal' });
      expect(f.effects).toEqual([]);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it('D1 outage or ambiguous failed projection cannot authorize reconstruction, SIGTERM or force', async () => {
    const f = await runtimeFixture();
    try {
      f.ctx.container.running = true;
      f.host.env.USAGE_DB = { prepare: () => {
        const failed = { bind: () => failed, run: async () => { throw Error('D1 unavailable'); }, first: async () => { throw Error('D1 unavailable'); } };
        return failed;
      } } as unknown as D1Database;
      for (const delta of [0, 120_000, 255_000]) { f.time(at + delta); await f.tick(); }
      expect(f.effects).toEqual([]);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running' });
      expect(f.schedules.at(-1)).toEqual(pin);
    } finally { vi.restoreAllMocks(); }
  });

  it('deliberate shutdown and unreadable shutdown ownership suppress reconstruction and effects', async () => {
    const f = await runtimeFixture();
    try {
      f.stored.set('shutdownRequested', at);
      await f.tick();
      expect(f.schedules).toEqual([]);
      f.stored.delete('shutdownRequested');
      const get = f.ctx.storage.get;
      f.ctx.storage.get = async key => { if (key === 'shutdownRequested') throw Error('shutdown owner unavailable'); return get(key); };
      await f.tick();
      expect(f.effects).toEqual([]);
      expect(f.schedules).toEqual([]);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running' });
    } finally { vi.restoreAllMocks(); }
  });

  it.each(['read', 'write', 'cleanup'] as const)('failed recovery diagnostic %s cannot reset, bill, or fabricate exit', async failure => {
    const f = await runtimeFixture();
    try {
      if (failure === 'read') {
        const get = f.ctx.storage.get;
        f.ctx.storage.get = async key => { if (key === 'metricsTransportRecovery') throw Error('diagnostic read failed'); return get(key); };
      } else if (failure === 'write') {
        const put = f.ctx.storage.put;
        f.ctx.storage.put = async (key, value) => { if (key === 'metricsTransportFailureStreak') throw Error('diagnostic write failed'); return put(key, value); };
      } else {
        await f.tick();
        f.respond(async () => new Response('bad-json'));
        const remove = f.ctx.storage.delete;
        f.ctx.storage.delete = async keys => { if ((Array.isArray(keys) ? keys : [keys]).includes('metricsTransportRecovery')) throw Error('diagnostic cleanup failed'); return remove(keys); };
      }
      await f.tick();
      const current = await repository().getSession(owner, id);
      expect(current!.lifecycleState).toBe(failure === 'write' ? 'unreachable' : 'running');
      expect(f.effects).toEqual([]);
      expect(f.host._usageSeconds).toBe(0);
      expect(f.alarms.at(-1)).toEqual({ delay: failure === 'read' ? 60 : 5, payload: pin });
    } finally { vi.restoreAllMocks(); }
  });

  it('monitor-error scheduling failure is observable, and cannot authorize reconstruction or claim stopped', async () => {
    const f = await runtimeFixture();
    try {
      const { onError } = await import('../../container/container-lifecycle');
      f.host.schedule = async () => { throw Error('alarm unavailable'); };
      await expect(onError(f.host as never, Error('Network connection lost.'))).rejects.toThrow('alarm unavailable');
      expect(f.logs).toContain('Container error retry alarm unavailable');
      expect(f.effects).toEqual([]);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running' });
    } finally { vi.restoreAllMocks(); }
  });

  it('malformed reconstruction diagnostics cannot authorize a reset or manufacture process exit', async () => {
    const f = await runtimeFixture();
    try {
      f.stored.set('metricsTransportRecovery', { status: 'resetting' });
      await f.tick();
      expect(f.effects).toEqual([]);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'unreachable', unreachableDeadlineMs: at + 120_000 });
      expect(f.schedules.at(-1)).toEqual(pin);
    } finally { vi.restoreAllMocks(); }
  });

  it('required scheduling failure is observable and does not signal, reset, or release ownership', async () => {
    const f = await runtimeFixture();
    try {
      f.host.schedule = async () => { throw Error('alarm unavailable'); };
      await expect(f.tick()).rejects.toThrow('alarm unavailable');
      expect(f.effects).toEqual([]);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'unreachable' });
    } finally { vi.restoreAllMocks(); }
  });

  it('lost incident acknowledgement in the production tick joins the durable incident instead of extending it', async () => {
    const f = await runtimeFixture();
    try {
      f.ctx.container.running = true;
      f.host.env.USAGE_DB = ambiguousDatabase();
      await f.tick(); const first = await repository().getSession(owner, id);
      f.time(at + 60_000); await f.tick();
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'unreachable',
        unreachableIncidentId: first!.unreachableIncidentId, unreachableDeadlineMs: at + 120_000 });
      expect(f.effects).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });

  it('SDK false uses an authenticated no-start probe; HTTP and malformed JSON are reachability, not incidents', async () => {
    const f = await runtimeFixture();
    try {
      for (const result of [() => new Response('bad-json'), () => new Response('unavailable', { status: 503 })]) {
        f.respond(async () => result()); await f.tick();
        expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running' });
      }
      expect(f.effects).toEqual([]);
      expect(f.alarms.at(-1)).toEqual({ delay: 60, payload: pin });
    } finally { vi.restoreAllMocks(); }
  });

  it.each(['idle expiry', 'replacement during drain'] as const)('SDK false with a responding host preserves owned termination for %s', async scenario => {
    const f = await runtimeFixture();
    try {
      f.stored.set('sleepAfter', '1h');
      f.ctx.container.getTcpPort = () => ({ fetch: async (url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
        if (url.endsWith('/internal/runtime-observation')) {
          return Response.json({ lastInputAt: at - 3_600_001, observedAt: new Date(at).toISOString() });
        }
        if (url.endsWith('/internal/final-sync')) {
          f.effects.push('final-sync');
          if (scenario === 'replacement during drain') {
            await db.prepare("UPDATE runtime_sessions SET lifecycle_generation=2, observation_sequence=0 WHERE owner_key=?1 AND session_id=?2").bind(owner, id).run();
            f.stored.set('lifecycleGeneration', 2); f.host._teardownEpoch++;
          }
        }
        return Response.json({ hostNow: at, events: [] });
      } });
      await f.tick();
      if (scenario === 'replacement during drain') {
        expect(f.effects).toEqual(['final-sync']);
        expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 2 });
      } else {
        expect(f.effects).toEqual(['final-sync', 'signal:15']);
        expect(f.alarms).toEqual([{ delay: 5, payload: pin }]);
        expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running' });
        expect(await confirmMonitoredExit(f.ctx as never, f.host.env as never, owner, id, 1)).toBe(true);
        await f.tick();
        expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopped' });
        expect(f.alarms).toEqual([]);
      }
    } finally { vi.restoreAllMocks(); }
  });

  it('first failed probe is nonbillable, survives reconstruction, signals at 120s even with SDK false, destroys only after 135s grace', async () => {
    const f = await runtimeFixture();
    try {
      await f.tick();
      const first = await repository().getSession(owner, id);
      expect(first).toMatchObject({ lifecycleState: 'unreachable', unreachableDeadlineMs: at + 120_000 });
      expect(f.alarms.at(-1)).toEqual({ delay: 5, payload: pin });
      f.time(at + 119_999); await f.tick();
      expect(f.effects.filter(x => x !== 'reset')).toEqual([]);
      expect(await repository().getSession(owner, id)).toMatchObject({ unreachableIncidentId: first!.unreachableIncidentId, unreachableDeadlineMs: at + 120_000 });
      f.time(at + 120_000); await f.tick();
      expect(f.effects).toContain('signal:15');
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopping', terminationSignalAcceptedAt: new Date(at + 120_000).toISOString() });
      f.time(at + 254_999); await f.tick(); expect(f.effects).not.toContain('destroy');
      f.time(at + 255_000); await f.tick();
      expect(f.effects.slice(-2)).toEqual(['destroy', 'destroy-complete']);
      expect(f.hostRequests.some(request => request.url === 'http://localhost/internal/final-sync')).toBe(false);
      expect(f.hostRequests.some(request => request.url === 'http://localhost/internal/agent-events/drain' && request.final)).toBe(false);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopped' });
      expect(f.host._usageSeconds).toBe(0);
      expect(f.effects).not.toContain('sdk-stop'); expect(f.effects).not.toContain('sdk-destroy');
    } finally { vi.restoreAllMocks(); }
  });

  it('a failed native SIGTERM remains stopping and escalates at the same finite grace deadline', async () => {
    const f = await runtimeFixture();
    try {
      await f.tick();
      f.ctx.container.signal = () => { f.effects.push('signal-failed'); throw Error('provider signal failed'); };
      f.time(at + 120_000); await f.tick();
      const stopping = await repository().getSession(owner, id);
      expect(stopping).toMatchObject({ lifecycleState: 'stopping' });
      expect(stopping!.terminationSignalAcceptedAt).toBeUndefined();
      expect(f.logs).toContain('signal_failed');
      f.time(at + 255_000); await f.tick();
      expect(f.effects).toEqual(['signal-failed', 'destroy', 'destroy-complete']);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopped' });
    } finally { vi.restoreAllMocks(); }
  });

  it.each(['KILL', 'Retry Stop'] as const)('a failed force is durable across reconstruction; only manual %s retries native destruction', async recovery => {
    const f = await runtimeFixture();
    try {
      const { collectMetrics, killSession, onStop, stopSession } = await import('../../container/container-lifecycle');
      await f.tick(); f.time(at + 120_000); await f.tick();
      f.provider(async () => { f.effects.push('provider-failed'); throw Error('provider unavailable'); });
      f.time(at + 255_000); await f.tick();
      const failed = await repository().getSession(owner, id);
      expect(failed).toMatchObject({ lifecycleState: 'stopping', lifecycleReason: 'recovery_force_started',
        terminationClaimedAt: new Date(at + 120_000).toISOString(), workspace: 'terminal' });
      expect(f.alarms).toEqual([]);
      for (let retry = 0; retry < 3; retry++) {
        await f.tick();
        const reconstructed = { ...f.host, _unreachableDestroy: undefined };
        await onStop(reconstructed as never);
        await collectMetrics(reconstructed as never, pin);
        expect(f.alarms).toEqual([]);
      }
      expect(f.effects).toEqual(['signal:15', 'destroy', 'provider-failed']);
      expect(await repository().getSession(owner, id)).toEqual(failed);
      let complete!: () => void;
      f.host.superDestroy = () => { f.effects.push('manual-destroy'); return new Promise<void>(resolve => { complete = resolve; }); };
      const input = { bucket: owner, sessionId: id, generation: 1 };
      const pending = recovery === 'KILL' ? killSession(f.host as never, input)
        : stopSession(f.host.env as never, input, () => f.host.superDestroy());
      await vi.waitFor(() => expect(f.effects).toContain('manual-destroy'));
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopping', workspace: 'terminal' });
      complete(); await pending;
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopped', workspace: 'terminal' });
    } finally { vi.restoreAllMocks(); }
  });

  it('a never-settling provider is bounded with no automatic alarm, yet late completion confirms the current generation', async () => {
    const f = await runtimeFixture();
    try {
      await f.tick(); f.time(at + 120_000); await f.tick(); f.time(at + 255_000);
      let complete!: () => void;
      f.provider(() => new Promise<void>(resolve => { complete = resolve; }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = f.tick();
      // D1 read delivery is native; drain microtasks without advancing the timeout.
      await vi.waitFor(() => expect(complete).toBeDefined());
      await vi.advanceTimersByTimeAsync(10_000); await pending;
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopping' });
      expect(f.logs).toContain('recovery_termination_failed: retry Stop or KILL');
      expect(f.alarms).toEqual([]);
      const { collectMetrics, onStop } = await import('../../container/container-lifecycle');
      const reconstructed = { ...f.host, _unreachableDestroy: undefined };
      await onStop(reconstructed as never);
      await collectMetrics(reconstructed as never, pin);
      await f.tick();
      expect(f.alarms).toEqual([]);
      expect(f.effects).toEqual(['signal:15', 'destroy']);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopping', workspace: 'terminal' });
      complete();
      await vi.waitFor(async () => expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopped', workspace: 'terminal' }));
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it('a lost force-CAS acknowledgement consumes the automatic attempt but never authorizes native dispatch', async () => {
    const f = await runtimeFixture();
    try {
      await f.tick(); f.time(at + 120_000); await f.tick(); f.time(at + 255_000);
      const real = f.host.env.USAGE_DB;
      f.host.env.USAGE_DB = { prepare(sql: string) {
        const wrap = (target: D1PreparedStatement): D1PreparedStatement => new Proxy(target, { get(statement, key) {
          if (key === 'bind') return (...args: unknown[]) => wrap(statement.bind(...args));
          if (key === 'run' && sql.includes("SET lifecycle_reason='recovery_force_started'")) return async () => {
            await statement.run(); throw Error('force acknowledgement lost');
          };
          const value = Reflect.get(statement, key); return typeof value === 'function' ? value.bind(statement) : value;
        } });
        return wrap(real.prepare(sql));
      } } as D1Database;
      await f.tick(); f.host.env.USAGE_DB = real;
      const { collectMetrics, onStop } = await import('../../container/container-lifecycle');
      const reconstructed = { ...f.host, _unreachableDestroy: undefined };
      await onStop(reconstructed as never); await collectMetrics(reconstructed as never, pin);
      expect(f.effects).toEqual(['signal:15']);
      expect(f.alarms).toEqual([]);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopping', lifecycleReason: 'recovery_force_started' });
      expect(f.logs).toContain('recovery_termination_failed: retry Stop or KILL');
    } finally { vi.restoreAllMocks(); }
  });

  it('a true native exit with failed persistence remains honestly stopping and actionable without redispatch', async () => {
    const f = await runtimeFixture();
    try {
      await f.tick(); f.time(at + 120_000); await f.tick(); f.time(at + 255_000);
      const real = f.host.env.USAGE_DB;
      f.host.env.USAGE_DB = { prepare(sql: string) {
        if (!sql.includes("SET lifecycle_state='stopped'")) return real.prepare(sql);
        const failed = { bind: () => failed, run: async () => { throw Error('exit persistence unavailable'); } };
        return failed;
      } } as D1Database;
      await f.tick(); await f.tick();
      expect(f.effects).toEqual(['signal:15', 'destroy', 'destroy-complete']);
      expect(f.alarms).toEqual([]);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopping', lifecycleReason: 'recovery_force_started', workspace: 'terminal' });
      expect(f.logs).toContain('recovery_termination_failed: retry Stop or KILL');
    } finally { vi.restoreAllMocks(); }
  });

  it('an SDK stop callback cannot retire the automatic reaper or declare exit after signal acceptance', async () => {
    const f = await runtimeFixture();
    try {
      await f.tick(); f.time(at + 120_000); await f.tick();
      const { onStop } = await import('../../container/container-lifecycle');
      await onStop(f.host as never);
      expect(f.effects).toEqual(['signal:15']);
      // Intentional SDK alarm contract: one live, generation-pinned callback.
      expect(f.alarms).toEqual([{ delay: 5, payload: pin }]);
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopping' });
      f.time(at + 255_000); await f.tick();
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopped' });
    } finally { vi.restoreAllMocks(); }
  });

  it('a late native completion after a positive monitored exit cannot stop a replacement', async () => {
    const f = await runtimeFixture();
    try {
      await f.tick(); f.time(at + 120_000); await f.tick(); f.time(at + 255_000);
      let complete!: () => void;
      f.provider(() => new Promise<void>(resolve => { complete = resolve; }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = f.tick(); await vi.waitFor(() => expect(complete).toBeDefined());
      await vi.advanceTimersByTimeAsync(10_000); await pending;
      expect(f.alarms).toEqual([]);
      expect(await confirmMonitoredExit(f.ctx as never, f.host.env as never, owner, id, 1)).toBe(true);
      expect(await repository().start(owner, id, new Date(at + 255_001).toISOString())).toMatchObject({ lifecycleGeneration: 2 });
      await repository().project(owner, id, 2, 0, { lifecycleState: 'running', observedAt: new Date(at + 255_001).toISOString() });
      f.stored.set('lifecycleGeneration', 2); f.host._teardownEpoch++;
      complete(); await vi.advanceTimersByTimeAsync(0); await f.tick();
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 2 });
      expect(f.effects).toEqual(['signal:15', 'destroy']);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it('recovers on any same-incident host response before deadline without an ordinary projection bypass', async () => {
    const f = await runtimeFixture();
    try {
      await f.tick(); f.time(at + 50_000);
      f.respond(async () => new Response('malformed')); await f.tick();
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running' });
      expect((await repository().getSession(owner, id))!.unreachableIncidentId).toBeUndefined();
      expect(f.host._usageSeconds).toBe(0);
      expect(f.effects).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });

  it('protected Action cancellation must finish before a native signal; failure retains ownership', async () => {
    const f = await runtimeFixture();
    try {
      await repository().recordBoundaryActionStart(owner, id, 1, 'protected-action');
      await f.tick(); f.time(at + 120_000); await f.tick();
      expect(f.effects).not.toContain('signal:15');
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'stopping', boundaryActivityId: 'protected-action' });
      Object.assign(f.host.env, { OPERATOR_ACTIVITY: { getByName: () => ({
        getBoundaryStartBinding: async () => ({ session: { bucket: owner, sessionId: id, generation: 1 } }),
        cancelBoundaryStart: async () => { f.effects.push('cancel'); return { ok: true }; },
      }) } });
      await f.tick();
      expect(f.effects).toEqual(['cancel', 'signal:15']);
    } finally { vi.restoreAllMocks(); }
  });

  it.each(['signal', 'destroy'] as const)('a teardown epoch change during D1 authorization prevents a stale native %s', async action => {
    const f = await runtimeFixture();
    try {
      await f.tick();
      if (action === 'destroy') { f.time(at + 120_000); await f.tick(); }
      f.time(at + (action === 'destroy' ? 255_000 : 120_000));
      const original = f.host.env.USAGE_DB;
      f.host.env.USAGE_DB = { prepare(sql: string) {
        const statement = original.prepare(sql);
        const wrap = (bound: D1PreparedStatement): D1PreparedStatement => new Proxy(bound, { get(target, key) {
          if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
          if (key === 'first' && sql.startsWith('SELECT *')) return async () => {
            const result = await target.first(); f.host._teardownEpoch++; return result;
          };
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } }); return wrap(statement);
      } } as D1Database;
      const previous = [...f.effects]; await f.tick(); expect(f.effects).toEqual(previous);
      expect(await repository().getSession(owner, id)).not.toMatchObject({ lifecycleState: 'stopped' });
    } finally { vi.restoreAllMocks(); }
  });

  it('an older complete failure delivered after a newer healthy observation cannot open an incident', async () => {
    const f = await runtimeFixture();
    try {
      let fail!: () => void;
      f.respond(() => new Promise<Response>((_, reject) => { fail = () => reject(Error('late complete failure')); }));
      const pending = f.tick(); await vi.waitFor(() => expect(fail).toBeDefined());
      f.respond(async () => Response.json({ lastInputAt: at, observedAt: new Date(at).toISOString() }));
      await f.tick(); fail(); await pending;
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running', observationSequence: 2 });
      expect((await repository().getSession(owner, id))!.unreachableIncidentId).toBeUndefined();
      expect(f.effects).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });

  it('a late failed observation and old alarm cannot affect a replacement generation', async () => {
    const f = await runtimeFixture();
    try {
      let fail!: () => void;
      f.respond(() => new Promise<Response>((_, reject) => { fail = () => reject(Error('late failure')); }));
      const pending = f.tick(); await vi.waitFor(() => expect(fail).toBeDefined());
      await db.prepare("UPDATE runtime_sessions SET lifecycle_generation=2, observation_sequence=0 WHERE owner_key=?1 AND session_id=?2").bind(owner, id).run();
      f.stored.set('lifecycleGeneration', 2); f.host._teardownEpoch++; fail(); await pending;
      await f.tick();
      expect(await repository().getSession(owner, id)).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 2 });
      expect(f.effects).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });
});
