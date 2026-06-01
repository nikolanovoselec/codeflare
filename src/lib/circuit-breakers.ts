import { CircuitBreaker } from './circuit-breaker';

/** TTL for per-container breaker entries: 5 minutes of inactivity.
 *  CF-151: test-only; unexported so prod cannot couple to it. */
const CONTAINER_BREAKER_TTL_MS = 5 * 60 * 1000;

/** CF-151/CF-023: hard cap on per-container breaker map size. The every-50-calls
 *  TTL cleanup only prunes idle entries; a burst of distinct container IDs could
 *  grow a map unbounded between cleanups. When a map hits the cap we evict its
 *  least-recently-used entry (lowest lastAccessedAt) before inserting. This is
 *  the durable bound; TTL cleanup remains as the steady-state pruner. */
const MAX_BREAKERS = 10_000;

// ---------------------------------------------------------------------------
// Per-container circuit breaker maps (FIX-2)
// Each container gets its own breaker instance, lazily created on first access.
// ---------------------------------------------------------------------------
interface BreakerEntry {
  breaker: CircuitBreaker;
  lastAccessedAt: number;
}

const containerHealthMap = new Map<string, BreakerEntry>();
const containerInternalMap = new Map<string, BreakerEntry>();
const containerSessionsMap = new Map<string, BreakerEntry>();

let callCount = 0;

function getOrCreateBreaker(
  map: Map<string, BreakerEntry>,
  containerId: string,
  namePrefix: string,
  options: { failureThreshold: number; resetTimeoutMs: number; halfOpenMaxAttempts?: number },
): CircuitBreaker {
  if (++callCount % 50 === 0) cleanupStaleBreakers();

  const existing = map.get(containerId);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    return existing.breaker;
  }
  // CF-151/CF-023: enforce the size cap with LRU eviction before inserting.
  if (map.size >= MAX_BREAKERS) {
    let lruId: string | undefined;
    let lruAt = Infinity;
    for (const [id, entry] of map) {
      if (entry.lastAccessedAt < lruAt) {
        lruAt = entry.lastAccessedAt;
        lruId = id;
      }
    }
    if (lruId !== undefined) map.delete(lruId);
  }
  const breaker = new CircuitBreaker(`${namePrefix}:${containerId}`, options);
  map.set(containerId, { breaker, lastAccessedAt: Date.now() });
  return breaker;
}

/**
 * Get a per-container circuit breaker for health checks.
 */
export function getContainerHealthCB(containerId: string): CircuitBreaker {
  return getOrCreateBreaker(containerHealthMap, containerId, 'container-health', {
    failureThreshold: 5,
    resetTimeoutMs: 30000,
    halfOpenMaxAttempts: 2,
  });
}

/**
 * Get a per-container circuit breaker for internal container operations.
 */
export function getContainerInternalCB(containerId: string): CircuitBreaker {
  return getOrCreateBreaker(containerInternalMap, containerId, 'container-internal', {
    failureThreshold: 3,
    resetTimeoutMs: 15000,
  });
}

/**
 * Get a per-container circuit breaker for session operations.
 */
export function getContainerSessionsCB(containerId: string): CircuitBreaker {
  return getOrCreateBreaker(containerSessionsMap, containerId, 'container-sessions', {
    failureThreshold: 5,
    resetTimeoutMs: 30000,
  });
}

/**
 * Evict breaker entries that haven't been accessed within the TTL.
 */
export function cleanupStaleBreakers(): void {
  const now = Date.now();
  for (const map of [containerHealthMap, containerInternalMap, containerSessionsMap]) {
    for (const [id, entry] of map) {
      if (now - entry.lastAccessedAt > CONTAINER_BREAKER_TTL_MS) {
        map.delete(id);
      }
    }
  }
}

/**
 * Clear all per-container breaker maps.
 * CF-151: unexported test-only symbol. Tests reach it via vi.resetModules()
 * + dynamic re-import for module-state isolation rather than importing this
 * directly. Production resets go through resetContainerBreakersForReset().
 */
function resetContainerBreakers(): void {
  containerHealthMap.clear();
  containerInternalMap.clear();
  containerSessionsMap.clear();
}

/**
 * Production reset entry. Called by cache-reset.ts resetSetupCache() so a
 * setup/config change drops stale per-container breakers along with the other
 * setup caches. Thin wrapper over the (test-only-unexported) clear above so
 * the public surface stays a single production-named function.
 */
export function resetContainerBreakersForReset(): void {
  resetContainerBreakers();
}

// ---------------------------------------------------------------------------
// Module-level singleton circuit breakers (non-container-scoped)
// These are for R2 admin and CF API calls, which are not per-container.
// ---------------------------------------------------------------------------

/**
 * Circuit breaker for R2 admin API calls
 * Used when checking/creating R2 buckets via Cloudflare API
 */
export const r2AdminCB = new CircuitBreaker('r2-admin', {
  failureThreshold: 3,
  resetTimeoutMs: 30000,
});

/**
 * Circuit breaker for Cloudflare API calls
 * Used for Access policy sync and other CF API operations
 */
export const cfApiCB = new CircuitBreaker('cf-api', {
  failureThreshold: 3,
  resetTimeoutMs: 30000,
});
