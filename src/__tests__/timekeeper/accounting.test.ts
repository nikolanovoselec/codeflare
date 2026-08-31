import { describe, expect, it } from 'vitest';
import {
  applyPositiveDelta,
  createAccountingState,
  historyPhase,
  hashSessionId,
  nextRegularAlarm,
  outboxKey,
  periodStarts,
  shouldRunD1,
  type AccountingStateV2,
} from '../../timekeeper/accounting';

function stateAt(iso: string): Promise<AccountingStateV2> {
  return createAccountingState(new Date(iso), {
    pendingSeconds: 0,
    sessionTotals: {},
    lastFlushedMonthlyTotal: 0,
  });
}

describe('AccountingStateV2 (REQ-SUB-025)', () => {
  it('migrates legacy values into one bounded versioned state at the 30-session maximum', async () => {
    const sessionTotals = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`session-${index}`, index * 10]));
    const state = await createAccountingState(new Date('2026-08-30T12:00:00.000Z'), {
      pendingSeconds: 37,
      sessionTotals,
      lastFlushedMonthlyTotal: 500,
    });
    expect(state).toMatchObject({
      version: 2,
      pendingSeconds: 37,
      quotaMonth: '2026-08',
      lastFlushedMonthlyTotal: 500,
      historySequence: 0,
    });
    expect(Object.keys(state.sessionTotals)).toHaveLength(30);
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBeLessThan(4_096);
    expect(Object.keys(state.periods)).toEqual(['day', 'week', 'month', 'year']);
  });

  it('derives canonical UTC day, ISO week, month, and year starts', () => {
    expect(periodStarts(new Date('2027-01-01T00:00:00.000Z'))).toEqual({
      day: '2027-01-01',
      week: '2026-12-28',
      month: '2027-01',
      year: '2027',
    });
  });

  it('hashes session identity without retaining the submitted ID', async () => {
    const digest = await hashSessionId('private-session-id');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('private-session-id');
    expect(await hashSessionId('private-session-id')).toBe(digest);
  });

  it('attributes runtime and one distinct session to every active period', async () => {
    const sessionHash = await hashSessionId('session-a');
    const initial = await stateAt('2026-08-30T12:00:00.000Z');
    const first = applyPositiveDelta(initial, sessionHash, 60, new Date('2026-08-30T12:00:00.000Z'), new Set());
    expect(first.state.pendingSeconds).toBe(60);
    expect(first.state.historySequence).toBe(1);
    expect(Object.values(first.state.periods)).toEqual([
      expect.objectContaining({ runtimeSeconds: 60, sessionCount: 1 }),
      expect.objectContaining({ runtimeSeconds: 60, sessionCount: 1 }),
      expect.objectContaining({ runtimeSeconds: 60, sessionCount: 1 }),
      expect.objectContaining({ runtimeSeconds: 60, sessionCount: 1 }),
    ]);
    expect(first.markerKeys).toHaveLength(4);

    const repeated = applyPositiveDelta(first.state, sessionHash, 30, new Date('2026-08-30T12:01:00.000Z'), new Set(first.markerKeys));
    expect(Object.values(repeated.state.periods).every((period) => period.sessionCount === 1)).toBe(true);
    expect(Object.values(repeated.state.periods).every((period) => period.runtimeSeconds === 90)).toBe(true);
    expect(repeated.markerKeys).toEqual([]);
  });

  it('queues absolute closed-period snapshots before applying a boundary delta', async () => {
    const sessionHash = await hashSessionId('boundary-session');
    const initial = applyPositiveDelta(
      await stateAt('2026-12-31T23:59:00.000Z'),
      sessionHash,
      60,
      new Date('2026-12-31T23:59:00.000Z'),
      new Set(),
    );
    const rollover = applyPositiveDelta(
      initial.state,
      sessionHash,
      30,
      new Date('2027-01-01T00:00:00.000Z'),
      new Set(initial.markerKeys),
    );
    expect(rollover.outbox.map((entry) => entry.kind)).toEqual(['day', 'month', 'year']);
    expect(outboxKey(rollover.outbox[0])).toBe('historyOutbox:day:2026-12-31');
    expect(rollover.outbox.every((entry) => entry.runtimeSeconds === 60 && entry.sessionCount === 1)).toBe(true);
    expect(rollover.state.periods.day).toMatchObject({ start: '2027-01-01', runtimeSeconds: 30, sessionCount: 1 });
    expect(rollover.state.periods.week.start).toBe('2026-12-28');
    expect(rollover.state.markerCleanup).toEqual({ kind: 'day', start: '2026-12-31' });
  });

  it('derives a stable 15-minute D1 phase and five-minute offset', async () => {
    const phase = await historyPhase('user-key');
    expect(phase.phase).toBeGreaterThanOrEqual(0);
    expect(phase.phase).toBeLessThan(900);
    expect(phase.offset).toBe(phase.phase % 300);
    expect(phase.d1Slot).toBe(Math.floor(phase.phase / 300));
    expect(await historyPhase('user-key')).toEqual(phase);
    const selectedTick = phase.offset + phase.d1Slot * 300;
    expect(shouldRunD1(selectedTick, phase.offset, phase.d1Slot)).toBe(true);
    expect(shouldRunD1(selectedTick + 300, phase.offset, phase.d1Slot)).toBe(false);
    expect(nextRegularAlarm(selectedTick, phase.offset)).toBe((selectedTick + 300) * 1_000);
  });
});
