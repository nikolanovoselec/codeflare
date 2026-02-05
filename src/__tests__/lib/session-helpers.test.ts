import { describe, it, expect } from 'vitest';
import { toApiSession } from '../../lib/session-helpers';
import type { Session } from '../../types';

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
