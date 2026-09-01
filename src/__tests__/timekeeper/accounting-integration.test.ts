import { describe, expect, it, vi } from 'vitest';
import { Timekeeper } from '../../timekeeper/index';
import type { AccountingStateV2 } from '../../timekeeper/accounting';

function createHarness(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const puts: Array<[string, unknown]> = [];
  const deletes: string[] = [];
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      puts.push([key, value]);
      values.set(key, value);
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        deletes.push(key);
        values.delete(key);
      }
    }),
    transaction: vi.fn(async (callback: (txn: typeof storage) => Promise<void>) => callback(storage)),
    getAlarm: vi.fn(async () => null),
    setAlarm: vi.fn(async () => undefined),
  };
  const kv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
  const ctx = {
    storage,
    waitUntil: vi.fn(),
    blockConcurrencyWhile: vi.fn(async (callback: () => Promise<void>) => callback()),
  } as any;
  const timekeeper = new Timekeeper(ctx, { KV: kv } as any);
  return { timekeeper, storage, values, puts, deletes, kv };
}

function ping(sessionId: string, totalSeconds: number): Request {
  return new Request('http://timekeeper/ping', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bucketName: 'codeflare-alice',
      sessionId,
      totalSeconds,
      email: 'alice@example.com',
    }),
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Timekeeper AccountingStateV2 integration (REQ-SUB-025)', () => {
  it('migrates legacy accounting keys atomically and removes them only after the v2 write', async () => {
    const harness = createHarness({
      pendingSeconds: 45,
      sessionTotals: JSON.stringify({ 'legacy-session': 90 }),
      lastFlushedMonthlyTotal: 120,
    });
    await settle();

    expect(harness.storage.transaction).toHaveBeenCalledOnce();
    const state = harness.values.get('accountingState:v2') as AccountingStateV2;
    expect(state).toMatchObject({ version: 2, pendingSeconds: 45, lastFlushedMonthlyTotal: 120 });
    expect(Object.keys(state.sessionTotals)[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.deletes).toEqual(expect.arrayContaining([
      'pendingSeconds', 'sessionTotals', 'lastFlushedMonthlyTotal',
    ]));
  });

  it('uses one accounting-state write and zero KV reads for repeated positive pings', async () => {
    const harness = createHarness();
    await settle();
    await harness.timekeeper.fetch(ping('private-session', 60));
    harness.puts.length = 0;
    harness.kv.get.mockClear();
    harness.storage.get.mockClear();

    const response = await harness.timekeeper.fetch(ping('private-session', 120));
    expect(response.status).toBe(200);
    expect(harness.puts.filter(([key]) => key === 'accountingState:v2')).toHaveLength(1);
    expect(harness.puts.some(([key]) => key === 'pendingSeconds' || key === 'sessionTotals')).toBe(false);
    expect(harness.kv.get).not.toHaveBeenCalled();
    expect(harness.storage.get).not.toHaveBeenCalledWith(expect.stringContaining('historyMarker:'));
    const state = harness.values.get('accountingState:v2') as AccountingStateV2;
    expect(JSON.stringify(state)).not.toContain('private-session');
    expect(Object.values(state.periods).every((period) => period.runtimeSeconds === 120)).toBe(true);
  });
});
