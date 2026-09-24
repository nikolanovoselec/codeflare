import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { D1SessionRepository } from '../../lib/session-repository';
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

  it('REQ-SESSION-035: aged Stop ownership remains fenced until its current-generation exit is confirmed', async () => {
    const repository = new D1SessionRepository(db);
    for (const [owner, sessionId] of [
      ['owner-a', 'expired01'], ['owner-a', 'boundary1'], ['owner-a', 'starting1'],
      ['owner-a', 'running01'], ['owner-a', 'unreach01'], ['owner-a', 'stopped01'],
      ['owner-b', 'expired02'],
    ] as const) await createSession(owner, sessionId);
    await db.prepare(`UPDATE runtime_sessions SET
      lifecycle_state='stopping', lifecycle_generation=2, response_revision=4,
      transitioned_at=?3, lifecycle_reason=NULL, last_started_at='2027-01-01T00:00:10.000Z',
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
    expect(await repository.start('owner-a', 'expired01', '2027-01-01T00:10:00.000Z')).toBeNull();
    expect(await repository.confirmStopped('owner-a', 'expired01', 1, 'intent', '2027-01-01T00:10:00.000Z')).toBe(false);
    expect(await repository.confirmStopped('owner-a', 'expired01', 2, 'intent', '2027-01-01T00:10:00.000Z')).toBe(true);
    expect(await repository.getSession('owner-a', 'expired01')).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 2 });
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
