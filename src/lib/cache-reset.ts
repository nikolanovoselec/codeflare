/**
 * Centralized cache reset functions.
 * Extracted from index.ts to avoid circular imports when setup routes
 * need to reset caches after configuration changes.
 */
import { resetCorsOriginsCache } from './cors-cache';
import { resetAuthConfigCache } from './access';
import { resetJWKSCache } from './jwt';
import { resetContainerBreakersForReset } from './circuit-breakers';

// Setup completion cache shared between edge handler and setup routes.
let setupCompleteCache: boolean | null = null;

export function getSetupCompleteCache(): boolean | null {
  return setupCompleteCache;
}

export function setSetupCompleteCache(value: boolean | null): void {
  setupCompleteCache = value;
}

/**
 * Reset all in-memory caches related to setup configuration.
 * Call this when setup completes or is reconfigured so subsequent
 * requests re-read from KV.
 */
export function resetSetupCache(): void {
  setupCompleteCache = null;
  resetCorsOriginsCache();
  resetAuthConfigCache();
  resetJWKSCache();
  // CF-149: drop stale per-container breakers on setup/config change.
  resetContainerBreakersForReset();
}
