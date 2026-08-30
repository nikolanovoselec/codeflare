import { describe, expect, it, vi } from 'vitest';
import { userKeyForEmail, writeUsageHistory } from '../../lib/admin-usage';

function fakeDb(finalRows: unknown[] = []) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...values: unknown[]) => {
        const statement = { sql, values };
        statements.push(statement);
        return statement;
      },
    })),
    batch: vi.fn(async (batch: unknown[]) => batch.map((_, index) => ({
      success: true,
      results: index === batch.length - 1 ? finalRows : [],
    }))),
  };
  return { db: db as unknown as D1Database, statements, batch: db.batch };
}

describe('historical usage SQL owner (REQ-SUB-025)', () => {
  it('derives one stable domain-separated user key without exposing identity', async () => {
    const key = await userKeyForEmail(' Alice@Example.com ');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(await userKeyForEmail('alice@example.com'));
    expect(key).not.toContain('alice');
    expect(key).not.toContain('codeflare-alice');
  });

  it('batches active-owner creation and sequence-guarded absolute period upserts', async () => {
    const email = 'alice@example.com';
    const userKey = await userKeyForEmail(email);
    const snapshots = [
      { kind: 'day' as const, start: '2026-08-30', runtimeSeconds: 120, sessionCount: 2, sourceSequence: 7, snapshotAt: '2026-08-30T12:00:00.000Z' },
      { kind: 'month' as const, start: '2026-08', runtimeSeconds: 500, sessionCount: 4, sourceSequence: 7, snapshotAt: '2026-08-30T12:00:00.000Z' },
    ];
    const fake = fakeDb(snapshots.map((snapshot) => ({
      period_kind: snapshot.kind,
      period_start: snapshot.start,
      source_sequence: snapshot.sourceSequence,
      account_status: 'active',
    })));

    const result = await writeUsageHistory(fake.db, email, snapshots);
    expect(result.acknowledged).toBe(true);
    expect(result.userKey).toBe(userKey);
    expect(fake.batch).toHaveBeenCalledOnce();
    expect(fake.statements[0].sql).toContain('ON CONFLICT(user_key) DO NOTHING');
    const upserts = fake.statements.filter((statement) => statement.sql.includes('INSERT INTO usage_periods'));
    expect(upserts).toHaveLength(2);
    expect(upserts.every((statement) => statement.sql.includes("account_status = 'active'"))).toBe(true);
    expect(upserts.every((statement) => statement.sql.includes('excluded.source_sequence > usage_periods.source_sequence'))).toBe(true);
    expect(fake.statements.at(-1).sql).toContain('source_sequence');
  });

  it('does not acknowledge a successful guarded no-op without equal/newer or deleted-owner evidence', async () => {
    const snapshot = {
      kind: 'day' as const,
      start: '2026-08-30',
      runtimeSeconds: 120,
      sessionCount: 1,
      sourceSequence: 9,
      snapshotAt: '2026-08-30T12:00:00.000Z',
    };
    const stale = fakeDb([{ period_kind: 'day', period_start: '2026-08-30', source_sequence: 8, account_status: 'active' }]);
    expect((await writeUsageHistory(stale.db, 'alice@example.com', [snapshot])).acknowledged).toBe(false);

    const deleted = fakeDb([{ period_kind: 'day', period_start: '2026-08-30', source_sequence: null, account_status: 'deleted' }]);
    expect((await writeUsageHistory(deleted.db, 'alice@example.com', [snapshot])).acknowledged).toBe(true);
  });
});
