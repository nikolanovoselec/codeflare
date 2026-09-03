import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { toApiSession, hasOwningSessionContainer } from '../../lib/session-helpers';
import type { Env, Session } from '../../types';

const getState = vi.hoisted(() => vi.fn());
vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({ getState })),
}));

describe('hasOwningSessionContainer', () => {
  beforeEach(() => {
    getState.mockReset();
  });

  function envWith(kv: ReturnType<typeof createMockKV>): Pick<Env, 'KV' | 'CONTAINER'> {
    return { KV: kv, CONTAINER: {} as DurableObjectNamespace };
  }

  it('allows reconciliation when stale running metadata points to persisted stopped state', async () => {
    const kv = createMockKV();
    kv._set('session:test-bucket:stale1234', { id: 'stale1234', status: 'stopped' }, { s: 'r' });
    getState.mockResolvedValue({ status: 'stopped' });

    await expect(hasOwningSessionContainer(envWith(kv), 'test-bucket')).resolves.toBe(false);
  });

  it('blocks reconciliation when stale stopped metadata hides persisted running state', async () => {
    const kv = createMockKV();
    kv._set('session:test-bucket:live12345', { id: 'live12345', status: 'stopped' }, { s: 's' });
    getState.mockResolvedValue({ status: 'running' });

    await expect(hasOwningSessionContainer(envWith(kv), 'test-bucket')).resolves.toBe(true);
  });

  it('fails closed when persisted container state is unavailable', async () => {
    const kv = createMockKV();
    kv._set('session:test-bucket:unknown12', { id: 'unknown12', status: 'stopped' }, { s: 's' });
    getState.mockRejectedValue(new Error('state unavailable'));

    await expect(hasOwningSessionContainer(envWith(kv), 'test-bucket')).resolves.toBe(true);
  });
});

describe('toApiSession', () => {
  const fullSession: Session = {
    id: 'abc123',
    name: 'Test Session',
    userId: 'user-bucket-name',
    createdAt: '2024-01-15T10:00:00.000Z',
    lastAccessedAt: '2024-01-15T11:00:00.000Z',
    status: 'running',
    lastStatusCheck: 1705312800000,
  };

  it('strips userId from the session', () => {
    const result = toApiSession(fullSession);
    expect(result).not.toHaveProperty('userId');
  });

  it('strips lastStatusCheck from the session', () => {
    const result = toApiSession(fullSession);
    expect(result).not.toHaveProperty('lastStatusCheck');
  });

  it('preserves all other fields', () => {
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
