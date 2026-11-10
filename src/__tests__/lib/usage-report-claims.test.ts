import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryAdminUsageRows, queryAdminUsageSeries, reactivateUsageUser, tombstoneUsageUser, userKeyForEmail, writeUsageHistory } from '../../lib/admin-usage';
import { createMockKV } from '../helpers/mock-kv';
import type { Env } from '../../types';
import { claimReportDelivery, completeReportDelivery, createDueScheduledDispatch, createReportDispatch, runUsageReportScheduler, runUsageRetention } from '../../lib/usage-report-scheduler';
import { applyPositiveDelta, createAccountingState, hashSessionId, type HistoryOutboxEntry } from '../../timekeeper/accounting';

const db = (env as unknown as { USAGE_DB: D1Database }).USAGE_DB;
const now = new Date('2027-08-01T00:00:00.000Z');

async function insertDelivery(id: string, state: 'pending' | 'sending' | 'failed', attempt: number, leaseExpiresAt: string | null = null): Promise<void> {
  await db.prepare(`INSERT INTO report_deliveries
    (id, delivery_kind, dispatch_id, settings_revision, report_month, recipient, state, attempt, claim_token, lease_expires_at, created_at, updated_at)
    VALUES (?1, 'scheduled', ?1, 1, '2027-07', ?2, ?3, ?4, ?5, ?6, ?7, ?7)`)
    .bind(id, `${id}@example.com`, state, attempt, state === 'sending' ? 'old-token' : null, leaseExpiresAt, '2027-07-01T00:00:00.000Z')
    .run();
}

beforeEach(async () => {
  await db.exec('CREATE TABLE IF NOT EXISTS usage_users (user_key TEXT PRIMARY KEY, email TEXT NOT NULL, account_status TEXT NOT NULL, data_since TEXT NOT NULL, deleted_at TEXT)');
  await db.exec('CREATE TABLE IF NOT EXISTS usage_periods (user_key TEXT NOT NULL REFERENCES usage_users(user_key) ON DELETE CASCADE, period_kind TEXT NOT NULL, period_start TEXT NOT NULL, runtime_seconds INTEGER NOT NULL, session_count INTEGER NOT NULL, source_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_key, period_kind, period_start))');
  await db.exec('CREATE TABLE IF NOT EXISTS report_deliveries (id TEXT PRIMARY KEY, delivery_kind TEXT NOT NULL, dispatch_id TEXT NOT NULL, settings_revision INTEGER NOT NULL, report_month TEXT NOT NULL, recipient TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, claim_token TEXT, lease_expires_at TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, accepted_at TEXT)');
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS report_delivery_claim ON report_deliveries (delivery_kind, dispatch_id, recipient)');
  await db.exec('CREATE TABLE IF NOT EXISTS maintenance_claims (task TEXT NOT NULL, utc_date TEXT NOT NULL, claim_token TEXT NOT NULL, claimed_at TEXT NOT NULL, PRIMARY KEY (task, utc_date))');
  await db.exec('DROP TRIGGER IF EXISTS reject_report_prune');
  await db.exec('DROP TRIGGER IF EXISTS reject_first_live_history');
  await db.batch([
    db.prepare('DELETE FROM usage_periods'),
    db.prepare('DELETE FROM usage_users'),
    db.prepare('DELETE FROM report_deliveries'),
    db.prepare('DELETE FROM maintenance_claims'),
  ]);
});

describe('historical usage D1 guards (REQ-SUB-025, REQ-SUB-026)', () => {
  const first = {
    kind: 'month' as const,
    start: '2027-07',
    runtimeSeconds: 120,
    sessionCount: 2,
    sourceSequence: 7,
    snapshotAt: '2027-08-01T00:00:00.000Z',
  };

  it('keeps newer history, blocks deleted owners, and resumes the same owner after reactivation', async () => {
    const email = 'alice@example.com';
    const userKey = await userKeyForEmail(email);
    await writeUsageHistory(db, email, [first]);

    const stale = { ...first, runtimeSeconds: 999, sourceSequence: 6 };
    expect((await writeUsageHistory(db, email, [stale])).acknowledged).toBe(true);
    let period = await db.prepare('SELECT runtime_seconds, source_sequence FROM usage_periods WHERE user_key = ?1')
      .bind(userKey).first<{ runtime_seconds: number; source_sequence: number }>();
    expect(period).toEqual({ runtime_seconds: 120, source_sequence: 7 });

    await tombstoneUsageUser(db, email, '2027-08-02T00:00:00.000Z');
    const whileDeleted = { ...first, runtimeSeconds: 240, sourceSequence: 8 };
    expect((await writeUsageHistory(db, email, [whileDeleted])).acknowledged).toBe(true);
    period = await db.prepare('SELECT runtime_seconds, source_sequence FROM usage_periods WHERE user_key = ?1')
      .bind(userKey).first<{ runtime_seconds: number; source_sequence: number }>();
    expect(period).toEqual({ runtime_seconds: 120, source_sequence: 7 });

    await reactivateUsageUser(db, ' Alice@Example.com ');
    expect((await writeUsageHistory(db, email, [whileDeleted])).acknowledged).toBe(true);
    period = await db.prepare('SELECT runtime_seconds, source_sequence FROM usage_periods WHERE user_key = ?1')
      .bind(userKey).first<{ runtime_seconds: number; source_sequence: number }>();
    expect(period).toEqual({ runtime_seconds: 240, source_sequence: 8 });
  });

  it('REQ-SUB-025 AC6: first successful history commit records the earliest included live snapshot without legacy backfill', async () => {
    const email = 'live-history@example.com';
    const userKey = await userKeyForEmail(email);
    const startedAt = new Date('2027-07-31T23:59:00.000Z');
    const closedAt = new Date('2027-08-01T00:00:00.000Z');
    const retryAt = new Date('2027-08-01T00:05:00.000Z');
    const initial = await createAccountingState(startedAt, {
      pendingSeconds: 9000,
      sessionTotals: { 'legacy-session-a': 7000, 'legacy-session-b': 4000 },
      lastFlushedMonthlyTotal: 12000,
    });
    const sessionHash = await hashSessionId('live-session');
    const live = applyPositiveDelta(initial, sessionHash, 60, startedAt, new Set<string>());
    const rolled = applyPositiveDelta(live.state, sessionHash, 30, closedAt, new Set(live.markerKeys));
    const snapshots: HistoryOutboxEntry[] = [
      ...rolled.outbox,
      ...(['day', 'week', 'month', 'year'] as const).map(kind => ({
        kind, ...rolled.state.periods[kind], sourceSequence: rolled.state.historySequence,
        snapshotAt: retryAt.toISOString(),
      })),
    ];

    expect(await db.prepare('SELECT data_since FROM usage_users WHERE user_key = ?1')
      .bind(userKey).first()).toBeNull();
    expect((await db.prepare('SELECT period_kind, period_start FROM usage_periods WHERE user_key = ?1')
      .bind(userKey).all()).results).toEqual([]);

    try {
      await db.exec("CREATE TRIGGER reject_first_live_history BEFORE INSERT ON usage_periods WHEN NEW.period_kind = 'month' AND NEW.period_start = '2027-08' BEGIN SELECT RAISE(ABORT, 'history write refused'); END");
      await expect(writeUsageHistory(db, email, snapshots)).rejects.toThrow();
      expect(await db.prepare('SELECT data_since FROM usage_users WHERE user_key = ?1')
        .bind(userKey).first()).toBeNull();
      expect((await db.prepare('SELECT period_kind, period_start FROM usage_periods WHERE user_key = ?1')
        .bind(userKey).all()).results).toEqual([]);
    } finally {
      await db.exec('DROP TRIGGER IF EXISTS reject_first_live_history');
    }

    expect(await writeUsageHistory(db, email, snapshots)).toEqual({ userKey, acknowledged: true });
    expect(await db.prepare('SELECT email, account_status, data_since FROM usage_users WHERE user_key = ?1')
      .bind(userKey).first()).toEqual({ email, account_status: 'active', data_since: closedAt.toISOString() });
    const committed = await db.prepare(`SELECT period_kind, period_start, runtime_seconds, session_count, updated_at
      FROM usage_periods WHERE user_key = ?1 ORDER BY period_kind, period_start`).bind(userKey).all();
    expect(committed.results).toEqual([
      { period_kind: 'day', period_start: '2027-07-31', runtime_seconds: 60, session_count: 1, updated_at: closedAt.toISOString() },
      { period_kind: 'day', period_start: '2027-08-01', runtime_seconds: 30, session_count: 1, updated_at: retryAt.toISOString() },
      { period_kind: 'month', period_start: '2027-07', runtime_seconds: 60, session_count: 1, updated_at: closedAt.toISOString() },
      { period_kind: 'month', period_start: '2027-08', runtime_seconds: 30, session_count: 1, updated_at: retryAt.toISOString() },
      { period_kind: 'week', period_start: '2027-07-26', runtime_seconds: 90, session_count: 1, updated_at: retryAt.toISOString() },
      { period_kind: 'year', period_start: '2027', runtime_seconds: 90, session_count: 1, updated_at: retryAt.toISOString() },
    ]);

    const laterAt = new Date('2027-08-01T00:06:00.000Z');
    const later = applyPositiveDelta(rolled.state, sessionHash, 15, laterAt,
      new Set([...live.markerKeys, ...rolled.markerKeys]));
    const current: HistoryOutboxEntry[] = (['day', 'week', 'month', 'year'] as const).map(kind => ({
      kind, ...later.state.periods[kind], sourceSequence: later.state.historySequence,
      snapshotAt: laterAt.toISOString(),
    }));
    expect(await writeUsageHistory(db, email, current)).toEqual({ userKey, acknowledged: true });
    expect(await db.prepare('SELECT email, account_status, data_since FROM usage_users WHERE user_key = ?1')
      .bind(userKey).first()).toEqual({ email, account_status: 'active', data_since: closedAt.toISOString() });
    const updated = await db.prepare(`SELECT period_kind, period_start, runtime_seconds, session_count, updated_at
      FROM usage_periods WHERE user_key = ?1 ORDER BY period_kind, period_start`).bind(userKey).all();
    expect(updated.results).toEqual([
      { period_kind: 'day', period_start: '2027-07-31', runtime_seconds: 60, session_count: 1, updated_at: closedAt.toISOString() },
      { period_kind: 'day', period_start: '2027-08-01', runtime_seconds: 45, session_count: 1, updated_at: laterAt.toISOString() },
      { period_kind: 'month', period_start: '2027-07', runtime_seconds: 60, session_count: 1, updated_at: closedAt.toISOString() },
      { period_kind: 'month', period_start: '2027-08', runtime_seconds: 45, session_count: 1, updated_at: laterAt.toISOString() },
      { period_kind: 'week', period_start: '2027-07-26', runtime_seconds: 105, session_count: 1, updated_at: laterAt.toISOString() },
      { period_kind: 'year', period_start: '2027', runtime_seconds: 105, session_count: 1, updated_at: laterAt.toISOString() },
    ]);
  });
});

describe('real historical usage query and due scheduling outcomes', () => {
  it('filters the requested period and paginates equal totals without losing tied owners', async () => {
    const emails = ['alice@example.com', 'bob@example.com', 'carol@example.com'];
    for (const email of emails) {
      await writeUsageHistory(db, email, [
        { kind: 'month', start: '2027-07', runtimeSeconds: 120, sessionCount: 2, sourceSequence: 1, snapshotAt: now.toISOString() },
        { kind: 'month', start: '2027-06', runtimeSeconds: 999, sessionCount: 9, sourceSequence: 1, snapshotAt: now.toISOString() },
      ]);
    }
    const expected = (await Promise.all(emails.map(async email => ({ email, key: await userKeyForEmail(email) }))))
      .sort((a, b) => a.key.localeCompare(b.key));
    const options = { period: 'month' as const, start: '2027-07', sort: 'runtimeSeconds' as const, direction: 'desc' as const, limit: 2 };
    const first = await queryAdminUsageRows(db, options);
    expect(first.map(row => row.email)).toEqual(expected.slice(0, 2).map(row => row.email));
    expect(first.map(row => row.runtimeSeconds)).toEqual([120, 120]);
    const second = await queryAdminUsageRows(db, { ...options, continuation: { lastValue: 120, userKey: first[1].userKey } });
    expect(second.map(row => row.email)).toEqual([expected[2].email]);
    expect(await queryAdminUsageRows(db, { ...options, start: '2027-05' })).toEqual([]);
  });

  it('returns only the configured latest aggregates in chronological order for every period', async () => {
    for (const [kind, limit] of [['day', 14], ['week', 12], ['month', 12], ['year', 5]] as const) {
      const starts = Array.from({ length: limit + 2 }, (_, index) => {
        if (kind === 'year') return String(2000 + index);
        if (kind === 'month') return new Date(Date.UTC(2020, index, 1)).toISOString().slice(0, 7);
        return new Date(Date.UTC(2027, 0, 1 + index * (kind === 'week' ? 7 : 1))).toISOString().slice(0, 10);
      });
      await writeUsageHistory(db, 'series@example.com', starts.map((start, index) => ({
        kind, start, runtimeSeconds: index + 1, sessionCount: 1, sourceSequence: 1, snapshotAt: now.toISOString(),
      })));
      const series = await queryAdminUsageSeries(db, kind, starts.at(-1)!, limit);
      expect(series.map(point => point.start)).toEqual(starts.slice(2));
      expect(series.map(point => point.runtimeSeconds)).toEqual(starts.slice(2).map((_, index) => index + 3));
    }
  });

  it.each([['2027-01-15T09:00:00.000Z', '2026-12'], ['2027-08-15T09:00:00.000Z', '2027-07']])(
    'persists the previous UTC month when a dispatch is due at %s', async (at, month) => {
      const kv = createMockKV();
      kv._set('admin:usage-reports:settings', { enabled: true, recipients: ['ops@example.com'],
        day: 15, hour: 9, timezone: 'UTC', settingsRevision: 7 });
      kv._set('admin:usage-reports:next:7', { settingsRevision: 7, nextDeliveryAt: at });
      await createDueScheduledDispatch({ KV: kv, USAGE_DB: db } as unknown as Env, new Date(at));
      expect((await db.prepare('SELECT report_month, recipient, state, attempt FROM report_deliveries').all()).results)
        .toEqual([{ report_month: month, recipient: 'ops@example.com', state: 'pending', attempt: 0 }]);
      const cursor = await kv.get('admin:usage-reports:next:7', 'json') as { nextDeliveryAt: string };
      expect(cursor.nextDeliveryAt > at).toBe(true);
    },
  );
});

describe('REQ-SUB-028 AC1: daily retention claim', () => {
  it('lets only the winning daily token prune rows', async () => {
    await db.prepare(`INSERT INTO report_deliveries
      (id, delivery_kind, dispatch_id, settings_revision, report_month, recipient, state, attempt, created_at, updated_at)
      VALUES ('old-a', 'scheduled', 'old-a', 1, '2020-01', 'a@example.com', 'accepted', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`).run();
    await runUsageRetention(db, now, 'winner');
    expect(await db.prepare("SELECT id FROM report_deliveries WHERE id = 'old-a'").first()).toBeNull();

    await db.prepare(`INSERT INTO report_deliveries
      (id, delivery_kind, dispatch_id, settings_revision, report_month, recipient, state, attempt, created_at, updated_at)
      VALUES ('old-b', 'scheduled', 'old-b', 1, '2020-01', 'b@example.com', 'accepted', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`).run();
    await runUsageRetention(db, now, 'loser');
    expect(await db.prepare("SELECT id FROM report_deliveries WHERE id = 'old-b'").first()).not.toBeNull();
  });
});

describe('REQ-SUB-028 AC2: retention rollback', () => {
  it('rolls back the daily claim when a prune fails', async () => {
    await db.prepare(`INSERT INTO usage_users (user_key, email, account_status, data_since)
      VALUES ('rollback-user', 'rollback@example.com', 'active', '2020-01-01T00:00:00.000Z')`).run();
    await db.prepare(`INSERT INTO usage_periods
      (user_key, period_kind, period_start, runtime_seconds, session_count, source_sequence, updated_at)
      VALUES ('rollback-user', 'day', '2020-01-01', 60, 1, 1, '2020-01-01T00:00:00.000Z')`).run();
    await db.exec("CREATE TRIGGER reject_report_prune BEFORE DELETE ON report_deliveries BEGIN SELECT RAISE(ABORT, 'prune failed'); END");
    await db.prepare(`INSERT INTO report_deliveries
      (id, delivery_kind, dispatch_id, settings_revision, report_month, recipient, state, attempt, created_at, updated_at)
      VALUES ('blocked', 'scheduled', 'blocked', 1, '2020-01', 'blocked@example.com', 'accepted', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`).run();
    await expect(runUsageRetention(db, now, 'failed-attempt')).rejects.toThrow();
    expect(await db.prepare("SELECT claim_token FROM maintenance_claims WHERE task = 'usage-retention'").first()).toBeNull();
    expect(await db.prepare("SELECT user_key FROM usage_periods WHERE user_key = 'rollback-user'").first()).not.toBeNull();

    await db.exec('DROP TRIGGER reject_report_prune');
    await runUsageRetention(db, now, 'retry');
    expect(await db.prepare("SELECT user_key FROM usage_periods WHERE user_key = 'rollback-user'").first()).toBeNull();
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('usage report delivery claims (REQ-SUB-027)', () => {
  it('persists one recipient row per dispatch and keeps test dispatch identities independent', async () => {
    const recipients = ['a@example.com', 'b@example.com', 'a@example.com'];
    await createReportDispatch(db, 'scheduled', 'scheduled:7:2027-07', 7, '2027-07', recipients, now);
    await createReportDispatch(db, 'scheduled', 'scheduled:7:2027-07', 7, '2027-07', recipients, now);
    await createReportDispatch(db, 'test', 'test:request-a', 7, '2027-07', recipients, now);
    await createReportDispatch(db, 'test', 'test:request-a', 7, '2027-07', recipients, now);
    await createReportDispatch(db, 'test', 'test:request-b', 7, '2027-07', ['a@example.com'], now);
    expect((await db.prepare(`SELECT delivery_kind, dispatch_id, recipient, state, attempt
      FROM report_deliveries ORDER BY dispatch_id, recipient`).all()).results).toEqual([
      { delivery_kind: 'scheduled', dispatch_id: 'scheduled:7:2027-07', recipient: 'a@example.com', state: 'pending', attempt: 0 },
      { delivery_kind: 'scheduled', dispatch_id: 'scheduled:7:2027-07', recipient: 'b@example.com', state: 'pending', attempt: 0 },
      { delivery_kind: 'test', dispatch_id: 'test:request-a', recipient: 'a@example.com', state: 'pending', attempt: 0 },
      { delivery_kind: 'test', dispatch_id: 'test:request-a', recipient: 'b@example.com', state: 'pending', attempt: 0 },
      { delivery_kind: 'test', dispatch_id: 'test:request-b', recipient: 'a@example.com', state: 'pending', attempt: 0 },
    ]);
  });

  it('scheduled recovery sends failed, expired and test rows independently of request work while respecting leases and attempts', async () => {
    await insertDelivery('pending', 'pending', 0);
    await insertDelivery('failed', 'failed', 1);
    await insertDelivery('expired', 'sending', 1, '2027-07-31T23:59:59.000Z');
    await insertDelivery('active', 'sending', 1, '2027-08-01T00:00:01.000Z');
    await insertDelivery('exhausted', 'failed', 3);
    await createReportDispatch(db, 'test', 'test:abandoned-request', 7, '2027-07', ['test@example.com'], now);
    const messages: Array<{ to: string[]; idempotencyKey: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      messages.push({ to: JSON.parse(String(init?.body)).to,
        idempotencyKey: new Headers(init?.headers).get('Idempotency-Key') });
      return new Response('{}', { status: 200 });
    }));
    // No route, executionCtx or waitUntil: the scheduler itself must recover old rows.
    const kv = createMockKV();
    await runUsageReportScheduler({ KV: kv, USAGE_DB: db, RESEND_API_KEY: 'test-email-key' } as unknown as Env, now);
    expect(messages.sort((a, b) => a.to[0].localeCompare(b.to[0]))).toEqual([
      { to: ['expired@example.com'], idempotencyKey: 'usage-report:1:2027-07:expired@example.com' },
      { to: ['failed@example.com'], idempotencyKey: 'usage-report:1:2027-07:failed@example.com' },
      { to: ['pending@example.com'], idempotencyKey: 'usage-report:1:2027-07:pending@example.com' },
      { to: ['test@example.com'], idempotencyKey: 'usage-report-test:test:abandoned-request:test@example.com' },
    ]);
    expect((await db.prepare(`SELECT recipient, state, attempt, claim_token, lease_expires_at
      FROM report_deliveries ORDER BY recipient`).all()).results).toEqual([
      { recipient: 'active@example.com', state: 'sending', attempt: 1, claim_token: 'old-token', lease_expires_at: '2027-08-01T00:00:01.000Z' },
      { recipient: 'exhausted@example.com', state: 'failed', attempt: 3, claim_token: null, lease_expires_at: null },
      { recipient: 'expired@example.com', state: 'accepted', attempt: 2, claim_token: null, lease_expires_at: null },
      { recipient: 'failed@example.com', state: 'accepted', attempt: 2, claim_token: null, lease_expires_at: null },
      { recipient: 'pending@example.com', state: 'accepted', attempt: 1, claim_token: null, lease_expires_at: null },
      { recipient: 'test@example.com', state: 'accepted', attempt: 1, claim_token: null, lease_expires_at: null },
    ]);
  });
  it('claims pending, failed, and expired rows but not an active lease or exhausted row', async () => {
    await insertDelivery('pending', 'pending', 0);
    await insertDelivery('failed', 'failed', 1);
    await insertDelivery('expired', 'sending', 1, '2027-07-31T23:59:59.000Z');
    await insertDelivery('active', 'sending', 1, '2027-08-01T00:00:01.000Z');
    await insertDelivery('exhausted', 'failed', 3);

    for (const id of ['pending', 'failed', 'expired']) {
      const row = await claimReportDelivery(db, id, now, `claim-${id}`);
      expect(row?.state).toBe('sending');
      expect(row?.claim_token).toBe(`claim-${id}`);
      expect(await db.prepare('SELECT lease_expires_at FROM report_deliveries WHERE id = ?1').bind(id).first())
        .toEqual({ lease_expires_at: '2027-08-01T00:05:00.000Z' });
    }
    expect(await claimReportDelivery(db, 'active', now, 'new-token')).toBeNull();
    expect(await claimReportDelivery(db, 'exhausted', now, 'new-token')).toBeNull();

    const rows = await db.prepare('SELECT id, attempt FROM report_deliveries ORDER BY id').all<{ id: string; attempt: number }>();
    expect(Object.fromEntries(rows.results.map((row) => [row.id, row.attempt]))).toEqual({
      active: 1, exhausted: 3, expired: 2, failed: 2, pending: 1,
    });
  });

  it('completes only the active token and preserves state after a stale token', async () => {
    await insertDelivery('delivery', 'pending', 0);
    await claimReportDelivery(db, 'delivery', now, 'active-token');

    expect(await completeReportDelivery(db, 'delivery', 'stale-token', 'accepted', now)).toBe(false);
    expect(await completeReportDelivery(db, 'delivery', 'active-token', 'provider_unavailable', now)).toBe(true);

    const row = await db.prepare('SELECT state, reason, claim_token, lease_expires_at FROM report_deliveries WHERE id = ?1')
      .bind('delivery').first<{ state: string; reason: string; claim_token: string | null; lease_expires_at: string | null }>();
    expect(row).toEqual({ state: 'failed', reason: 'provider_unavailable', claim_token: null, lease_expires_at: null });
  });
});
