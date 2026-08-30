import { getIsoWeekStart, getUtcDateString, getUtcMonthString } from '../lib/kv-keys';

export type PeriodKind = 'day' | 'week' | 'month' | 'year';

interface PeriodAccumulator {
  start: string;
  runtimeSeconds: number;
  sessionCount: number;
}

export interface AccountingStateV2 {
  version: 2;
  pendingSeconds: number;
  sessionTotals: Record<string, number>;
  quotaMonth: string;
  lastFlushedMonthlyTotal: number;
  historySequence: number;
  periods: Record<PeriodKind, PeriodAccumulator>;
  d1Retry: { attempt: number; nextAttemptAt?: string };
  markerCleanup?: { kind: PeriodKind; start: string; lastDeletedKey?: string };
}

export interface HistoryOutboxEntry extends PeriodAccumulator {
  kind: PeriodKind;
  sourceSequence: number;
  snapshotAt: string;
}

interface LegacyAccountingState {
  pendingSeconds: number;
  sessionTotals: Record<string, number>;
  lastFlushedMonthlyTotal: number;
}

const PERIOD_KINDS: PeriodKind[] = ['day', 'week', 'month', 'year'];

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashSessionId(sessionId: string): Promise<string> {
  return sha256Hex(`codeflare-history-session-v1\0${sessionId}`);
}

export function periodStarts(now: Date): Record<PeriodKind, string> {
  return {
    day: getUtcDateString(now),
    week: getIsoWeekStart(now),
    month: getUtcMonthString(now),
    year: String(now.getUTCFullYear()),
  };
}

export async function createAccountingState(now: Date, legacy: LegacyAccountingState): Promise<AccountingStateV2> {
  const starts = periodStarts(now);
  const hashedTotals = await Promise.all(Object.entries(legacy.sessionTotals).slice(-30).map(async ([sessionId, total]) => [
    await hashSessionId(sessionId),
    total,
  ] as const));
  return {
    version: 2,
    pendingSeconds: legacy.pendingSeconds,
    sessionTotals: Object.fromEntries(hashedTotals),
    quotaMonth: starts.month,
    lastFlushedMonthlyTotal: legacy.lastFlushedMonthlyTotal,
    historySequence: 0,
    periods: {
      day: { start: starts.day, runtimeSeconds: 0, sessionCount: 0 },
      week: { start: starts.week, runtimeSeconds: 0, sessionCount: 0 },
      month: { start: starts.month, runtimeSeconds: 0, sessionCount: 0 },
      year: { start: starts.year, runtimeSeconds: 0, sessionCount: 0 },
    },
    d1Retry: { attempt: 0 },
  };
}

function markerKey(kind: PeriodKind, start: string, sessionHash: string): string {
  return `historyMarker:${kind}:${start}:${sessionHash}`;
}

export function markerKeysFor(now: Date, sessionHash: string): string[] {
  const starts = periodStarts(now);
  return PERIOD_KINDS.map((kind) => markerKey(kind, starts[kind], sessionHash));
}

export function outboxKey(entry: Pick<HistoryOutboxEntry, 'kind' | 'start'>): string {
  return `historyOutbox:${entry.kind}:${entry.start}`;
}

export function applyPositiveDelta(
  previous: AccountingStateV2,
  sessionHash: string,
  delta: number,
  now: Date,
  knownMarkers: ReadonlySet<string>,
): { state: AccountingStateV2; markerKeys: string[]; outbox: HistoryOutboxEntry[] } {
  if (!Number.isFinite(delta) || delta <= 0) return { state: previous, markerKeys: [], outbox: [] };
  const starts = periodStarts(now);
  const sourceSequence = previous.historySequence + 1;
  const snapshotAt = now.toISOString();
  const markerKeys: string[] = [];
  const outbox: HistoryOutboxEntry[] = [];
  const periods = {} as Record<PeriodKind, PeriodAccumulator>;

  for (const kind of PERIOD_KINDS) {
    const prior = previous.periods[kind];
    if (prior.start !== starts[kind]) {
      outbox.push({ kind, ...prior, sourceSequence, snapshotAt });
    }
    const active = prior.start === starts[kind]
      ? prior
      : { start: starts[kind], runtimeSeconds: 0, sessionCount: 0 };
    const key = markerKey(kind, active.start, sessionHash);
    const distinct = knownMarkers.has(key) ? 0 : 1;
    if (distinct) markerKeys.push(key);
    periods[kind] = {
      ...active,
      runtimeSeconds: active.runtimeSeconds + delta,
      sessionCount: active.sessionCount + distinct,
    };
  }

  const sessionTotals = { ...previous.sessionTotals };
  return {
    state: {
      ...previous,
      pendingSeconds: previous.pendingSeconds + delta,
      sessionTotals,
      quotaMonth: starts.month,
      ...(previous.quotaMonth !== starts.month && { lastFlushedMonthlyTotal: 0 }),
      historySequence: sourceSequence,
      periods,
    },
    markerKeys,
    outbox,
  };
}

export async function historyPhase(userKey: string): Promise<{ phase: number; offset: number; d1Slot: number }> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`codeflare-history-phase-v1\0${userKey}`),
  ));
  const first = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  const phase = first % 900;
  return { phase, offset: phase % 300, d1Slot: Math.floor(phase / 300) };
}

export function shouldRunD1(nowEpochSeconds: number, offset: number, d1Slot: number): boolean {
  const tick = Math.floor((nowEpochSeconds - offset) / 300);
  return ((tick % 3) + 3) % 3 === d1Slot;
}

export function nextRegularAlarm(nowEpochSeconds: number, offset: number): number {
  const tick = Math.floor((nowEpochSeconds - offset) / 300) + 1;
  return (offset + tick * 300) * 1_000;
}
