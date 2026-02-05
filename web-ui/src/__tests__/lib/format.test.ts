import { describe, it, expect } from 'vitest';
import { formatUptime } from '../../lib/format';

describe('formatUptime()', () => {
  function createDateMinutesAgo(minutes: number): string {
    const now = Date.now();
    return new Date(now - minutes * 60000).toISOString();
  }

  it('returns 0m for just-created sessions', () => {
    const result = formatUptime(createDateMinutesAgo(0));
    expect(result).toBe('0m');
  });

  it('returns minutes for durations under 1 hour', () => {
    expect(formatUptime(createDateMinutesAgo(30))).toBe('30m');
  });

  it('returns 59m just before the hour boundary', () => {
    expect(formatUptime(createDateMinutesAgo(59))).toBe('59m');
  });

  it('returns hours for durations of 1+ hours', () => {
    expect(formatUptime(createDateMinutesAgo(60))).toBe('1h');
  });

  it('returns 2h for 120 minutes', () => {
    expect(formatUptime(createDateMinutesAgo(120))).toBe('2h');
  });

  it('returns 23h just before the day boundary', () => {
    expect(formatUptime(createDateMinutesAgo(23 * 60))).toBe('23h');
  });

  it('returns days for durations of 24+ hours', () => {
    expect(formatUptime(createDateMinutesAgo(24 * 60))).toBe('1d');
  });

  it('returns 3d for 4320 minutes (3 days)', () => {
    expect(formatUptime(createDateMinutesAgo(4320))).toBe('3d');
  });

  it('handles boundary: exactly 60 minutes -> 1h', () => {
    expect(formatUptime(createDateMinutesAgo(60))).toBe('1h');
  });

  it('handles boundary: exactly 1440 minutes (24h) -> 1d', () => {
    expect(formatUptime(createDateMinutesAgo(1440))).toBe('1d');
  });
});
