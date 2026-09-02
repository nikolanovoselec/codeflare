// @ts-expect-error Provided by the Cloudflare Vitest Workers runtime.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { reactivateUsageUser, tombstoneUsageUser, userKeyForEmail, writeUsageHistory } from '../../lib/admin-usage';
import { claimReportDelivery, completeReportDelivery, runUsageRetention } from '../../lib/usage-report-scheduler';

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
  await db.exec('CREATE TABLE IF NOT EXISTS maintenance_claims (task TEXT NOT NULL, utc_date TEXT NOT NULL, claim_token TEXT NOT NULL, claimed_at TEXT NOT NULL, PRIMARY KEY (task, utc_date))');
  await db.exec('DROP TRIGGER IF EXISTS reject_report_prune');
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

describe('usage report delivery claims (REQ-SUB-027)', () => {
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
