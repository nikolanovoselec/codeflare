import { describe, expect, it, vi } from 'vitest';
import { reactivateUsageUser, userKeyForEmail, writeUsageHistory } from '../../lib/admin-usage';
import { setLogLevel } from '../../lib/logger';

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
    expect(fake.statements.at(-1)!.sql).toContain('source_sequence');
  });

  it('logs bounded D1 metrics without user or secret material (REQ-OPS-057 AC5)', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setLogLevel('info');
    try {
      const snapshot = { kind: 'day' as const, start: '2026-08-30', runtimeSeconds: 120, sessionCount: 2, sourceSequence: 7, snapshotAt: '2026-08-30T12:00:00.000Z' };
      const measured = fakeDb([{ period_kind: 'day', period_start: '2026-08-30', source_sequence: 7, account_status: 'active' }]);
      measured.batch.mockResolvedValueOnce([
        { success: true, meta: { rows_read: 1, rows_written: 1, duration: 2 } },
        { success: true, meta: { rows_read: 3, rows_written: 2, duration: 4 } },
        { success: true, results: [{ period_kind: 'day', period_start: '2026-08-30', source_sequence: 7, account_status: 'active' }], meta: { rows_read: 2, rows_written: 0, duration: 1 } },
      ] as never);

      await writeUsageHistory(measured.db, 'private@example.com', [snapshot]);

      const entry = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as { data: Record<string, unknown> };
      expect(entry.data).toMatchObject({ rowsRead: 6, rowsWritten: 3, sqlDurationMs: 7, snapshotCount: 1 });
      expect(entry.data.backlogSeconds).toEqual(expect.any(Number));
      expect(JSON.stringify(entry)).not.toContain('private@example.com');
      expect(JSON.stringify(entry)).not.toContain('runtimeSeconds');
    } finally {
      setLogLevel('silent');
      output.mockRestore();
    }
  });

  it('reactivates only the same stable owner and keeps prior periods untouched', async () => {
    const run = vi.fn(async () => ({ success: true }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...values: unknown[]) => ({ run, sql, values })),
    }));
    await reactivateUsageUser({ prepare } as unknown as D1Database, ' Alice@Example.com ');
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("account_status = 'active'"));
    expect(prepare).toHaveBeenCalledWith(expect.not.stringContaining('usage_periods'));
    expect(run).toHaveBeenCalledOnce();
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
