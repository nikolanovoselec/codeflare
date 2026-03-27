import { describe, it, expect } from 'vitest';
import { BILLING_STATUS, isBillingStatus } from '../../types';

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

describe('isBillingStatus', () => {
  it('returns true for all valid statuses', () => {
    expect(isBillingStatus('active')).toBe(true);
    expect(isBillingStatus('trialing')).toBe(true);
    expect(isBillingStatus('past_due')).toBe(true);
    expect(isBillingStatus('canceled')).toBe(true);
  });

  it('returns false for invalid strings', () => {
    expect(isBillingStatus('incomplete')).toBe(false);
    expect(isBillingStatus('unpaid')).toBe(false);
    expect(isBillingStatus('')).toBe(false);
    expect(isBillingStatus('ACTIVE')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isBillingStatus(undefined)).toBe(false);
    expect(isBillingStatus(null)).toBe(false);
    expect(isBillingStatus(42)).toBe(false);
  });
});
