import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Vite raw-loader module used only by the Workers test runtime.
import migration from '../../../migrations/usage/0002_runtime_sessions.sql?raw';
import { runSessionCutover } from '../../lib/session-cutover';

const db = (env as unknown as { USAGE_DB: D1Database }).USAGE_DB;

beforeAll(async () => {
  for (const statement of migration.split(';').map((part: string) => part.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
});

beforeEach(async () => {
  await db.prepare('DELETE FROM runtime_sessions').run();
  await db.prepare("UPDATE session_cutover SET state='pending', completed_at=NULL WHERE id=1").run();
});

describe('REQ-SESSION-030: guarded exact clean-slate cutover', () => {
  it('refuses cleanup without operator-confirmed quiescence', async () => {
    await expect(runSessionCutover({ db, kv: { list: vi.fn(), delete: vi.fn() }, bucketNames: ['bucket-a'], quiescentConfirmed: false })).rejects.toThrow('quiescence');
  });

  it('aborts on running metadata without deleting any key', async () => {
    const kv = { list: vi.fn(async () => ({ keys: [{ name: 'session:bucket-a:live0001', metadata: { s: 'r' } }], list_complete: true })), delete: vi.fn() };
    await expect(runSessionCutover({ db, kv, bucketNames: ['bucket-a'], quiescentConfirmed: true })).rejects.toThrow('not quiescent');
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('deletes only exact owner prefixes, verifies empty D1, completes once, and reruns safely', async () => {
    const kv = {
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({ keys: [{ name: `${prefix}old00001`, metadata: { s: 's' } }], list_complete: true })),
      delete: vi.fn(async (_key: string) => {}),
    };
    await expect(runSessionCutover({ db, kv, bucketNames: ['bucket-a', 'bucket-b'], quiescentConfirmed: true, now: '2027-01-01T00:00:00.000Z' })).resolves.toEqual({ deleted: 2 });
    expect(kv.delete.mock.calls.map(([key]) => key)).toEqual(['session:bucket-a:old00001', 'session:bucket-b:old00001']);
    await expect(runSessionCutover({ db, kv, bucketNames: ['bucket-a'], quiescentConfirmed: true })).resolves.toEqual({ deleted: 0 });
  });
});
