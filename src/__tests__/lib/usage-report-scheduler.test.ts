import { describe, expect, it, vi } from 'vitest';
import { retentionCutoffs, runUsageRetention } from '../../lib/usage-report-scheduler';

describe('usage report retention transaction (REQ-SUB-026, REQ-SUB-027)', () => {
  it('computes every exact calendar cutoff', () => {
    expect(retentionCutoffs(new Date('2027-08-15T12:00:00.000Z'))).toEqual({
      day: '2026-07-12',
      week: '2026-06-22',
      month: '2022-09',
      year: '2023',
      deleted: '2022-08-01T00:00:00.000Z',
      deliveries: '2022-08-01T00:00:00.000Z',
      claims: '2027-07-11',
    });
  });

  it('uses one token-guarded transactional batch', async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) })),
      batch: vi.fn(async (items: Array<{ sql: string; values: unknown[] }>) => { statements.push(...items); return []; }),
    };
    await runUsageRetention(db as unknown as D1Database, new Date('2027-08-15T12:00:00.000Z'), 'token');
    expect(db.batch).toHaveBeenCalledOnce();
    expect(statements[0].sql).toContain('INSERT OR IGNORE INTO maintenance_claims');
    for (const statement of statements.slice(1)) {
      expect(statement.sql).toContain('claim_token = ?3');
      expect(statement.sql).toContain('EXISTS');
    }
  });

  it('propagates batch failure so winning claim rolls back and retries', async () => {
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn().mockRejectedValue(new Error('prune failed')),
    };
    await expect(runUsageRetention(db as unknown as D1Database, new Date('2027-08-15T12:00:00.000Z'), 'token')).rejects.toThrow('prune failed');
  });
});
