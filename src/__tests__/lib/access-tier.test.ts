import { describe, it, expect } from 'vitest';
import { isActiveUser, allowedSessionModes, canUseSessionMode } from '../../lib/access-tier';

describe('access-tier.ts', () => {
  describe('isActiveUser', () => {
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
  });
});
