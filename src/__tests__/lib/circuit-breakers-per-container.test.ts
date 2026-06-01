import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Per-container circuit breaker isolation tests.
 *
 * CF-151: `resetContainerBreakers` and `CONTAINER_BREAKER_TTL_MS` are now
 * unexported (test-only / prod-coupling-prevention). For module-state
 * isolation between tests we therefore `vi.resetModules()` and dynamically
 * re-import the module in beforeEach, which gives each test a fresh set of
 * (empty) per-container maps instead of calling a reset export. The TTL is
 * mirrored locally as a constant since it is no longer importable.
 */

// Mirrors the (now-unexported) CONTAINER_BREAKER_TTL_MS in circuit-breakers.ts.
const CONTAINER_BREAKER_TTL_MS = 5 * 60 * 1000;

describe('per-container circuit breakers', () => {
  let getContainerHealthCB: typeof import('../../lib/circuit-breakers').getContainerHealthCB;
  let getContainerInternalCB: typeof import('../../lib/circuit-breakers').getContainerInternalCB;
  let getContainerSessionsCB: typeof import('../../lib/circuit-breakers').getContainerSessionsCB;
  let cleanupStaleBreakers: typeof import('../../lib/circuit-breakers').cleanupStaleBreakers;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const mod = await import('../../lib/circuit-breakers');
    getContainerHealthCB = mod.getContainerHealthCB;
    getContainerInternalCB = mod.getContainerInternalCB;
    getContainerSessionsCB = mod.getContainerSessionsCB;
    cleanupStaleBreakers = mod.cleanupStaleBreakers;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('CF-151: test-only symbols are not exported', () => {
    it('does not export resetContainerBreakers or CONTAINER_BREAKER_TTL_MS', async () => {
      const mod = await import('../../lib/circuit-breakers');
      expect((mod as Record<string, unknown>).resetContainerBreakers).toBeUndefined();
      expect((mod as Record<string, unknown>).CONTAINER_BREAKER_TTL_MS).toBeUndefined();
    });
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
      // Fresh module per test (vi.resetModules) means no breakers exist yet.
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

  describe('CF-151/CF-023: LRU size cap', () => {
    // Mirrors the unexported MAX_BREAKERS in circuit-breakers.ts.
    const MAX_BREAKERS = 10_000;

    it('evicts the least-recently-used entry when the map exceeds the cap', () => {
      // Create the very first breaker, then advance time so it is strictly the
      // oldest (lowest lastAccessedAt) of every breaker that follows. The TTL
      // is 5min and we only advance by small steps, so TTL cleanup (which runs
      // every 50 calls) will NOT evict it - only the LRU cap can.
      const lru = getContainerHealthCB('lru-victim');

      // Advance 1ms so subsequent breakers all have a higher lastAccessedAt.
      vi.advanceTimersByTime(1);

      // Fill the map exactly to capacity with distinct IDs. After the first
      // breaker above, that is MAX_BREAKERS - 1 more entries to reach the cap.
      for (let i = 0; i < MAX_BREAKERS - 1; i++) {
        getContainerHealthCB(`cap-fill-${i}`);
      }

      // Map is now AT capacity and 'lru-victim' is the least-recently-used.
      // One more distinct insert must evict 'lru-victim'.
      getContainerHealthCB('overflow');

      // 'lru-victim' was evicted: re-accessing it yields a brand-new instance.
      const recreated = getContainerHealthCB('lru-victim');
      expect(recreated).not.toBe(lru);
    });

    it('does not evict when re-accessing an existing entry at capacity', () => {
      const survivor = getContainerHealthCB('survivor');
      vi.advanceTimersByTime(1);
      for (let i = 0; i < MAX_BREAKERS - 1; i++) {
        getContainerHealthCB(`fill-${i}`);
      }
      // Re-access an EXISTING key while at capacity - must not trigger eviction
      // (the cap check is gated on `map.size >= MAX` AND a NEW key).
      const same = getContainerHealthCB('survivor');
      expect(same).toBe(survivor);
    });
  });
});
