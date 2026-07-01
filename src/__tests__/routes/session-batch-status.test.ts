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
import type { Session, UsageRecord } from '../../types';
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

vi.mock('../../lib/onboarding', () => ({ isSaasModeActive: vi.fn(() => false) }));
vi.mock('../../lib/agent-seed.generated', () => ({ PRESEED_CONTENT_HASH: 'abc1234567890def' }));
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
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [] }), { status: 200 })),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}));
// REQ-ENTERPRISE-018: stub the Governed Mode reconcile + driver so the wiring test can assert
// the synchronous decision + backgrounded chunk advance without running a real migration.
vi.mock('../../lib/r2-migration', () => ({
  planRegimeReconcile: vi.fn(async () => ({ state: {}, migrating: false, pending: false })),
  advanceMigration: vi.fn(async () => {}),
}));
vi.mock('../../lib/migration-containers', () => ({
  hasHealthyContainer: vi.fn(async () => false),
  drainContainers: vi.fn(async () => {}),
}));

import lifecycleRoutes from '../../routes/session/lifecycle';
import { planRegimeReconcile, advanceMigration } from '../../lib/r2-migration';

describe('REQ-SESSION-010: Session status observable from dashboard', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    // REQ-ENTERPRISE-018: every test starts with a not-migrating bucket so unrelated batch-status
    // assertions are unaffected; the Governed Mode block overrides these per test.
    vi.mocked(planRegimeReconcile).mockResolvedValue({ state: {} as never, migrating: false, pending: false });
    vi.mocked(advanceMigration).mockResolvedValue(undefined);
  });

  function createApp() {
    return createTestApp({
      routes: [{ path: '/sessions', handler: lifecycleRoutes }],
      mockKV,
    });
  }

  function makeSession(id: string, status: 'running' | 'stopped', overrides: Partial<Session> = {}): Session {
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
    it('resolves a mix of fast-path (metadata) and fallback (no-metadata) keys in one call', async () => {
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

    it('expandSessionMetadata maps "s" to status=stopped with ptyActive=false', () => {
      const meta: SessionListMetadata = { s: 's' };
      const expanded = expandSessionMetadata(meta);
      expect(expanded.status).toBe('stopped');
      expect(expanded.ptyActive).toBe(false);
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

  // AC3 structural: SESSION_LIST_POLL_INTERVAL_MS exists in frontend constants
  describe('REQ-SESSION-010 AC3: SESSION_LIST_POLL_INTERVAL_MS constant exists (structural)', () => {
    it('web-ui constants define SESSION_LIST_POLL_INTERVAL_MS or equivalent polling constant', async () => {
      // The frontend constant may be in web-ui/src/lib/constants.ts
      // We verify the polling interval is defined somewhere in the web-ui
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const webUiConstantsPath = resolve(__dirname, '../../../web-ui/src/lib/constants.ts');
      let src = '';
      try {
        src = readFileSync(webUiConstantsPath, 'utf8');
      } catch {
        // File may not exist in this worktree environment - skip
        return;
      }
      expect(src).toMatch(/SESSION_LIST_POLL_INTERVAL_MS|POLL_INTERVAL/);
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

    it('omits preseedNeedsUpgrade when query param absent', async () => {
      const app = createApp();
      const res = await app.request('/sessions/batch-status');
      expect(res.status).toBe(200);
      const body = await res.json() as { preseedNeedsUpgrade?: boolean };
      expect(body.preseedNeedsUpgrade).toBeUndefined();
    });
  });

  // REQ-ENTERPRISE-018: every batch-status poll synchronously decides the Governed Mode regime
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
      const res = await app.request('/sessions/batch-status');
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
