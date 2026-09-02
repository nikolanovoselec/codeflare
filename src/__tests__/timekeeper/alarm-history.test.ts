import { afterEach, describe, expect, it, vi } from 'vitest';
import { Timekeeper } from '../../timekeeper/index';
import { historyPhase } from '../../timekeeper/accounting';
import { userKeyForEmail } from '../../lib/admin-usage';

function fakeD1(options: { fail?: boolean } = {}) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({ bind: (...values: unknown[]) => {
      const statement = { sql, values };
      statements.push(statement);
      return statement;
    } })),
    batch: vi.fn(async (batch: Array<{ sql: string; values: unknown[] }>) => {
      if (options.fail) throw new Error('D1 unavailable');
      return batch.map((statement, index) => {
        if (index !== batch.length - 1) return { success: true, results: [] };
        const rows = [];
        for (let offset = 1; offset < statement.values.length; offset += 2) {
          rows.push({
            account_status: 'active',
            period_kind: statement.values[offset],
            period_start: statement.values[offset + 1],
            source_sequence: Number.MAX_SAFE_INTEGER,
          });
        }
        return { success: true, results: rows };
      });
    }),
  };
  return { db: db as unknown as D1Database, batch: db.batch, statements };
}

function createHarness(db: D1Database) {
  const values = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string | string[]) => {
      if (Array.isArray(key)) return new Map(key.filter((item) => values.has(item)).map((item) => [item, values.get(item)]));
      return values.get(key);
    }),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    }),
    list: vi.fn(async (options: { prefix?: string }) => new Map(
      [...values.entries()].filter(([key]) => key.startsWith(options.prefix ?? '')),
    )),
    transaction: vi.fn(async (callback: (txn: typeof storage) => Promise<void>) => callback(storage)),
    getAlarm: vi.fn(async () => null),
    setAlarm: vi.fn(async () => undefined),
  };
  const kv = {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
  };
  const ctx = {
    storage,
    waitUntil: vi.fn(),
    blockConcurrencyWhile: vi.fn(async (callback: () => Promise<void>) => callback()),
  } as any;
  return {
    timekeeper: new Timekeeper(ctx, { KV: kv, USAGE_DB: db } as any),
    storage,
    values,
    kv,
  };
}

function ping(totalSeconds: number): Request {
  return new Request('http://timekeeper/ping', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucketName: 'codeflare-alice', sessionId: 'session-a', totalSeconds, email: 'alice@example.com' }),
  });
}

async function selectedD1Time(): Promise<Date> {
  const userKey = await userKeyForEmail('alice@example.com');
  const { offset, d1Slot } = await historyPhase(userKey);
  const seconds = offset + (3_000_000 + d1Slot) * 300;
  return new Date(seconds * 1_000);
}

describe('Timekeeper single-alarm history duty (REQ-SUB-025)', () => {
  afterEach(() => vi.useRealTimers());

  it('flushes KV and absolute D1 periods independently on the selected phase', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(await selectedD1Time());
    const d1 = fakeD1();
    const harness = createHarness(d1.db);
    await harness.timekeeper.fetch(ping(60));
    harness.kv.put.mockClear();

    await harness.timekeeper.alarm();

    expect(harness.kv.put).toHaveBeenCalledOnce();
    expect(d1.batch).toHaveBeenCalledOnce();
    const state = harness.values.get('accountingState:v2') as { pendingSeconds: number; d1Retry: { attempt: number } };
    expect(state.pendingSeconds).toBe(0);
    expect(state.d1Retry.attempt).toBe(0);
    expect(harness.storage.setAlarm).toHaveBeenCalledWith(expect.any(Number));
  });

  it('keeps KV quota progress when D1 fails and persists bounded retry state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(await selectedD1Time());
    const d1 = fakeD1({ fail: true });
    const harness = createHarness(d1.db);
    await harness.timekeeper.fetch(ping(60));

    await harness.timekeeper.alarm();

    expect(harness.kv.put).toHaveBeenCalledOnce();
    const state = harness.values.get('accountingState:v2') as { pendingSeconds: number; d1Retry: { attempt: number; nextAttemptAt?: string } };
    expect(state.pendingSeconds).toBe(0);
    expect(state.d1Retry.attempt).toBe(1);
    expect(state.d1Retry.nextAttemptAt).toBeDefined();
  });

  it('keeps KV pending state when KV fails even if D1 succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(await selectedD1Time());
    const d1 = fakeD1();
    const harness = createHarness(d1.db);
    await harness.timekeeper.fetch(ping(60));
    harness.kv.put.mockRejectedValueOnce(new Error('KV unavailable'));

    await harness.timekeeper.alarm();

    expect(d1.batch).toHaveBeenCalledOnce();
    const state = harness.values.get('accountingState:v2') as { pendingSeconds: number };
    expect(state.pendingSeconds).toBe(60);
  });
});
