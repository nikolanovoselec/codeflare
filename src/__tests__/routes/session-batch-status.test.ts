import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
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
    db = {
      prepare: vi.fn((_sql: string) => {
        const statement = {
          bind: vi.fn().mockReturnThis(),
          all,
          run: vi.fn(async () => { throw new Error('batch status cannot write D1'); }),
        };
        return statement;
      }),
    } as unknown as D1Database;
  });

  function app() {
    return createTestApp({
      routes: [{ path: '/sessions', handler: lifecycleRoutes }],
      mockKV: kv,
      envOverrides: { USAGE_DB: db } as Partial<Env>,
    });
  }

  it('REQ-SESSION-035: a stale stopping owner status read does not invent exit evidence', async () => {
    const sessionId = 'stale001';
    await kv.put(`session:test-bucket:${sessionId}`, JSON.stringify({
      id: sessionId,
      name: 'Stale stop',
      status: 'stopping',
      createdAt: '2027-01-01T00:00:00.000Z',
      lastAccessedAt: '2027-01-01T00:00:00.000Z',
      transitionedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      lifecycleGeneration: 2,
      responseRevision: 9,
      editorReady: true,
      editorReadyError: true,
      terminationIntentId: 'intent-1',
      terminationGeneration: 2,
    }));
    db = createMockSessionD1(kv);

    const response = await app().request('/sessions/batch-status');
    expect(response.status).toBe(200);
    const body = await response.json() as { statuses: Record<string, unknown> };
    expect(body.statuses[sessionId]).toMatchObject({
      status: 'stopping', lifecycle: 'stopping', revision: 9,
      editorReady: true, editorReadyError: true,
    });
    expect(await kv.get(`session:test-bucket:${sessionId}`, 'json')).toMatchObject({
      status: 'stopping', responseRevision: 9, terminationIntentId: 'intent-1',
      editorReady: true, editorReadyError: true,
    });
  });

  it('returns the owner D1 projection without ancillary KV I/O or session writes', async () => {
    kv.get.mockImplementation(async () => { throw new Error('batch status cannot read KV'); });
    kv.list.mockImplementation(async () => { throw new Error('batch status cannot enumerate KV'); });
    kv.put.mockImplementation(async () => { throw new Error('batch status cannot write KV'); });
    const response = await app().request('/sessions/batch-status?include=storage,usage&includePreseedCheck=true');
    expect(response.status).toBe(200);
    const body = await response.json() as { statuses: Record<string, { status: string }> };
    expect(body.statuses[row.session_id]?.status).toBe('unreachable');
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
