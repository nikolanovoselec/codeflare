/**
 * REQ-SESSION-010: Session status observable from dashboard
 * AC coverage: AC1 (batch-status uses KV list metadata, no DO contact),
 *              AC2 (only running/stopped persisted; ephemeral states frontend-only),
 *              AC3 (SESSION_LIST_POLL_INTERVAL_MS constant - structural),
 *              AC4 (three-color logic: green/yellow/gray - frontend, structural),
 *              AC5 (metrics included in list metadata with ~60s staleness),
 *              AC6 (lastActiveAt and lastStartedAt in response),
 *              AC7 (frontend disposal on stopped transition - structural)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AccessUser, Env, Session, UsageRecord } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import {
  buildSessionMetadata,
  expandSessionMetadata,
  getTimekeeperKey,
  getUtcDateString,
  getUtcMonthString,
  type SessionListMetadata,
} from '../../lib/kv-keys';
import { isSaasModeActive } from '../../lib/onboarding';
import { getEffectiveTierForUser, getDefaultTiers, resetTierConfigCache } from '../../lib/subscription';

const persistedContainerState = vi.hoisted(() => ({
  status: 'running',
  error: null as Error | null,
}));

vi.mock('../../lib/onboarding', () => ({ isSaasModeActive: vi.fn(() => false) }));
vi.mock('../../lib/agent-seed.generated', () => ({
  PRESEED_CONTENT_HASH: 'abc1234567890def',
  RETIRED_PRESEED_KEYS: [] as readonly string[],
}));
vi.mock('../../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));
vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({
    getState: vi.fn(async () => {
      if (persistedContainerState.error) throw persistedContainerState.error;
      return { status: persistedContainerState.status };
    }),
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [] }), { status: 200 })),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}));
// REQ-ENTERPRISE-020: stub the Governed Mode reconcile + driver so the wiring test can assert
// the synchronous decision + backgrounded chunk advance without running a real migration.
vi.mock('../../lib/r2-migration', () => ({
  planRegimeReconcile: vi.fn(async () => ({ state: {}, migrating: false, pending: false })),
  advanceMigration: vi.fn(async () => {}),
}));
vi.mock('../../lib/migration-containers', () => ({
  hasHealthyContainer: vi.fn(async () => false),
  drainContainers: vi.fn(async () => {}),
}));
const managedReleaseState = vi.hoisted(() => ({
  active: null as null | { digest: string; pointer: { sequence: number }; resourcePolicy: 'mutable' | 'immutable' | 'exclusive' },
  error: null as Error | null,
}));
vi.mock('../../lib/managed-release-active', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/managed-release-active')>()),
  getActiveManagedRelease: vi.fn(async () => {
    if (managedReleaseState.error) throw managedReleaseState.error;
    return managedReleaseState.active;
  }),
}));

import lifecycleRoutes from '../../routes/session/lifecycle';
import { planRegimeReconcile, advanceMigration } from '../../lib/r2-migration';

describe('REQ-SESSION-010: Session status observable from dashboard', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    // REQ-ENTERPRISE-020: every test starts with a not-migrating bucket so unrelated batch-status
    // assertions are unaffected; the Governed Mode block overrides these per test.
    vi.mocked(planRegimeReconcile).mockResolvedValue({ state: {} as never, migrating: false, pending: false });
    vi.mocked(advanceMigration).mockResolvedValue(undefined);
    managedReleaseState.active = null;
    managedReleaseState.error = null;
    persistedContainerState.status = 'running';
    persistedContainerState.error = null;
    vi.mocked(isSaasModeActive).mockReturnValue(false);
  });

  function createApp(envOverrides: Partial<Env> = {}, user?: AccessUser) {
    return createTestApp({
      routes: [{ path: '/sessions', handler: lifecycleRoutes }],
      mockKV,
      envOverrides,
      ...(user && { user }),
    });
  }

  function makeSession(id: string, status: Session['status'], overrides: Partial<Session> = {}): Session {
    return {
      id,
      name: `Session ${id}`,
      userId: 'test-bucket',
      status,
      createdAt: '2024-01-01T00:00:00.000Z',
      lastAccessedAt: '2024-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  // AC1: GET /api/sessions/batch-status uses KV list metadata, single kv.list() call
  describe('REQ-SESSION-010 AC1: batch-status uses KV list metadata, no DO contact', () => {
    it('returns statuses for all sessions from KV metadata fast path', async () => {
      const session1 = makeSession('aabbccdd11223344', 'running');
      const session2 = makeSession('eeff001122334455', 'stopped');
      mockKV._set('session:test-bucket:aabbccdd11223344', session1, buildSessionMetadata(session1));
      mockKV._set('session:test-bucket:eeff001122334455', session2, buildSessionMetadata(session2));

      const app = createApp();
      const res = await app.request('/sessions/batch-status');

      expect(res.status).toBe(200);
      const body = await res.json() as { statuses: Record<string, { status: string }> };
      expect(body.statuses['aabbccdd11223344'].status).toBe('running');
      expect(body.statuses['eeff001122334455'].status).toBe('stopped');
    });

    it('uses kv.list() not individual kv.get() for fast path (no DO contact)', async () => {
      const session = makeSession('aabbccdd11223344', 'running');
      mockKV._set('session:test-bucket:aabbccdd11223344', session, buildSessionMetadata(session));

      const app = createApp();
      await app.request('/sessions/batch-status');

      // Fast path reads from list metadata - KV.get should NOT be called
      // for the session key (only KV.list is used)
      const getCalls = mockKV.get.mock.calls as [string, ...unknown[]][];
      const sessionGetCalls = getCalls.filter(
        ([key]) => typeof key === 'string' && key.startsWith('session:test-bucket:')
      );
      expect(sessionGetCalls.length).toBe(0);
    });

    it('returns empty statuses object when user has no sessions', async () => {
      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      expect(res.status).toBe(200);
      const body = await res.json() as { statuses: Record<string, unknown> };
      expect(Object.keys(body.statuses)).toHaveLength(0);
    });
  });

  // KV status is authoritative: a session KV-marked running is reported
  // running regardless of metrics-heartbeat age. The container writes
  // 'stopped' on exit (collectMetrics/onError), so there is no read-side
  // staleness reconciliation that could falsely downgrade a live session.
  describe('batch-status reports KV status verbatim (no staleness reconciliation)', () => {
    it('reports a running session as running even when its metrics heartbeat is stale', async () => {
      const staleU = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
      const session: Session = {
        ...makeSession('aabbccdd11223344', 'running'),
        metrics: { cpu: '5%', mem: '128MB', hdd: '1GB', syncStatus: 'success', updatedAt: staleU },
      };
      mockKV._set('session:test-bucket:aabbccdd11223344', session, buildSessionMetadata(session));

      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      const body = await res.json() as { statuses: Record<string, { status: string; ptyActive: boolean }> };
      expect(body.statuses['aabbccdd11223344'].status).toBe('running');
    });

    it('reports a stopped session as stopped', async () => {
      const session = makeSession('aabbccdd11223344', 'stopped');
      mockKV._set('session:test-bucket:aabbccdd11223344', session, buildSessionMetadata(session));

      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      const body = await res.json() as { statuses: Record<string, { status: string }> };
      expect(body.statuses['aabbccdd11223344'].status).toBe('stopped');
    });

    // CF-043
    // A single batch-status call can contain BOTH metadata-bearing keys (fast
    // path) and pre-migration keys without metadata (fallback KV.get). This
    // pins that both branches execute in one request and each session lands in
    // the response from its respective path. REQ-SESSION-010 AC1.
    it('REQ-SESSION-028 AC2: resolves a mix of fast-path metadata and fallback legacy keys', async () => {
      const fast = makeSession('aabbccdd11223344', 'running');
      const slow = makeSession('eeff001122334455', 'stopped');
      // fast key carries metadata -> fast path; slow key omits it -> fallback.
      mockKV._set('session:test-bucket:aabbccdd11223344', fast, buildSessionMetadata(fast));
      mockKV._set('session:test-bucket:eeff001122334455', slow);

      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      const body = await res.json() as { statuses: Record<string, { status: string }> };

      expect(body.statuses['aabbccdd11223344'].status).toBe('running');
      expect(body.statuses['eeff001122334455'].status).toBe('stopped');

      // The fallback path issues a KV.get only for the no-metadata key; the
      // fast-path key must NOT trigger an individual KV.get.
      const getCalls = mockKV.get.mock.calls as [string, ...unknown[]][];
      const sessionGetKeys = getCalls
        .map(([key]) => key)
        .filter((key): key is string => typeof key === 'string' && key.startsWith('session:test-bucket:'));
      expect(sessionGetKeys).toContain('session:test-bucket:eeff001122334455');
      expect(sessionGetKeys).not.toContain('session:test-bucket:aabbccdd11223344');
    });

    it('reports KV status verbatim on the fallback (pre-migration, no metadata) path too', async () => {
      const staleU = new Date(Date.now() - 600_000).toISOString();
      const session: Session = {
        ...makeSession('aabbccdd11223344', 'running'),
        metrics: { cpu: '5%', mem: '128MB', hdd: '1GB', syncStatus: 'success', updatedAt: staleU },
      };
      // No metadata argument -> forces the fallback KV.get path.
      mockKV._set('session:test-bucket:aabbccdd11223344', session);

      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      const body = await res.json() as { statuses: Record<string, { status: string }> };
      expect(body.statuses['aabbccdd11223344'].status).toBe('running');
    });
  });

  // AC2: Backend KV stores only 'running' and 'stopped'; ephemeral states are frontend-only
  describe('REQ-SESSION-010 AC2: only running/stopped persisted to KV', () => {
    it('buildSessionMetadata encodes running as "r"', () => {
      const session = makeSession('aabbccdd11223344', 'running');
      const meta = buildSessionMetadata(session);
      expect(meta.s).toBe('r');
    });

    it('buildSessionMetadata encodes stopped as "s"', () => {
      const session = makeSession('aabbccdd11223344', 'stopped');
      const meta = buildSessionMetadata(session);
      expect(meta.s).toBe('s');
    });

    it('expandSessionMetadata maps "r" to status=running with ptyActive=true', () => {
      const meta: SessionListMetadata = { s: 'r', la: null as unknown as string, sa: null as unknown as string };
      const expanded = expandSessionMetadata(meta);
      expect(expanded.status).toBe('running');
      expect(expanded.ptyActive).toBe(true);
    });

    it('keeps Terminal metadata free of editor readiness while reporting PTY activity', () => {
      const session = makeSession('aabbccdd11223344', 'running');
      const meta = buildSessionMetadata(session);
      const expanded = expandSessionMetadata(meta);

      expect(meta.er).toBeUndefined();
      expect(meta.ee).toBeUndefined();
      expect(expanded).toMatchObject({ status: 'running', ptyActive: true });
      expect(expanded.editorReady).toBeUndefined();
      expect(expanded.editorReadyError).toBeUndefined();
    });

    it('expandSessionMetadata maps "s" to status=stopped with ptyActive=false', () => {
      const meta: SessionListMetadata = { s: 's' };
      const expanded = expandSessionMetadata(meta);
      expect(expanded.status).toBe('stopped');
      expect(expanded.ptyActive).toBe(false);
    });

    it('REQ-IDE-050 AC1: carries editor readiness without claiming a VS Code PTY', async () => {
      const session = { ...makeSession('aabbccdd11223344', 'running'), workspace: 'vscode' as const, editorReady: true };
      mockKV._set('session:test-bucket:aabbccdd11223344', session, buildSessionMetadata(session));

      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      const body = await res.json() as { statuses: Record<string, { editorReady?: boolean; ptyActive: boolean }> };

      expect(body.statuses.aabbccdd11223344).toMatchObject({ editorReady: true, ptyActive: false });
    });

    it('REQ-IDE-049 AC2: carries bounded editor failure for dashboard retry', async () => {
      const session = {
        ...makeSession('aabbccdd11223344', 'running'),
        workspace: 'vscode' as const,
        editorReady: false,
        editorReadyError: true,
      };
      mockKV._set('session:test-bucket:aabbccdd11223344', session, buildSessionMetadata(session));

      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      const body = await res.json() as { statuses: Record<string, { editorReady?: boolean; editorReadyError?: boolean }> };

      expect(body.statuses.aabbccdd11223344).toMatchObject({ editorReady: false, editorReadyError: true });

      const { editorReadyError: _clearedError, ...recovered } = session;
      const ready = { ...recovered, editorReady: true };
      mockKV._set('session:test-bucket:aabbccdd11223344', ready, buildSessionMetadata(ready));
      const retryResponse = await app.request('/sessions/batch-status');
      const retryBody = await retryResponse.json() as { statuses: Record<string, { editorReady?: boolean; editorReadyError?: boolean }> };
      expect(retryBody.statuses.aabbccdd11223344).toMatchObject({ editorReady: true });
      expect(retryBody.statuses.aabbccdd11223344.editorReadyError).toBeUndefined();
    });

    it('batch-status response does not include initializing/stopping/error status values', async () => {
      const session = makeSession('aabbccdd11223344', 'running');
      mockKV._set('session:test-bucket:aabbccdd11223344', session, buildSessionMetadata(session));

      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      const body = await res.json() as { statuses: Record<string, { status: string }> };

      const statuses = Object.values(body.statuses).map((s) => s.status);
      for (const status of statuses) {
        expect(['running', 'stopped']).toContain(status);
      }
    });
  });

  // AC5: Metrics included in list metadata with ~60s staleness
  describe('REQ-SESSION-010 AC5: metrics included in list metadata', () => {
    it('buildSessionMetadata includes compressed metrics', () => {
      const session: Session = {
        ...makeSession('aabbccdd11223344', 'running'),
        metrics: {
          cpu: '25%',
          mem: '512MB',
          hdd: '10GB',
          syncStatus: 'success',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      const meta = buildSessionMetadata(session);
      expect(meta.m).toBeDefined();
      expect(meta.m!.c).toBe('25%');
      expect(meta.m!.e).toBe('512MB');
      expect(meta.m!.h).toBe('10GB');
      expect(meta.m!.y).toBe('success');
    });

    it('expandSessionMetadata expands compressed metrics back to named fields', () => {
      const meta: SessionListMetadata = {
        s: 'r',
        m: { c: '50%', e: '1GB', h: '20GB', y: 'success', u: '2024-01-01T00:00:00.000Z' },
      };
      const expanded = expandSessionMetadata(meta);
      expect(expanded.metrics).toBeDefined();
      expect(expanded.metrics!.cpu).toBe('50%');
      expect(expanded.metrics!.mem).toBe('1GB');
      expect(expanded.metrics!.hdd).toBe('20GB');
      expect(expanded.metrics!.syncStatus).toBe('success');
    });

    it('batch-status includes metrics when present in metadata', async () => {
      const session: Session = {
        ...makeSession('aabbccdd11223344', 'running'),
        metrics: { cpu: '30%', mem: '768MB', hdd: '5GB', syncStatus: 'success', updatedAt: '2024-01-01T00:00:00.000Z' },
      };
      mockKV._set('session:test-bucket:aabbccdd11223344', session, buildSessionMetadata(session));

      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      const body = await res.json() as { statuses: Record<string, { metrics?: { cpu?: string } }> };
      expect(body.statuses['aabbccdd11223344'].metrics).toBeDefined();
      expect(body.statuses['aabbccdd11223344'].metrics!.cpu).toBe('30%');
    });
  });

  // AC6: lastActiveAt and lastStartedAt timestamps available
  describe('REQ-SESSION-010 AC6: lastActiveAt and lastStartedAt in batch-status response', () => {
    it('returns lastActiveAt and lastStartedAt from KV metadata', async () => {
      const session: Session = {
        ...makeSession('aabbccdd11223344', 'running'),
        lastActiveAt: '2024-01-01T10:00:00.000Z',
        lastStartedAt: '2024-01-01T09:00:00.000Z',
      };
      mockKV._set('session:test-bucket:aabbccdd11223344', session, buildSessionMetadata(session));

      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      const body = await res.json() as {
        statuses: Record<string, { lastActiveAt: string | null; lastStartedAt: string | null }>
      };
      expect(body.statuses['aabbccdd11223344'].lastActiveAt).toBe('2024-01-01T10:00:00.000Z');
      expect(body.statuses['aabbccdd11223344'].lastStartedAt).toBe('2024-01-01T09:00:00.000Z');
    });

    it('buildSessionMetadata preserves lastActiveAt (la) and lastStartedAt (sa)', () => {
      const session: Session = {
        ...makeSession('aabbccdd11223344', 'running'),
        lastActiveAt: '2024-06-01T12:00:00.000Z',
        lastStartedAt: '2024-06-01T11:00:00.000Z',
      };
      const meta = buildSessionMetadata(session);
      expect(meta.la).toBe('2024-06-01T12:00:00.000Z');
      expect(meta.sa).toBe('2024-06-01T11:00:00.000Z');
    });

    it('expandSessionMetadata returns null for missing lastActiveAt', () => {
      const meta: SessionListMetadata = { s: 's' };
      const expanded = expandSessionMetadata(meta);
      expect(expanded.lastActiveAt).toBeNull();
      expect(expanded.lastStartedAt).toBeNull();
    });
  });

  // REQ-AGENT-049: preseed upgrade check piggybacked on batch-status
  describe('REQ-AGENT-049: preseed upgrade detection via batch-status', () => {
    it('returns preseedNeedsUpgrade true when hash missing from preferences', async () => {
      const app = createApp();
      const res = await app.request('/sessions/batch-status?includePreseedCheck=true');
      expect(res.status).toBe(200);
      const body = await res.json() as { preseedNeedsUpgrade?: boolean };
      expect(body.preseedNeedsUpgrade).toBe(true);
    });

    it('returns preseedNeedsUpgrade true when hash mismatches', async () => {
      mockKV._set('user-prefs:test-bucket', { lastPreseedHash: 'stale_old_hash_00' });
      const app = createApp();
      const res = await app.request('/sessions/batch-status?includePreseedCheck=true');
      expect(res.status).toBe(200);
      const body = await res.json() as { preseedNeedsUpgrade?: boolean };
      expect(body.preseedNeedsUpgrade).toBe(true);
    });

    it('returns preseedNeedsUpgrade false when hash matches', async () => {
      mockKV._set('user-prefs:test-bucket', { lastPreseedHash: 'abc1234567890def' });
      const app = createApp();
      const res = await app.request('/sessions/batch-status?includePreseedCheck=true');
      expect(res.status).toBe(200);
      const body = await res.json() as { preseedNeedsUpgrade?: boolean };
      expect(body.preseedNeedsUpgrade).toBe(false);
    });

    // REQ-ENTERPRISE-001 AC6: a pre-existing enterprise bucket without a stamped
    // Pro preference upgrades via the same UPDATING flow even when the release
    // hash already matches.
    it('enterprise: returns preseedNeedsUpgrade true when stored sessionMode is not advanced despite matching hash', async () => {
      mockKV._set('user-prefs:test-bucket', { lastPreseedHash: 'abc1234567890def' });
      const app = createApp({ ENTERPRISE_MODE: 'active' });
      const res = await app.request('/sessions/batch-status?includePreseedCheck=true');
      expect(res.status).toBe(200);
      const body = await res.json() as { preseedNeedsUpgrade?: boolean };
      expect(body.preseedNeedsUpgrade).toBe(true);
    });

    it('enterprise: returns preseedNeedsUpgrade false once the preference is stamped advanced and hash matches', async () => {
      mockKV._set('user-prefs:test-bucket', { lastPreseedHash: 'abc1234567890def', sessionMode: 'advanced' });
      const app = createApp({ ENTERPRISE_MODE: 'active' });
      const res = await app.request('/sessions/batch-status?includePreseedCheck=true');
      expect(res.status).toBe(200);
      const body = await res.json() as { preseedNeedsUpgrade?: boolean };
      expect(body.preseedNeedsUpgrade).toBe(false);
    });

    it('omits preseedNeedsUpgrade when query param absent', async () => {
      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      expect(res.status).toBe(200);
      const body = await res.json() as { preseedNeedsUpgrade?: boolean };
      expect(body.preseedNeedsUpgrade).toBeUndefined();
    });

    it('REQ-STOR-023 AC1+AC2: initial status compares descriptor and mode without payload bytes', async () => {
      managedReleaseState.active = { digest: 'd'.repeat(64), pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      mockKV._set('user-prefs:test-bucket', { sessionMode: 'default' });
      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };
      expect(body.managedReleaseStatus).toBe('upgrading');
      expect(body.preseedNeedsUpgrade).toBe(true);
    });

    it('REQ-STOR-022 AC1+AC2: a running session defers mutation and reports pending status', async () => {
      managedReleaseState.active = { digest: 'd'.repeat(64), pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      const running = makeSession('aabbccdd11223344', 'running');
      mockKV._set('session:test-bucket:aabbccdd11223344', running, buildSessionMetadata(running));
      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };
      expect(body.managedReleaseStatus).toBe('update_pending');
      expect(body.preseedNeedsUpgrade).toBe(false);
    });

    it('REQ-STOR-022: stale running metadata does not strand reconciliation after persisted stop', async () => {
      managedReleaseState.active = { digest: 'd'.repeat(64), pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      const stopped = makeSession('aabbccdd11223344', 'stopped');
      mockKV._set('session:test-bucket:aabbccdd11223344', stopped, {
        ...buildSessionMetadata(stopped),
        s: 'r',
      });
      persistedContainerState.status = 'stopped';

      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };

      expect(body.managedReleaseStatus).toBe('upgrading');
      expect(body.preseedNeedsUpgrade).toBe(true);
    });

    it('REQ-STOR-022 AC1+AC2: initializing metadata also defers reconciliation', async () => {
      managedReleaseState.active = { digest: 'd'.repeat(64), pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      const session = makeSession('aabbccdd11223344', 'stopped');
      mockKV._set('session:test-bucket:aabbccdd11223344', session, {
        ...buildSessionMetadata(session),
        s: 'i',
      });

      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };

      expect(body.managedReleaseStatus).toBe('update_pending');
      expect(body.preseedNeedsUpgrade).toBe(false);
    });

    it('blocks New Session when enabled curation is unavailable and no release was previously applied', async () => {
      managedReleaseState.error = new Error('verified cache unavailable');
      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };
      expect(body.managedReleaseStatus).toBe('update_pending');
      expect(body.preseedNeedsUpgrade).toBe(false);
    });

    it('REQ-STOR-023 AC7: reports update pending when no compatible verified active release is available', async () => {
      managedReleaseState.error = new Error('verified cache unavailable');
      mockKV._set('user-prefs:test-bucket', {
        sessionMode: 'default',
        managedEnvironmentApplied: { digest: 'd'.repeat(64), managedExtensionsDigest: 'e'.repeat(64), sequence: 4, mode: 'default', appliedAt: '2026-01-01T00:00:00.000Z' },
      });
      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };
      expect(body.managedReleaseStatus).toBe('update_pending');
      expect(body.preseedNeedsUpgrade).toBe(false);
    });

    it('REQ-STOR-023 AC5: an outage rejects last-known-good state for another mode', async () => {
      managedReleaseState.error = new Error('verified cache unavailable');
      mockKV._set('user-prefs:test-bucket', {
        managedEnvironmentApplied: { digest: 'd'.repeat(64), managedExtensionsDigest: 'e'.repeat(64), sequence: 4, mode: 'default', appliedAt: '2026-01-01T00:00:00.000Z' },
      });
      const res = await createApp({ ENTERPRISE_MODE: 'active' }).request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };
      expect(body.managedReleaseStatus).toBe('update_pending');
      expect(body.preseedNeedsUpgrade).toBe(false);
    });

    it('reports upgrading when a downgraded SaaS user has advanced managed content applied', async () => {
      vi.mocked(isSaasModeActive).mockReturnValue(true);
      managedReleaseState.active = { digest: 'd'.repeat(64), pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      mockKV._set('user-prefs:test-bucket', {
        sessionMode: 'advanced',
        managedEnvironmentApplied: { digest: 'd'.repeat(64), managedExtensionsDigest: 'e'.repeat(64), sequence: 4, mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z' },
      });
      const res = await createApp({ SAAS_MODE: 'active' }, {
        email: 'test@example.com',
        authenticated: true,
        subscriptionTier: 'advanced',
        billingStatus: 'canceled',
      }).request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };

      expect(body.managedReleaseStatus).toBe('upgrading');
      expect(body.preseedNeedsUpgrade).toBe(true);
    });

    it('REQ-STOR-023 AC1: a pre-upgrade applied stamp without a manifest digest requires reconciliation', async () => {
      managedReleaseState.active = { digest: 'd'.repeat(64), pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      mockKV._set('user-prefs:test-bucket', {
        sessionMode: 'default',
        managedEnvironmentApplied: { digest: 'd'.repeat(64), sequence: 4, mode: 'default', appliedAt: '2026-01-01T00:00:00.000Z' },
      });
      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };
      expect(body.managedReleaseStatus).toBe('upgrading');
      expect(body.preseedNeedsUpgrade).toBe(true);
    });

    it.each([
      ['policy changed', 'immutable', undefined],
      ['protected path identity missing', 'exclusive', 'exclusive'],
    ] as const)('REQ-STOR-023 AC1: reports upgrading when managed resource %s', async (_case, desiredPolicy, appliedPolicy) => {
      managedReleaseState.active = { digest: 'd'.repeat(64), pointer: { sequence: 4 }, resourcePolicy: desiredPolicy };
      mockKV._set('user-prefs:test-bucket', {
        sessionMode: 'advanced',
        managedEnvironmentApplied: {
          digest: 'd'.repeat(64), managedExtensionsDigest: 'e'.repeat(64), sequence: 4, mode: 'advanced',
          ...(appliedPolicy ? { resourcePolicy: appliedPolicy } : {}),
          appliedAt: '2026-01-01T00:00:00.000Z',
        },
      });

      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };

      expect(body.managedReleaseStatus).toBe('upgrading');
      expect(body.preseedNeedsUpgrade).toBe(true);
    });

    it('reports current only when the active release, manifest digest, resolved mode, and resource policy match applied state', async () => {
      managedReleaseState.active = { digest: 'd'.repeat(64), pointer: { sequence: 4 }, resourcePolicy: 'immutable' };
      mockKV._set('user-prefs:test-bucket', {
        sessionMode: 'advanced',
        managedEnvironmentApplied: {
          digest: 'd'.repeat(64), managedExtensionsDigest: 'e'.repeat(64), sequence: 4, mode: 'advanced',
          resourcePolicy: 'immutable', managedPathsDigest: 'f'.repeat(64), appliedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };
      expect(body.managedReleaseStatus).toBe('current');
      expect(body.preseedNeedsUpgrade).toBe(false);
    });

    it('REQ-STOR-023 AC6: pending target state retries even when applied identity matches active', async () => {
      const digest = 'd'.repeat(64);
      managedReleaseState.active = { digest, pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      mockKV._set('user-prefs:test-bucket', {
        sessionMode: 'default',
        managedEnvironmentApplied: {
          digest, managedExtensionsDigest: 'e'.repeat(64), sequence: 4,
          mode: 'default', appliedAt: '2026-01-01T00:00:00.000Z',
        },
        managedEnvironmentReconciliation: {
          targets: [{ digest: 'c'.repeat(64), sequence: 3, mode: 'default' }],
        },
      });

      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };

      expect(body.managedReleaseStatus).toBe('upgrading');
      expect(body.preseedNeedsUpgrade).toBe(true);
    });

    it('REQ-STOR-036 AC2: batch status exposes only matching pending progress', async () => {
      const digest = 'd'.repeat(64);
      managedReleaseState.active = { digest, pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      mockKV._set('user-prefs:test-bucket', { sessionMode: 'default' });
      mockKV._set('managed-reconcile-progress:test-bucket', {
        schemaVersion: 1, targetDigest: digest, phase: 'writing', completed: 25, total: 61,
        updatedAt: '2026-08-31T12:00:00.000Z',
      });

      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseProgress?: unknown };
      expect(body.managedReleaseProgress).toEqual({ phase: 'writing', completed: 25, total: 61 });
    });

    it('REQ-STOR-036 AC3: progress read failure cannot replace authoritative upgrading status', async () => {
      const digest = 'd'.repeat(64);
      managedReleaseState.active = { digest, pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      mockKV._set('user-prefs:test-bucket', { sessionMode: 'default' });
      const read = mockKV.get.getMockImplementation()!;
      mockKV.get.mockImplementation((key, type) => (
        key === 'managed-reconcile-progress:test-bucket'
          ? Promise.reject(new Error('progress unavailable'))
          : read(key, type)
      ));

      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; preseedNeedsUpgrade?: boolean };
      expect(body.managedReleaseStatus).toBe('upgrading');
      expect(body.preseedNeedsUpgrade).toBe(true);
    });

    it('REQ-STOR-036 AC1: malformed progress is omitted', async () => {
      const digest = 'd'.repeat(64);
      managedReleaseState.active = { digest, pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      mockKV._set('user-prefs:test-bucket', { sessionMode: 'default' });
      mockKV._set('managed-reconcile-progress:test-bucket', {
        schemaVersion: 1, targetDigest: digest, phase: 'writing', completed: 62, total: 61,
        updatedAt: '2026-08-31T12:00:00.000Z',
      });

      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseProgress?: unknown };
      expect(body.managedReleaseProgress).toBeUndefined();
    });

    it('REQ-STOR-036 AC2: update-pending state omits progress', async () => {
      const digest = 'd'.repeat(64);
      managedReleaseState.active = { digest, pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      const running = makeSession('aabbccdd11223344', 'running');
      mockKV._set('session:test-bucket:aabbccdd11223344', running, buildSessionMetadata(running));
      mockKV._set('managed-reconcile-progress:test-bucket', {
        schemaVersion: 1, targetDigest: digest, phase: 'writing', completed: 25, total: 61,
        updatedAt: '2026-08-31T12:00:00.000Z',
      });

      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseStatus?: string; managedReleaseProgress?: unknown };
      expect(body.managedReleaseStatus).toBe('update_pending');
      expect(body.managedReleaseProgress).toBeUndefined();
    });

    it('REQ-STOR-036 AC4: applied target omits and opportunistically clears stale progress', async () => {
      const digest = 'd'.repeat(64);
      managedReleaseState.active = { digest, pointer: { sequence: 4 }, resourcePolicy: 'mutable' };
      mockKV._set('user-prefs:test-bucket', {
        sessionMode: 'default',
        managedEnvironmentApplied: {
          digest, managedExtensionsDigest: 'e'.repeat(64), sequence: 4, mode: 'default',
          appliedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      mockKV._set('managed-reconcile-progress:test-bucket', {
        schemaVersion: 1, targetDigest: digest, phase: 'finalizing', completed: 61, total: 61,
        updatedAt: '2026-08-31T12:00:00.000Z',
      });

      const res = await createApp().request('/sessions/batch-status?includePreseedCheck=true');
      const body = await res.json() as { managedReleaseProgress?: unknown };
      expect(body.managedReleaseProgress).toBeUndefined();
      expect(mockKV.delete).toHaveBeenCalledWith('managed-reconcile-progress:test-bucket');
    });
  });

  // REQ-ENTERPRISE-020: every batch-status poll synchronously decides the Governed Mode regime
  // (so the same response reports bucketMigrating) and, while migrating, advances one re-encrypt
  // chunk in the background — off the container-start path so it can never block session creation.
  describe('REQ-ENTERPRISE-020: Governed Mode reconcile + chunk advance on batch-status', () => {
    beforeEach(() => {
      vi.mocked(planRegimeReconcile).mockReset().mockResolvedValue({ state: {} as any, migrating: false, pending: false });
      vi.mocked(advanceMigration).mockReset().mockResolvedValue(undefined);
    });

    function makeExecCtx() {
      const scheduled: Promise<unknown>[] = [];
      return { ctx: { waitUntil: (p: Promise<unknown>) => { scheduled.push(p); }, passThroughOnException: () => {} }, scheduled };
    }

    it('decides the regime on every poll and reports a not-migrating bucket as false', async () => {
      const app = createApp();
      const { ctx } = makeExecCtx();
      const res = await app.request('/sessions/batch-status', undefined, undefined, ctx as any);
      expect(res.status).toBe(200);
      expect(planRegimeReconcile).toHaveBeenCalledWith(expect.anything(), 'test-bucket', expect.any(Function));
      const body = await res.json() as { bucketMigrating: boolean; bucketMigrationPending: boolean };
      expect(body.bucketMigrating).toBe(false);
      expect(body.bucketMigrationPending).toBe(false);
      expect(advanceMigration).not.toHaveBeenCalled(); // nothing to advance
    });

    it('schedules a background chunk advance via waitUntil and reports bucketMigrating when migrating', async () => {
      vi.mocked(planRegimeReconcile).mockResolvedValue({ state: {} as any, migrating: true, pending: false });
      const app = createApp();
      const { ctx, scheduled } = makeExecCtx();
      const res = await app.request('/sessions/batch-status?includePreseedCheck=true', undefined, undefined, ctx as any);
      expect(res.status).toBe(200);
      expect(scheduled).toHaveLength(1); // chunk advance backgrounded, not awaited inline
      expect(advanceMigration).toHaveBeenCalledWith(expect.anything(), 'test-bucket', expect.objectContaining({ drainContainers: expect.any(Function) }));
      const body = await res.json() as { bucketMigrating: boolean };
      expect(body.bucketMigrating).toBe(true);
    });

    it('reports a pending flip (container healthy) without scheduling a chunk advance', async () => {
      vi.mocked(planRegimeReconcile).mockResolvedValue({ state: {} as any, migrating: false, pending: true });
      const app = createApp();
      const { ctx, scheduled } = makeExecCtx();
      const res = await app.request('/sessions/batch-status', undefined, undefined, ctx as any);
      expect(res.status).toBe(200);
      expect(scheduled).toHaveLength(0);
      expect(advanceMigration).not.toHaveBeenCalled();
      const body = await res.json() as { bucketMigrationPending: boolean };
      expect(body.bucketMigrationPending).toBe(true);
    });

    it('does not throw when migrating but no execution context exists (200, no advance)', async () => {
      // No execCtx passed → the c.executionCtx getter throws; the route must swallow it and still
      // return 200 without invoking the chunk advance (the guard's catch branch).
      vi.mocked(planRegimeReconcile).mockResolvedValue({ state: {} as any, migrating: true, pending: false });
      const app = createApp();
      const res = await app.request('/sessions/batch-status?includePreseedCheck=true');
      expect(res.status).toBe(200);
      expect(advanceMigration).not.toHaveBeenCalled();
    });

    it('reports a 0–99 progress % computed across both passes from the reconcile state', async () => {
      // migrate done (processed 100 == total) then halfway through verify (processed 150):
      // 150 / (2·100) = 75%.
      vi.mocked(planRegimeReconcile).mockResolvedValue({ state: { total: 100, processed: 150 } as any, migrating: true, pending: false });
      const app = createApp();
      const { ctx } = makeExecCtx();
      const res = await app.request('/sessions/batch-status', undefined, undefined, ctx as any);
      const body = await res.json() as { bucketMigrating: boolean; bucketMigrationPercent?: number };
      expect(body.bucketMigrating).toBe(true);
      expect(body.bucketMigrationPercent).toBe(75);
    });

    it('omits the progress % until the object total is counted', async () => {
      vi.mocked(planRegimeReconcile).mockResolvedValue({ state: { processed: 3 } as any, migrating: true, pending: false });
      const app = createApp();
      const { ctx } = makeExecCtx();
      const res = await app.request('/sessions/batch-status', undefined, undefined, ctx as any);
      const body = await res.json() as { bucketMigrationPercent?: number };
      expect(body.bucketMigrationPercent).toBeUndefined();
    });

    it('suppresses the progress % when the migration has halted so the button never reads a misleading 99%', async () => {
      // A wedged migration's re-heal passes push processed past 2·total; without the halted guard the
      // clamp would pin the label at "99%" forever.
      vi.mocked(planRegimeReconcile).mockResolvedValue({ state: { total: 100, processed: 250, halted: true } as any, migrating: true, pending: false });
      const app = createApp();
      const { ctx } = makeExecCtx();
      const res = await app.request('/sessions/batch-status', undefined, undefined, ctx as any);
      const body = await res.json() as { bucketMigrating: boolean; bucketMigrationPercent?: number };
      expect(body.bucketMigrating).toBe(true);
      expect(body.bucketMigrationPercent).toBeUndefined();
    });
  });

  describe('REQ-OPS-057 AC2: closed optional batch-status reads', () => {
    it('omits usage and storage reads from status-only requests', async () => {
      mockKV._set('storage-stats:test-bucket', { totalFiles: 1, totalFolders: 0, totalSizeBytes: 10 });
      mockKV._set(getTimekeeperKey('test-bucket'), { today: {}, thisMonth: {} });
      const response = await createApp().request('/sessions/batch-status');
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('usage');
      expect(body).not.toHaveProperty('storageStats');
      const keys = (mockKV.get.mock.calls as [string, ...unknown[]][]).map(([key]) => key);
      expect(keys).not.toContain('storage-stats:test-bucket');
      expect(keys).not.toContain(getTimekeeperKey('test-bucket'));
    });

    it('reads only requested usage and storage fields', async () => {
      mockKV._set('storage-stats:test-bucket', { totalFiles: 1, totalFolders: 0, totalSizeBytes: 10 });
      const storage = await createApp().request('/sessions/batch-status?include=storage');
      expect(await storage.json()).toMatchObject({ storageStats: { totalFiles: 1 } });
      const usage = await createApp().request('/sessions/batch-status?include=usage');
      expect(await usage.json()).toHaveProperty('usage');
      const both = await createApp().request('/sessions/batch-status?include=usage,storage');
      expect(await both.json()).toMatchObject({ storageStats: { totalFiles: 1 }, usage: expect.any(Object) });
    });

    it('rejects unknown or empty include values', async () => {
      expect((await createApp().request('/sessions/batch-status?include=metrics')).status).toBe(400);
      expect((await createApp().request('/sessions/batch-status?include=')).status).toBe(400);
    });
  });

  describe('REQ-SUB-006 AC2: usage visibility outside SaaS mode', () => {
    it('returns accumulated usage without a billing quota in onboarding/default mode', async () => {
      const now = new Date();
      const record: UsageRecord = {
        today: { date: getUtcDateString(now), seconds: 75 },
        thisWeek: { weekStart: getUtcDateString(now), seconds: 450 },
        thisMonth: { month: getUtcMonthString(now), seconds: 1800 },
        thisYear: { year: String(now.getUTCFullYear()), seconds: 3600 },
        allTime: { seconds: 7200 },
        lastUpdatedAt: now.toISOString(),
      };
      mockKV._set(getTimekeeperKey('test-bucket'), record);
      const app = createApp();

      const res = await app.request('/sessions/batch-status?include=usage');
      expect(res.status).toBe(200);
      const body = await res.json() as {
        usage?: { dailySeconds: number; monthlySeconds: number; monthlyQuotaSeconds: number | null };
      };
      expect(body.usage).toEqual(expect.objectContaining({
        dailySeconds: 75,
        monthlySeconds: 1800,
        monthlyQuotaSeconds: null,
      }));
    });
  });

  // CF-041 // CF-071
  // REQ-SUB-013 AC4: in SaaS mode batch-status returns the effective-tier cap
  // (entitlements.maxSessions), not the role-based getMaxSessions() cap, and
  // exposes the SaaS usage object. The default mock pins isSaasModeActive to
  // false, so this block flips it true to exercise the otherwise-dead SaaS
  // branch.
  describe('REQ-SUB-013 AC4: SaaS-mode usage + effective-tier maxSessions', () => {
    beforeEach(() => {
      vi.mocked(isSaasModeActive).mockReturnValue(true);
      // The route's getTierConfig() reads from a module-level cache; clear it
      // so the default tier config is resolved deterministically per test.
      resetTierConfigCache();
    });

    afterEach(() => {
      vi.mocked(isSaasModeActive).mockReturnValue(false);
      resetTierConfigCache();
    });

    // 'unlimited' tier caps at 5 sessions; the non-admin role default is 3, so
    // a passing assertion proves the effective-tier cap (not the role cap) is
    // returned.
    const saasUser = { email: 'saas@example.com', authenticated: true, subscriptionTier: 'unlimited' as const };

    function createSaasApp() {
      return createTestApp({
        routes: [{ path: '/sessions', handler: lifecycleRoutes }],
        mockKV,
        user: saasUser,
      });
    }

    it('returns maxSessions equal to the effective-tier cap, not the role-based cap', async () => {
      const tiers = getDefaultTiers();
      const entitlements = getEffectiveTierForUser(saasUser, tiers);
      // Guard: this test is meaningful only if the effective cap differs from
      // the non-admin role default (3). 'unlimited' resolves to 5.
      expect(entitlements.maxSessions).toBe(5);

      const app = createSaasApp();
      const res = await app.request('/sessions/batch-status');
      expect(res.status).toBe(200);
      const body = await res.json() as { maxSessions: number };
      expect(body.maxSessions).toBe(entitlements.maxSessions);
    });

    it('returns the SaaS usage object seeded from the timekeeper record + tier config', async () => {
      const now = new Date();
      const record: UsageRecord = {
        today: { date: getUtcDateString(now), seconds: 120 },
        thisWeek: { weekStart: getUtcDateString(now), seconds: 600 },
        thisMonth: { month: getUtcMonthString(now), seconds: 3600 },
        thisYear: { year: String(now.getUTCFullYear()), seconds: 7200 },
        allTime: { seconds: 9000 },
        lastUpdatedAt: now.toISOString(),
      };
      mockKV._set(getTimekeeperKey('test-bucket'), record);

      const entitlements = getEffectiveTierForUser(saasUser, getDefaultTiers());

      const app = createSaasApp();
      const res = await app.request('/sessions/batch-status?include=usage');
      expect(res.status).toBe(200);
      const body = await res.json() as {
        usage?: { dailySeconds: number; monthlySeconds: number; monthlyQuotaSeconds: number | null; tier: string };
      };
      expect(body.usage).toBeDefined();
      expect(body.usage!.dailySeconds).toBe(120);
      expect(body.usage!.monthlySeconds).toBe(3600);
      expect(body.usage!.monthlyQuotaSeconds).toBe(entitlements.monthlyQuotaSeconds);
      expect(body.usage!.tier).toBe(entitlements.effectiveTier);
    });
  });
});
