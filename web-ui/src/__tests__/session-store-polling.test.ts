import { describe, it, expect } from 'vitest';
import { shouldSkipStatusTransition } from '../stores/session';

describe('shouldSkipStatusTransition', () => {
  it('returns true for the active session (skip status transition from KV polling)', () => {
    expect(shouldSkipStatusTransition('abc', 'abc')).toBe(true);
  });

  it('returns false for an inactive session (allow status transition)', () => {
    expect(shouldSkipStatusTransition('abc', 'def')).toBe(false);
  });

  it('returns false when no active session (dashboard view, KV is authority)', () => {
    expect(shouldSkipStatusTransition('abc', null)).toBe(false);
  });
});
