import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import lifecycleRoutes from '../../routes/session/lifecycle';
import type { Env } from '../../types';

vi.mock('../../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));

const row = {
  owner_key: 'test-bucket', session_id: 'aabbccdd11223344', name: 'Terminal',
  created_at: '2027-01-01T00:00:00.000Z', last_accessed_at: '2027-01-01T00:00:00.000Z',
  agent_type: null, workspace: 'terminal', terminal_mode: 'classic', tab_config_json: null, clone_json: null,
  lifecycle_state: 'unreachable', lifecycle_generation: 3, response_revision: 9, observation_sequence: 4,
  last_started_at: '2027-01-01T00:00:00.000Z', last_active_at: '2027-01-01T00:01:00.000Z',
  editor_ready: 0, editor_ready_error: 0, cpu: '12%', memory: '1GB', disk: '2GB', sync_status: 'success',
  metrics_observed_at: '2027-01-01T00:02:00.000Z', last_input_at: null,
  unreachable_incident_id: 'incident-1', unreachable_first_observed_at: '2027-01-01T00:02:00.000Z',
  unreachable_deadline_ms: 120000, termination_intent_id: null, termination_generation: null,
};

describe('REQ-SESSION-010 / REQ-SESSION-028: D1 batch status', () => {
  let kv: ReturnType<typeof createMockKV>;
  let all: ReturnType<typeof vi.fn>;
  let db: D1Database;

  beforeEach(() => {
    kv = createMockKV();
    all = vi.fn(async () => ({ results: [row] }));
    const statement = { bind: vi.fn().mockReturnThis(), all };
    db = { prepare: vi.fn(() => statement) } as unknown as D1Database;
  });

  function app() {
    return createTestApp({
      routes: [{ path: '/sessions', handler: lifecycleRoutes }],
      mockKV: kv,
      envOverrides: { USAGE_DB: db } as Partial<Env>,
    });
  }

  it('uses one owner-indexed D1 query and performs no session KV operations', async () => {
    const response = await app().request('/sessions/batch-status');
    expect(response.status).toBe(200);
    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
    expect(kv.list).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('returns ordered lifecycle, metrics, readiness, and incident fields', async () => {
    const response = await app().request('/sessions/batch-status');
    const body = await response.json() as { statuses: Record<string, unknown> };
    expect(body.statuses[row.session_id]).toMatchObject({
      status: 'unreachable', lifecycle: 'unreachable', generation: 3, revision: 9,
      editorReady: false, editorReadyError: false,
      unreachableIncidentId: 'incident-1', unreachableDeadlineMs: 120000,
      metrics: { cpu: '12%', mem: '1GB', hdd: '2GB', syncStatus: 'success' },
    });
  });

  it('is explicitly non-cacheable', async () => {
    const response = await app().request('/sessions/batch-status');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });
});
