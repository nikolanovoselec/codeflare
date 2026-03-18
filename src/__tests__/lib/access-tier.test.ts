import { describe, it, expect } from 'vitest';
import { isActiveUser, allowedSessionModes, canUseSessionMode } from '../../lib/access-tier';

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

  describe('allowedSessionModes', () => {
    it('returns default and advanced for advanced tier', () => {
      expect(allowedSessionModes('advanced')).toEqual(['default', 'advanced']);
    });

    it('returns default and advanced for undefined tier (legacy users)', () => {
      expect(allowedSessionModes(undefined)).toEqual(['default', 'advanced']);
    });

    it('returns only default for standard tier', () => {
      expect(allowedSessionModes('standard')).toEqual(['default']);
    });

    it('returns empty array for pending tier', () => {
      expect(allowedSessionModes('pending')).toEqual([]);
    });

    it('returns empty array for blocked tier', () => {
      expect(allowedSessionModes('blocked')).toEqual([]);
    });

    // New subscription tiers
    it('returns only default for free tier', () => {
      expect(allowedSessionModes('free')).toEqual(['default']);
    });

    it('returns only default for trial tier', () => {
      expect(allowedSessionModes('trial')).toEqual(['default']);
    });

    it('returns default and advanced for max tier', () => {
      expect(allowedSessionModes('max')).toEqual(['default', 'advanced']);
    });

    it('returns default and advanced for unlimited tier', () => {
      expect(allowedSessionModes('unlimited')).toEqual(['default', 'advanced']);
    });
  });

  describe('canUseSessionMode', () => {
    it('returns true for advanced tier with advanced mode', () => {
      expect(canUseSessionMode('advanced', 'advanced')).toBe(true);
    });

    it('returns true for advanced tier with default mode', () => {
      expect(canUseSessionMode('advanced', 'default')).toBe(true);
    });

    it('returns true for standard tier with default mode', () => {
      expect(canUseSessionMode('standard', 'default')).toBe(true);
    });

    it('returns false for standard tier with advanced mode', () => {
      expect(canUseSessionMode('standard', 'advanced')).toBe(false);
    });

    it('returns false for pending tier with default mode', () => {
      expect(canUseSessionMode('pending', 'default')).toBe(false);
    });

    // New subscription tiers
    it('returns true for unlimited tier with advanced mode', () => {
      expect(canUseSessionMode('unlimited', 'advanced')).toBe(true);
    });

    it('returns true for max tier with advanced mode', () => {
      expect(canUseSessionMode('max', 'advanced')).toBe(true);
    });

    it('returns false for free tier with advanced mode', () => {
      expect(canUseSessionMode('free', 'advanced')).toBe(false);
    });

    it('returns true for free tier with default mode', () => {
      expect(canUseSessionMode('free', 'default')).toBe(true);
    });
  });
});
