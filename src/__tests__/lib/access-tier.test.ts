import { describe, it, expect } from 'vitest';
import { isActiveUser } from '../../lib/access-tier';

describe('access-tier.ts', () => {
  describe('isActiveUser', () => {
    // Original AccessTier values
    it('returns true for standard tier', () => {
      expect(isActiveUser('standard')).toBe(true);
    });

    it('returns true for advanced tier', () => {
      expect(isActiveUser('advanced')).toBe(true);
    });

    it('returns true for undefined tier (legacy users)', () => {
      expect(isActiveUser(undefined)).toBe(true);
    });

    it('returns false for pending tier', () => {
      expect(isActiveUser('pending')).toBe(false);
    });

    it('returns false for blocked tier', () => {
      expect(isActiveUser('blocked')).toBe(false);
    });

    // New SubscriptionTier values
    it('returns true for free tier', () => {
      expect(isActiveUser('free')).toBe(true);
    });

    it('returns true for trial tier', () => {
      expect(isActiveUser('trial')).toBe(true);
    });

    it('returns true for max tier', () => {
      expect(isActiveUser('max')).toBe(true);
    });

    it('returns true for unlimited tier', () => {
      expect(isActiveUser('unlimited')).toBe(true);
    });
  });

});
