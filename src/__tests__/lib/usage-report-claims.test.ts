import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimReportDelivery, completeReportDelivery } from '../../lib/usage-report-scheduler';

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
  await db.exec(`CREATE TABLE IF NOT EXISTS report_deliveries (
    id TEXT PRIMARY KEY, delivery_kind TEXT NOT NULL, dispatch_id TEXT NOT NULL,
    settings_revision INTEGER NOT NULL, report_month TEXT NOT NULL, recipient TEXT NOT NULL,
    state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, claim_token TEXT,
    lease_expires_at TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    accepted_at TEXT
  ); DELETE FROM report_deliveries;`);
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
