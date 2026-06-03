/**
 * In-memory cache for CORS origins loaded from KV.
 * Shared between index.ts (CORS middleware), terminal.ts (WebSocket Origin validation),
 * and cache-reset.ts (cache invalidation on setup changes).
 */

import type { Env } from '../types';
import { DEFAULT_ALLOWED_ORIGINS } from './constants';
import { toErrorMessage } from './error-types';
import { createLogger } from './logger';
import { SETUP_KEYS } from './kv-keys';

const logger = createLogger('cors-cache');

// Cache KV-stored origins per isolate (avoids KV read on every request)
let cachedKvOrigins: string[] | null = null;
let cacheTimestamp = 0;
const CORS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get the cached KV origins. Returns null if cache is empty or expired.
 */
function getCachedKvOrigins(): string[] | null {
  if (cachedKvOrigins !== null && Date.now() - cacheTimestamp < CORS_CACHE_TTL_MS) {
    return cachedKvOrigins; // Cache still valid
  }
  cachedKvOrigins = null; // Expired or empty
  return null;
}

/**
 * Set the cached KV origins.
 */
function setCachedKvOrigins(origins: string[]): void {
  cachedKvOrigins = origins;
  cacheTimestamp = Date.now();
}

/**
 * Reset the in-memory CORS origins cache. Call this when setup completes
 * so the next request re-reads origins from KV.
 */
export function resetCorsOriginsCache(): void {
  cachedKvOrigins = null;
  cacheTimestamp = 0;
}

/**
 * Load allowed origin patterns from KV (setup:custom_domain + setup:allowed_origins).
 * Results are cached in memory per isolate.
 */
async function getKvOrigins(env: Pick<Env, 'KV'>): Promise<string[]> {
  const cached = getCachedKvOrigins();
  if (cached !== null) {
    return cached;
  }

  const origins: string[] = [];

  // CF-022: Separate try/catch for each KV read to prevent partial-list caching
  try {
    const customDomain = await env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN);
    if (customDomain) {
      origins.push(customDomain);
    }
  } catch (err) {
    logger.warn('Failed to load custom domain from KV', { error: toErrorMessage(err) });
  }

  try {
    const originsJson = await env.KV.get(SETUP_KEYS.ALLOWED_ORIGINS);
    if (originsJson) {
      const parsed = JSON.parse(originsJson) as string[];
      if (Array.isArray(parsed)) {
        for (const o of parsed) {
          if (!origins.includes(o)) {
            origins.push(o);
          }
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to load allowed_origins from KV', { error: toErrorMessage(err) });
  }

  setCachedKvOrigins(origins);
  return origins;
}

/**
 * Check whether a hostname matches a pattern with proper domain boundary enforcement.
 *
 * - Dot-prefixed patterns (e.g., `.workers.dev`): suffix match on hostname.
 *   The leading dot inherently enforces a label boundary.
 * - Bare domains (e.g., `claude.novoselec.ch`): exact match OR subdomain match
 *   with an explicit dot boundary (prevents `evilclaude.novoselec.ch` from matching).
 */
function matchesPattern(hostname: string, pattern: string): boolean {
  // RFC 4343: DNS names are case-insensitive. Browsers send lowercase Origin
  // hostnames, but KV-stored patterns may have mixed case from user input.
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('.')) {
    return h.endsWith(p);
  }
  return h === p || h.endsWith('.' + p);
}

/**
 * Check if the request origin is allowed based on environment configuration and KV-stored origins.
 * Combines origins from:
 *   1. env.ALLOWED_ORIGINS (wrangler.toml static config)
 *   2. KV: setup:custom_domain and setup:allowed_origins (dynamic, set by setup wizard)
 * Falls back to DEFAULT_ALLOWED_ORIGINS if env.ALLOWED_ORIGINS is not set.
 *
 * Origins are parsed via `new URL()` to extract the hostname, then matched
 * against patterns with domain-boundary enforcement. This prevents attacks
 * like `evilclaude.example.com` matching a `claude.example.com` pattern.
 * Cloudflare Access JWT serves as the primary authentication gate regardless.
 *
 * SAST-false-positive: KV-stored origin patterns are not re-validated on every
 * read. Admin already has full worker access (deploy code, modify secrets);
 * an admin who can write a malicious pattern can also disable the check
 * entirely. Per-request validation adds overhead for zero security benefit.
 */
export async function isAllowedOrigin(origin: string, env: Pick<Env, 'ALLOWED_ORIGINS' | 'KV'>): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    // CF-026: a malformed Origin can never match the allowlist - reject it.
    return false;
  }

  const staticPatterns = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : DEFAULT_ALLOWED_ORIGINS;

  if (staticPatterns.some(pattern => matchesPattern(hostname, pattern))) {
    return true;
  }

  // Check KV-stored origins (cached)
  const kvOrigins = await getKvOrigins(env);
  return kvOrigins.some(pattern => matchesPattern(hostname, pattern));
}
