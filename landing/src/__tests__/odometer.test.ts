import { describe, it, expect } from 'vitest';
import { odometerSteps } from '../scripts/odometer';

describe('odometer', () => {
  it('returns no steps when the value is unchanged', () => {
    expect(odometerSteps(4, 4)).toEqual([]);
  });

  it('rolls a single digit (the 1 → 4 fleet split)', () => {
    expect(odometerSteps(1, 4)).toEqual([{ column: 0, from: 1, to: 4 }]);
  });

  it('rolls back down (the 4 → 0 destroy finale)', () => {
    expect(odometerSteps(4, 0)).toEqual([{ column: 0, from: 4, to: 0 }]);
  });

  it('handles digit carry by padding to the wider value (9 → 10)', () => {
    expect(odometerSteps(9, 10)).toEqual([
      { column: 0, from: 0, to: 1 },
      { column: 1, from: 9, to: 0 },
    ]);
  });

  it('only emits steps for columns that actually change', () => {
    expect(odometerSteps(14, 18)).toEqual([{ column: 1, from: 4, to: 8 }]);
  });
});
