import { describe, it, expect } from 'vitest';
import { listRunningSessionIds, toApiSession } from '../../lib/session-helpers';
import type { Session } from '../../types';
import { buildSessionMetadata, putSessionRunningCorrection } from '../../lib/kv-keys';
import { createMockKV } from '../helpers/mock-kv';

describe('toApiSession', () => {
  const fullSession: Session = {
    id: 'abc123',
    name: 'Test Session',
    userId: 'user-bucket-name',
    createdAt: '2024-01-15T10:00:00.000Z',
    lastAccessedAt: '2024-01-15T11:00:00.000Z',
    status: 'running',
    lastStatusCheck: 1705312800000,
    editorReady: true,
    editorReadyError: true,
    metrics: { cpu: '10%' },
  };

  it('strips userId from the session', () => {
    const result = toApiSession(fullSession);
    expect(result).not.toHaveProperty('userId');
  });

  it('strips lastStatusCheck from the session', () => {
    const result = toApiSession(fullSession);
    expect(result).not.toHaveProperty('lastStatusCheck');
  });

  it('leaves runtime readiness and metrics to batch-status overlays', () => {
    const result = toApiSession(fullSession);
    expect(result).not.toHaveProperty('editorReady');
    expect(result).not.toHaveProperty('editorReadyError');
    expect(result).not.toHaveProperty('metrics');
  });

  it('preserves all durable public fields', () => {
    const result = toApiSession(fullSession);
    expect(result).toEqual({
      id: 'abc123',
      name: 'Test Session',
      createdAt: '2024-01-15T10:00:00.000Z',
      lastAccessedAt: '2024-01-15T11:00:00.000Z',
      status: 'running',
    });
  });

  it('works when optional fields are absent', () => {
    const minimal: Session = {
      id: 'min123',
      name: 'Minimal',
      userId: 'bucket',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastAccessedAt: '2024-01-01T00:00:00.000Z',
    };
    const result = toApiSession(minimal);
    expect(result).not.toHaveProperty('userId');
    expect(result.id).toBe('min123');
  });
});

describe('listRunningSessionIds', () => {
  it('includes stopped durable sessions with a running correction', async () => {
    const kv = createMockKV();
    const session: Session = {
      id: 'abcdef1234567890', name: 'Corrected', userId: 'bucket', status: 'stopped',
      createdAt: '2024-01-01T00:00:00.000Z', lastAccessedAt: '2024-01-01T00:00:00.000Z',
    };
    kv._set(`session:bucket:${session.id}`, session, buildSessionMetadata(session));
    await putSessionRunningCorrection(kv as unknown as KVNamespace, 'bucket', session.id);

    await expect(listRunningSessionIds({ KV: kv as unknown as KVNamespace }, 'bucket')).resolves.toEqual([session.id]);
  });
});
