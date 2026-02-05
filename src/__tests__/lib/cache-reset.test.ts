import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependent cache modules before importing
vi.mock('../../lib/cors-cache', () => ({
  resetCorsOriginsCache: vi.fn(),
}));

vi.mock('../../lib/access', () => ({
  resetAuthConfigCache: vi.fn(),
}));

vi.mock('../../lib/jwt', () => ({
  resetJWKSCache: vi.fn(),
}));

import {
  getSetupCompleteCache,
  setSetupCompleteCache,
  resetSetupCache,
} from '../../lib/cache-reset';
import { resetCorsOriginsCache } from '../../lib/cors-cache';
import { resetAuthConfigCache } from '../../lib/access';
import { resetJWKSCache } from '../../lib/jwt';

describe('cache-reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to known state
    setSetupCompleteCache(null);
  });

  describe('getSetupCompleteCache / setSetupCompleteCache', () => {
    it('returns null by default', () => {
      expect(getSetupCompleteCache()).toBeNull();
    });

    it('returns true after setting true', () => {
      setSetupCompleteCache(true);
      expect(getSetupCompleteCache()).toBe(true);
    });

    it('returns false after setting false', () => {
      setSetupCompleteCache(false);
      expect(getSetupCompleteCache()).toBe(false);
    });
  });

  describe('resetSetupCache', () => {
    it('resets setupCompleteCache to null', () => {
      setSetupCompleteCache(true);
      resetSetupCache();
      expect(getSetupCompleteCache()).toBeNull();
    });

    it('calls resetCorsOriginsCache', () => {
      resetSetupCache();
      expect(resetCorsOriginsCache).toHaveBeenCalledOnce();
    });

    it('calls resetAuthConfigCache', () => {
      resetSetupCache();
      expect(resetAuthConfigCache).toHaveBeenCalledOnce();
    });

    it('calls resetJWKSCache', () => {
      resetSetupCache();
      expect(resetJWKSCache).toHaveBeenCalledOnce();
    });
  });
});
