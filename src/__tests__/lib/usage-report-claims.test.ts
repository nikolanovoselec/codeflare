import { describe, expect, it, vi } from 'vitest';
import { claimReportDelivery, completeReportDelivery } from '../../lib/usage-report-scheduler';

describe('usage report delivery claims (REQ-SUB-027)', () => {
  it('claims pending, failed, or lease-expired rows below three attempts', async () => {
    const first = vi.fn().mockResolvedValue({ id: 'delivery', attempt: 2, claim_token: 'new-token' });
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const row = await claimReportDelivery({ prepare } as unknown as D1Database, 'delivery', new Date('2027-08-01T00:00:00Z'), 'new-token');
    expect(row?.attempt).toBe(2);
    const prepareCalls = prepare.mock.calls as unknown as Array<[string]>;
    const bindCalls = bind.mock.calls as unknown as unknown[][];
    expect(prepareCalls[0][0]).toContain("state = 'failed'");
    expect(prepareCalls[0][0]).toContain('attempt < 3');
    expect(bindCalls[0]).toContain('2027-08-01T00:05:00.000Z');
  });

  it('only completes a row when its active claim token matches', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    expect(await completeReportDelivery({ prepare } as unknown as D1Database, 'delivery', 'stale', 'accepted', new Date('2027-08-01T00:00:00Z'))).toBe(false);
    const prepareCalls = prepare.mock.calls as unknown as Array<[string]>;
    const bindCalls = bind.mock.calls as unknown as unknown[][];
    expect(prepareCalls[0][0]).toContain('claim_token = ?2');
    expect(bindCalls[0]).toEqual(['delivery', 'stale', 'accepted', null, '2027-08-01T00:00:00.000Z']);
  });
});
