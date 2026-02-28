import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getContainerHealthCB,
  getContainerInternalCB,
  getContainerSessionsCB,
  resetContainerBreakers,
  cleanupStaleBreakers,
  CONTAINER_BREAKER_TTL_MS,
} from '../../lib/circuit-breakers';

describe('per-container circuit breakers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetContainerBreakers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('per-container isolation', () => {
    it('returns distinct breaker instances for different container IDs', () => {
      const cbA = getContainerHealthCB('container-a');
      const cbB = getContainerHealthCB('container-b');
      expect(cbA).not.toBe(cbB);
    });

    it('returns same breaker instance for same container ID', () => {
      const cb1 = getContainerHealthCB('container-a');
      const cb2 = getContainerHealthCB('container-a');
      expect(cb1).toBe(cb2);
    });

    it('container A failure does not affect container B', async () => {
      const cbA = getContainerHealthCB('container-a');
      const cbB = getContainerHealthCB('container-b');

      const failFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Trip container A's breaker
      for (let i = 0; i < 5; i++) {
        await expect(cbA.execute(failFn)).rejects.toThrow('fail');
      }
      expect(cbA.getState()).toBe('OPEN');

      // Container B should still be closed
      expect(cbB.getState()).toBe('CLOSED');
      const successFn = vi.fn().mockResolvedValue('ok');
      await cbB.execute(successFn);
      expect(successFn).toHaveBeenCalled();
    });

    it('provides separate internal and session breakers per container', () => {
      const health = getContainerHealthCB('container-x');
      const internal = getContainerInternalCB('container-x');
      const sessions = getContainerSessionsCB('container-x');

      expect(health).not.toBe(internal);
      expect(internal).not.toBe(sessions);
      expect(health).not.toBe(sessions);
    });
  });

  describe('lazy creation', () => {
    it('creates breaker on first access', () => {
      resetContainerBreakers();
      // No breakers exist yet — accessing creates one
      const cb = getContainerHealthCB('new-container');
      expect(cb).toBeDefined();
      expect(cb.getState()).toBe('CLOSED');
    });
  });

  describe('TTL cleanup', () => {
    it('evicts entries older than TTL', () => {
      const cbA = getContainerHealthCB('container-a');
      const cbB = getContainerHealthCB('container-b');

      expect(cbA).toBeDefined();
      expect(cbB).toBeDefined();

      // Advance past TTL
      vi.advanceTimersByTime(CONTAINER_BREAKER_TTL_MS + 1);

      // Access container-b to refresh its timestamp
      getContainerHealthCB('container-b');

      // Cleanup should evict container-a but keep container-b
      cleanupStaleBreakers();

      // container-a should be a new instance (old one evicted)
      const cbANew = getContainerHealthCB('container-a');
      expect(cbANew).not.toBe(cbA);

      // container-b should be the same instance (was refreshed)
      const cbBSame = getContainerHealthCB('container-b');
      expect(cbBSame).toBe(cbB);
    });

    it('does not evict recently accessed entries', () => {
      const cb = getContainerHealthCB('active-container');
      vi.advanceTimersByTime(CONTAINER_BREAKER_TTL_MS - 1000);

      // Access again to refresh
      getContainerHealthCB('active-container');

      vi.advanceTimersByTime(2000); // Total: TTL + 1000, but refreshed 2s ago
      cleanupStaleBreakers();

      const cbAfter = getContainerHealthCB('active-container');
      expect(cbAfter).toBe(cb);
    });
  });

  describe('resetContainerBreakers', () => {
    it('clears all container breaker maps', () => {
      const cb = getContainerHealthCB('container-a');
      expect(cb).toBeDefined();

      resetContainerBreakers();

      // After reset, should get a new instance
      const cbNew = getContainerHealthCB('container-a');
      expect(cbNew).not.toBe(cb);
    });
  });
});
