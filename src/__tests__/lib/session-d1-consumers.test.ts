import { describe, expect, it, vi } from 'vitest';
import {
  authorizeSession,
  countWorkloadOwningSessions,
  listWorkloadSessionIds,
  hasOwningSession,
  deleteOwnerSessions,
} from '../../lib/session-authority';

type Row = { ownerKey: string; sessionId: string; lifecycleState: 'stopped' | 'starting' | 'running' | 'unreachable' | 'stopping' };

function authority(rows: Row[]) {
  return {
    getSession: vi.fn(async (ownerKey: string, sessionId: string) => rows.find((row) => row.ownerKey === ownerKey && row.sessionId === sessionId) ?? null),
    listSessions: vi.fn(async (ownerKey: string) => rows.filter((row) => row.ownerKey === ownerKey)),
    deleteOwnerSessions: vi.fn(async (ownerKey: string) => rows.filter((row) => row.ownerKey === ownerKey).length),
  };
}

describe('REQ-SESSION-028: backend consumers use D1 session authority', () => {
  const rows: Row[] = [
    { ownerKey: 'owner-a', sessionId: 'start0001', lifecycleState: 'starting' },
    { ownerKey: 'owner-a', sessionId: 'run00001', lifecycleState: 'running' },
    { ownerKey: 'owner-a', sessionId: 'lost0001', lifecycleState: 'unreachable' },
    { ownerKey: 'owner-a', sessionId: 'stop0001', lifecycleState: 'stopping' },
    { ownerKey: 'owner-a', sessionId: 'done0001', lifecycleState: 'stopped' },
    { ownerKey: 'owner-b', sessionId: 'other001', lifecycleState: 'running' },
  ];

  it('authorizes terminal, VS Code, vault and access routes only from owner-scoped D1 records', async () => {
    const repo = authority(rows);
    for (const consumer of ['terminal', 'vscode', 'vault', 'access'] as const) {
      await expect(authorizeSession(repo, 'owner-a', 'run00001', consumer)).resolves.toMatchObject({ sessionId: 'run00001' });
      await expect(authorizeSession(repo, 'owner-a', 'other001', consumer)).rejects.toMatchObject({ statusCode: 404 });
    }
  });

  it('sync fanout and migration enumeration include all workload-owning states and exclude stopped', async () => {
    const repo = authority(rows);
    await expect(listWorkloadSessionIds(repo, 'owner-a')).resolves.toEqual(['start0001', 'run00001', 'lost0001', 'stop0001']);
  });

  it('capacity counts starting, running, unreachable and stopping in one owner query', async () => {
    const repo = authority(rows);
    await expect(countWorkloadOwningSessions(repo, 'owner-a', 'run00001')).resolves.toBe(3);
    expect(repo.listSessions).toHaveBeenCalledTimes(1);
  });

  it('managed reconciliation fails closed for every workload-owning state without SDK probing', async () => {
    const repo = authority(rows);
    await expect(hasOwningSession(repo, 'owner-a')).resolves.toBe(true);
    expect(repo.listSessions).toHaveBeenCalledTimes(1);
  });

  it('user cleanup deletes D1 sessions while leaving unrelated KV and R2 ownership to existing cleanup', async () => {
    const repo = authority(rows);
    await expect(deleteOwnerSessions(repo, 'owner-a')).resolves.toBe(5);
    expect(repo.deleteOwnerSessions).toHaveBeenCalledWith('owner-a');
  });

  it('fails protected authorization, mutation, migration and reconciliation closed when D1 is unavailable', async () => {
    const failure = new Error('D1 unavailable');
    const repo = {
      getSession: vi.fn(async () => { throw failure; }),
      listSessions: vi.fn(async () => { throw failure; }),
      deleteOwnerSessions: vi.fn(async () => { throw failure; }),
    };
    await expect(authorizeSession(repo, 'owner-a', 'run00001', 'terminal')).rejects.toThrow('D1 unavailable');
    await expect(listWorkloadSessionIds(repo, 'owner-a')).rejects.toThrow('D1 unavailable');
    await expect(hasOwningSession(repo, 'owner-a')).rejects.toThrow('D1 unavailable');
    await expect(deleteOwnerSessions(repo, 'owner-a')).rejects.toThrow('D1 unavailable');
  });
});
