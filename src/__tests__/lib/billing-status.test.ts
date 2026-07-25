import { describe, it, expect } from 'vitest';
import { BILLING_STATUS } from '../../types';

// Serialization-stability guard (NOT behavioral coverage): these four strings are
// persisted verbatim in KV and are the exact values Stripe subscription webhooks
// deliver. Renaming any value silently orphans existing records and breaks status
// gating, so the wire values are frozen here against an INDEPENDENT snapshot —
// this test fails the moment a BILLING_STATUS value drifts from the contract.
const FROZEN_WIRE_VALUES = ['active', 'trialing', 'past_due', 'canceled'] as const;

describe('BILLING_STATUS wire-value stability (persistence contract)', () => {
  it('freezes the exact set of persisted status values against an independent snapshot', () => {
    expect([...Object.values(BILLING_STATUS)].sort()).toEqual([...FROZEN_WIRE_VALUES].sort());
  });

  it('values are unique so no two statuses collide on the wire', () => {
    const values = Object.values(BILLING_STATUS);
    expect(new Set(values).size).toBe(values.length);
  });
});
