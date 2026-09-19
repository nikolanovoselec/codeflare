import { describe, it, expect, vi } from 'vitest';
import { toApiSession, hasOwningSessionContainer } from '../../lib/session-helpers';
import type { Env, Session } from '../../types';

describe('hasOwningSessionContainer', () => {
  function envWith(states: string[]): Pick<Env, 'USAGE_DB'> {
    const rows = states.map((lifecycle_state, index) => ({
      owner_key: 'test-bucket', session_id: `session0${index}`, name: 'Session',
      created_at: '2027-01-01T00:00:00.000Z', last_accessed_at: '2027-01-01T00:00:00.000Z',
      agent_type: null, workspace: 'terminal', terminal_mode: 'classic', tab_config_json: null, clone_json: null,
      lifecycle_state, lifecycle_generation: 1, response_revision: 1, observation_sequence: 0,
      last_started_at: null, last_active_at: null, editor_ready: 0, editor_ready_error: 0,
      cpu: null, memory: null, disk: null, sync_status: null, metrics_observed_at: null, last_input_at: null,
      unreachable_incident_id: null, unreachable_first_observed_at: null, unreachable_deadline_ms: null,
      termination_intent_id: null, termination_generation: null,
    }));
    const statement = { bind: vi.fn().mockReturnThis(), all: vi.fn(async () => ({ results: rows })) };
    return { USAGE_DB: { prepare: vi.fn(() => statement) } as unknown as D1Database };
  }

  it('allows reconciliation when every D1 lifecycle is stopped', async () => {
    await expect(hasOwningSessionContainer(envWith(['stopped']), 'test-bucket')).resolves.toBe(false);
  });

  it('blocks reconciliation for every workload-owning D1 lifecycle', async () => {
    for (const state of ['starting', 'running', 'unreachable', 'stopping']) {
      await expect(hasOwningSessionContainer(envWith([state]), 'test-bucket')).resolves.toBe(true);
    }
  });

  it('fails closed when D1 authority is unavailable', async () => {
    const statement = { bind: vi.fn().mockReturnThis(), all: vi.fn(async () => { throw new Error('D1 unavailable'); }) };
    const env = { USAGE_DB: { prepare: vi.fn(() => statement) } as unknown as D1Database };
    await expect(hasOwningSessionContainer(env, 'test-bucket')).rejects.toThrow('D1 unavailable');
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
