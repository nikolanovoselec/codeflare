import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import migration from '../../../migrations/usage/0002_runtime_sessions.sql?raw';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import completionMigration from '../../../migrations/usage/0003_complete_session_cutover.sql?raw';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import boundaryMigration from '../../../migrations/usage/0004_boundary_activity.sql?raw';
import { D1SessionRepository } from '../../lib/session-repository';

const db = (env as unknown as { USAGE_DB: D1Database }).USAGE_DB;

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
  await db.prepare("UPDATE session_cutover SET state='pending', completed_at=NULL WHERE id=1").run();
});

describe('REQ-SESSION-030: guarded exact clean-slate cutover', () => {
  it('opens Create and Start admission when the deployment completion migration runs', async () => {
    for (const statement of completionMigration.split(';').map((part: string) => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    const repository = new D1SessionRepository(db);
    await expect(repository.create({
      ownerKey: 'owner-a', sessionId: 'session01', name: 'Terminal',
      createdAt: '2027-01-01T00:00:00.000Z', lastAccessedAt: '2027-01-01T00:00:00.000Z',
      workspace: 'terminal', terminalMode: 'classic',
    })).resolves.toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 0, responseRevision: 0 });
    await expect(repository.getSession('owner-a', 'session01'))
      .resolves.toMatchObject({ name: 'Terminal', lifecycleState: 'stopped', lifecycleGeneration: 0 });
    await expect(repository.start('owner-a', 'session01', '2027-01-01T00:01:00.000Z'))
      .resolves.toMatchObject({ lifecycleState: 'starting', lifecycleGeneration: 1 });
    const started = await repository.getSession('owner-a', 'session01');
    expect(started).toMatchObject({ lifecycleState: 'starting', lifecycleGeneration: 1 });
    const completed = await db.prepare('SELECT state, updated_at, completed_at FROM session_cutover WHERE id=1').first();
    expect(completed).toMatchObject({ state: 'complete', completed_at: expect.any(String) });
    for (const statement of completionMigration.split(';').map((part: string) => part.trim()).filter(Boolean)) {
      const replay = await db.prepare(statement).run();
      expect(replay.meta.changes).toBe(0);
    }
    expect(await db.prepare('SELECT state, updated_at, completed_at FROM session_cutover WHERE id=1').first()).toEqual(completed);
    await expect(repository.getSession('owner-a', 'session01')).resolves.toEqual(started);
    await expect(repository.listSessions('owner-a')).resolves.toEqual([started]);
    await expect(repository.start('owner-a', 'session01', '2027-01-01T00:02:00.000Z')).resolves.toBeNull();
    await expect(repository.getSession('owner-a', 'session01')).resolves.toEqual(started);
  });

  it('REQ-SESSION-031: a pending gate denies real Create and Start without changing an existing stopped row', async () => {
    for (const statement of completionMigration.split(';').map((part: string) => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    const repository = new D1SessionRepository(db);
    const input = { ownerKey: 'owner-a', sessionId: 'session01', name: 'Terminal',
      createdAt: '2027-01-01T00:00:00.000Z', lastAccessedAt: '2027-01-01T00:00:00.000Z',
      workspace: 'terminal' as const, terminalMode: 'classic' as const };
    await repository.create(input);
    const stopped = await repository.getSession(input.ownerKey, input.sessionId);
    expect(stopped).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 0 });
    // Fixture arrangement only; admission is exercised through production methods.
    await db.prepare("UPDATE session_cutover SET state='pending' WHERE id=1").run();
    await expect(repository.create({ ...input, sessionId: 'session02' })).rejects.toThrow('Session admission is closed');
    await expect(repository.start('owner-a', 'session01', '2027-01-01T00:01:00.000Z')).resolves.toBeNull();
    await expect(repository.getSession('owner-a', 'session01')).resolves.toEqual(stopped);
    await expect(repository.getSession('owner-a', 'session02')).resolves.toBeNull();
    await expect(repository.listSessions('owner-a')).resolves.toEqual([stopped]);
  });
});
