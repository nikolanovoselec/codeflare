import { describe, it, expect } from 'vitest';

// Mock the logger to suppress warn output during tests
import { vi } from 'vitest';
vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { parseSleepAfterMs, SLEEP_AFTER_FALLBACK_MS } from '../../container/container-metrics';

describe('parseSleepAfterMs - fail-safe direction', () => {
  it('correctly parses every supported value', () => {
    expect(parseSleepAfterMs('5m')).toBe(5 * 60_000);
    expect(parseSleepAfterMs('15m')).toBe(15 * 60_000);
    expect(parseSleepAfterMs('30m')).toBe(30 * 60_000);
    expect(parseSleepAfterMs('1h')).toBe(1 * 3_600_000);
    expect(parseSleepAfterMs('2h')).toBe(2 * 3_600_000);
  });

  it('SLEEP_AFTER_FALLBACK_MS is the maximum supported value (2h)', () => {
    // Defense-in-depth: the fallback must not be a tiny value like 5m.
    // A short fallback would kill the container early when the pref is
    // missing/corrupted; a long fallback lets the container live longer
    // than expected. Errs on the side of preserving user work.
    expect(SLEEP_AFTER_FALLBACK_MS).toBe(7_200_000);
    expect(SLEEP_AFTER_FALLBACK_MS).toBe(parseSleepAfterMs('2h'));
  });

  it('falls back to 2h on empty string', () => {
    expect(parseSleepAfterMs('')).toBe(SLEEP_AFTER_FALLBACK_MS);
  });

  it('falls back to 2h on garbage input', () => {
    expect(parseSleepAfterMs('garbage')).toBe(SLEEP_AFTER_FALLBACK_MS);
    expect(parseSleepAfterMs('1y')).toBe(SLEEP_AFTER_FALLBACK_MS);
    expect(parseSleepAfterMs('0h')).toBe(SLEEP_AFTER_FALLBACK_MS);
    expect(parseSleepAfterMs('-1m')).toBe(SLEEP_AFTER_FALLBACK_MS);
    expect(parseSleepAfterMs('h')).toBe(SLEEP_AFTER_FALLBACK_MS);
    expect(parseSleepAfterMs('m')).toBe(SLEEP_AFTER_FALLBACK_MS);
  });

  it('falls back to 2h when input parses as 0', () => {
    // parseInt('0h', 10) === 0 - valid number but zero would mean "stop
    // immediately". Treat as malformed and fall back.
    expect(parseSleepAfterMs('0h')).toBe(SLEEP_AFTER_FALLBACK_MS);
    expect(parseSleepAfterMs('0m')).toBe(SLEEP_AFTER_FALLBACK_MS);
  });

  it('handles values not in the validated set but parseable (e.g., 5h)', () => {
    // The storage write site validates against /^(5m|15m|30m|1h|2h)$/, but
    // parseSleepAfterMs itself is permissive on PARSE-able values. A '5h'
    // value (parseable but never written by us) returns 5h. This is
    // intentional - the function is a parser, not a validator. The validator
    // lives at the storage write site.
    expect(parseSleepAfterMs('5h')).toBe(5 * 3_600_000);
    expect(parseSleepAfterMs('45m')).toBe(45 * 60_000);
  });
});
