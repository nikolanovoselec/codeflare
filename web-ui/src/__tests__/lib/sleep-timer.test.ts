import { describe, it, expect } from 'vitest';
import { parseSleepAfterMs, getSleepTimerInfo } from '../../lib/sleep-timer';

describe('parseSleepAfterMs', () => {
  it('maps each SleepAfterOption to correct milliseconds', () => {
    expect(parseSleepAfterMs('5m')).toBe(300_000);
    expect(parseSleepAfterMs('15m')).toBe(900_000);
    expect(parseSleepAfterMs('30m')).toBe(1_800_000);
    expect(parseSleepAfterMs('1h')).toBe(3_600_000);
    expect(parseSleepAfterMs('2h')).toBe(7_200_000);
  });

  it('returns default (30m) for undefined', () => {
    expect(parseSleepAfterMs(undefined)).toBe(1_800_000);
  });
});

describe('getSleepTimerInfo', () => {
  const now = Date.now();

  it('returns null when lastActiveAt is undefined', () => {
    expect(getSleepTimerInfo(undefined, '30m')).toBeNull();
  });

  it('returns null when sleepAfter is undefined', () => {
    const lastActiveAt = new Date(now - 25 * 60_000).toISOString();
    expect(getSleepTimerInfo(lastActiveAt, undefined)).toBeNull();
  });

  it('returns null when remaining >= 10 min', () => {
    const lastActiveAt = new Date(now - 10 * 60_000).toISOString(); // 10 min ago, 20 min remaining
    expect(getSleepTimerInfo(lastActiveAt, '30m')).toBeNull();
  });

  it('returns warning severity when remaining is 6 min', () => {
    const lastActiveAt = new Date(now - 24 * 60_000).toISOString(); // 24 min ago, 6 min remaining
    const result = getSleepTimerInfo(lastActiveAt, '30m');
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('warning');
    expect(result!.bucket).toBe('< 10 min');
  });

  it('returns critical severity when remaining is 3 min', () => {
    const lastActiveAt = new Date(now - 27 * 60_000).toISOString(); // 27 min ago, 3 min remaining
    const result = getSleepTimerInfo(lastActiveAt, '30m');
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.bucket).toBe('< 5 min');
  });

  it('returns null when remaining <= 0 (already expired)', () => {
    const lastActiveAt = new Date(now - 35 * 60_000).toISOString(); // 35 min ago
    expect(getSleepTimerInfo(lastActiveAt, '30m')).toBeNull();
  });

  it('works with shorter sleepAfter values', () => {
    const lastActiveAt = new Date(now - 2 * 60_000).toISOString(); // 2 min ago, 3 min remaining
    const result = getSleepTimerInfo(lastActiveAt, '5m');
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.bucket).toBe('< 5 min');
  });

  it('works with longer sleepAfter values', () => {
    const lastActiveAt = new Date(now - 53 * 60_000).toISOString(); // 53 min ago, 7 min remaining
    const result = getSleepTimerInfo(lastActiveAt, '1h');
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('warning');
    expect(result!.bucket).toBe('< 10 min');
  });
});
