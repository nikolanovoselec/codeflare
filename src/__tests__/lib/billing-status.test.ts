import { describe, it, expect } from 'vitest';
import { BILLING_STATUS } from '../../types';

describe('BILLING_STATUS', () => {
  it('contains all 4 valid billing statuses', () => {
    expect(Object.keys(BILLING_STATUS)).toHaveLength(4);
    expect(BILLING_STATUS.ACTIVE).toBe('active');
    expect(BILLING_STATUS.TRIALING).toBe('trialing');
    expect(BILLING_STATUS.PAST_DUE).toBe('past_due');
    expect(BILLING_STATUS.CANCELED).toBe('canceled');
  });

  it('values are unique', () => {
    const values = Object.values(BILLING_STATUS);
    expect(new Set(values).size).toBe(values.length);
  });
});
