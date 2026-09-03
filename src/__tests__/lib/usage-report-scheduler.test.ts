import { describe, expect, it, vi } from 'vitest';
import { createDueScheduledDispatch, createReportDispatch, retentionCutoffs } from '../../lib/usage-report-scheduler';
import type { Env as AppEnv } from '../../types';

describe('usage report scheduling recovery (REQ-SUB-027)', () => {
  it('recreates the current revision cursor without consuming a stale revision', async () => {
    const puts: unknown[][] = [];
    const env = {
      KV: {
        get: vi.fn(async (key: string) => key.endsWith(':settings') ? {
          enabled: true, recipients: ['ops@example.com'], day: 15, hour: 9,
          timezone: 'UTC', settingsRevision: 7,
        } : key === 'admin:usage-reports:next:6' ? {
          settingsRevision: 6,
          nextDeliveryAt: '2027-08-01T00:00:00.000Z',
        } : null),
        put: vi.fn(async (...args: unknown[]) => { puts.push(args); }),
      },
      USAGE_DB: { batch: vi.fn() },
    };

    await createDueScheduledDispatch(env as unknown as AppEnv, new Date('2027-08-01T00:00:00.000Z'));

    expect(env.USAGE_DB.batch).not.toHaveBeenCalled();
    expect(env.KV.get).toHaveBeenCalledWith('admin:usage-reports:next:7', 'json');
    expect(env.KV.get).not.toHaveBeenCalledWith('admin:usage-reports:next:6', 'json');
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('admin:usage-reports:next:7');
    expect(JSON.parse(String(puts[0][1]))).toMatchObject({
      settingsRevision: 7,
      nextDeliveryAt: '2027-08-15T09:00:00.000Z',
    });
  });
});

describe('usage report retention cutoffs (REQ-SUB-026, REQ-SUB-028)', () => {
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

});

describe('usage report dispatch (REQ-SUB-027)', () => {
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
});
