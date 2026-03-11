import { CircuitBreaker } from './circuit-breaker';

/** TTL for per-container breaker entries: 5 minutes of inactivity. */
export const CONTAINER_BREAKER_TTL_MS = 5 * 60 * 1000;

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
 * Clear all per-container breaker maps. Used in tests.
 */
export function resetContainerBreakers(): void {
  containerHealthMap.clear();
  containerInternalMap.clear();
  containerSessionsMap.clear();
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
