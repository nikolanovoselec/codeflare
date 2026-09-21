import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { D1SessionRepository } from '../../lib/session-repository';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import migration from '../../../migrations/usage/0002_runtime_sessions.sql?raw';

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

  it('forces only owner-scoped stopping rows older than three minutes to stopped', async () => {
    const repository = new D1SessionRepository(db);
    await createSession('owner-a', 'expired01');
    await createSession('owner-a', 'recent001');
    await createSession('owner-a', 'running01');
    await createSession('owner-b', 'expired02');
    await db.prepare(`UPDATE runtime_sessions SET
      lifecycle_state='stopping', lifecycle_generation=2, response_revision=4,
      transitioned_at=?3, lifecycle_reason=NULL,
      editor_ready=1, editor_ready_error=1,
      unreachable_incident_id='incident', unreachable_first_observed_at=?3, unreachable_deadline_ms=60000,
      termination_intent_id='intent', termination_generation=2, termination_claimed_at=?3,
      termination_signal_accepted_at=?3
      WHERE owner_key=?1 AND session_id=?2`)
      .bind('owner-a', 'expired01', '2027-01-01T00:00:00.000Z').run();
    await db.prepare(`UPDATE runtime_sessions SET lifecycle_state='stopping', transitioned_at=?3,
      termination_intent_id='intent', termination_generation=0, termination_claimed_at=?3
      WHERE owner_key=?1 AND session_id=?2`)
      .bind('owner-a', 'recent001', '2027-01-01T00:02:00.001Z').run();
    await db.prepare("UPDATE runtime_sessions SET lifecycle_state='running', transitioned_at='2027-01-01T00:00:00.000Z' WHERE owner_key='owner-a' AND session_id='running01'").run();
    await db.prepare(`UPDATE runtime_sessions SET lifecycle_state='stopping', transitioned_at=?3,
      termination_intent_id='intent', termination_generation=0, termination_claimed_at=?3
      WHERE owner_key=?1 AND session_id=?2`)
      .bind('owner-b', 'expired02', '2027-01-01T00:00:00.000Z').run();

    expect(await repository.forceStopExpired('owner-a', '2027-01-01T00:03:00.001Z')).toBe(1);

    const expired = await db.prepare("SELECT * FROM runtime_sessions WHERE owner_key='owner-a' AND session_id='expired01'").first<Record<string, unknown>>();
    expect(expired).toMatchObject({
      lifecycle_state: 'stopped', response_revision: 5, lifecycle_reason: 'stop_timeout_forced_reset',
      editor_ready: 0, editor_ready_error: 0,
      unreachable_incident_id: null, unreachable_first_observed_at: null, unreachable_deadline_ms: null,
      termination_intent_id: null, termination_generation: null, termination_claimed_at: null,
      termination_signal_accepted_at: null,
    });
    expect((await db.prepare("SELECT lifecycle_state FROM runtime_sessions WHERE owner_key='owner-a' AND session_id='recent001'").first())?.lifecycle_state).toBe('stopping');
    expect((await db.prepare("SELECT lifecycle_state FROM runtime_sessions WHERE owner_key='owner-a' AND session_id='running01'").first())?.lifecycle_state).toBe('running');
    expect((await db.prepare("SELECT lifecycle_state FROM runtime_sessions WHERE owner_key='owner-b' AND session_id='expired02'").first())?.lifecycle_state).toBe('stopping');
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
