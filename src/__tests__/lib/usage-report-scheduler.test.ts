import { describe, expect, it, vi } from 'vitest';
import { createDueScheduledDispatch, createReportDispatch, retentionCutoffs, runUsageRetention } from '../../lib/usage-report-scheduler';

describe('usage report scheduling recovery (REQ-SUB-027)', () => {
  it('recreates a missing revision cursor for the next configured delivery', async () => {
    const puts: unknown[][] = [];
    const env = {
      KV: {
        get: vi.fn(async (key: string) => key.endsWith(':settings') ? {
          enabled: true, recipients: ['ops@example.com'], day: 15, hour: 9,
          timezone: 'UTC', settingsRevision: 7,
        } : null),
        put: vi.fn(async (...args: unknown[]) => { puts.push(args); }),
      },
      USAGE_DB: { batch: vi.fn() },
    };

    await createDueScheduledDispatch(env as unknown as Env, new Date('2027-08-01T00:00:00.000Z'));

    expect(env.USAGE_DB.batch).not.toHaveBeenCalled();
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('admin:usage-reports:next:7');
    expect(JSON.parse(String(puts[0][1]))).toMatchObject({
      settingsRevision: 7,
      nextDeliveryAt: '2027-08-15T09:00:00.000Z',
    });
  });
});

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

  it('starts ISO weeks on Monday for non-Sunday dates', () => {
    expect(retentionCutoffs(new Date('2027-08-16T12:00:00.000Z')).week).toBe('2026-06-29');
  });

  it('skips empty dispatches and batches one row per recipient', async () => {
    const db = {
      prepare: vi.fn((sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) })),
      batch: vi.fn(async () => []),
    };
    await createReportDispatch(db as unknown as D1Database, 'test', 'test:req', 2, '2027-07', [], new Date('2027-08-01T00:00:00Z'));
    expect(db.batch).not.toHaveBeenCalled();
    await createReportDispatch(db as unknown as D1Database, 'test', 'test:req', 2, '2027-07', ['a@example.com', 'b@example.com'], new Date('2027-08-01T00:00:00Z'));
    expect(db.batch).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ values: expect.arrayContaining(['a@example.com']) })]));
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
