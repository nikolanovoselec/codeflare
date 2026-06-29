import { describe, it, expect } from 'vitest';
import { reconnectBackoffMs } from '../../stores/terminal';

// REQ-TERM-003 AC9: equal-jitter exponential backoff. Pure function — exercised
// directly with an injected `rand` so the contract values (floor at 50% of the
// raw delay, ceil at 100%, doubling per attempt, 15000ms cap) are deterministic.
describe('reconnectBackoffMs (REQ-TERM-003 AC9): equal-jitter exponential backoff', () => {
  it('floors each attempt at 50% of the raw exponential delay (rand=0), capped at 7500ms', () => {
    const floor = (attempt: number) => reconnectBackoffMs(attempt, () => 0);
    expect([1, 2, 3, 4, 5, 6, 7].map(floor)).toEqual([250, 500, 1000, 2000, 4000, 7500, 7500]);
  });

  it('caps each attempt at 100% of the raw exponential delay (rand=1), capped at 15000ms', () => {
    const ceil = (attempt: number) => reconnectBackoffMs(attempt, () => 1);
    expect([1, 2, 3, 4, 5, 6, 7].map(ceil)).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000]);
  });

  it('is non-decreasing across attempts and never exceeds the 15000ms cap', () => {
    const delays = Array.from({ length: 12 }, (_, i) => reconnectBackoffMs(i + 1, () => 1));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(15000);
    }
  });

  it('treats attempt <= 0 as attempt 1', () => {
    expect(reconnectBackoffMs(0, () => 1)).toBe(reconnectBackoffMs(1, () => 1));
    expect(reconnectBackoffMs(-5, () => 0)).toBe(reconnectBackoffMs(1, () => 0));
  });
});
