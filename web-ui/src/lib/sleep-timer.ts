import type { SleepAfterOption } from '../types';

export interface SleepTimerInfo {
  remainingMs: number;
  bucket: string;
  severity: 'warning' | 'critical';
}

const SLEEP_AFTER_MS: Record<string, number> = {
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
};

const DEFAULT_MS = 1_800_000; // 30m

export function parseSleepAfterMs(opt: SleepAfterOption | undefined): number {
  if (!opt) return DEFAULT_MS;
  return SLEEP_AFTER_MS[opt] ?? DEFAULT_MS;
}

export function getSleepTimerInfo(
  lastActiveAt: string | undefined,
  sleepAfter: SleepAfterOption | undefined,
): SleepTimerInfo | null {
  if (!lastActiveAt || !sleepAfter) return null;

  const elapsed = Date.now() - new Date(lastActiveAt).getTime();
  const totalMs = parseSleepAfterMs(sleepAfter);
  const remainingMs = totalMs - elapsed;

  if (remainingMs <= 0 || remainingMs >= 600_000) return null;

  return {
    remainingMs,
    bucket: remainingMs < 300_000 ? '< 5 min' : '< 10 min',
    severity: remainingMs < 300_000 ? 'critical' : 'warning',
  };
}
