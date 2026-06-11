import { describe, it, expect } from 'vitest';
import { sessionClock } from '../scripts/session-clock';

describe('session-clock', () => {
  it('formats progress 0 as the session start', () => {
    expect(sessionClock(0)).toBe('00:00:00');
  });

  it('formats progress 1 as the full 47-minute session', () => {
    expect(sessionClock(1)).toBe('00:47:00');
  });

  it('is monotonically non-decreasing over increasing progress', () => {
    let previous = sessionClock(0);
    for (let p = 0; p <= 100; p++) {
      const current = sessionClock(p / 100);
      expect(current >= previous).toBe(true);
      previous = current;
    }
  });

  it('clamps progress outside [0, 1]', () => {
    expect(sessionClock(-0.5)).toBe('00:00:00');
    expect(sessionClock(1.7)).toBe('00:47:00');
  });

  it('honors a custom session length', () => {
    expect(sessionClock(0.5, 10)).toBe('00:05:00');
    expect(sessionClock(1, 90)).toBe('01:30:00');
  });
});
