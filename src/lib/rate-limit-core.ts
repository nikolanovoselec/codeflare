/**
 * Shared sliding-window rate-limit logic for both HTTP middleware and WebSocket connections.
 *
 * Uses KV as primary store with an in-memory fallback when KV operations fail.
 * Designed to fail-open: if both KV and in-memory checks fail, the request is allowed.
 */
import { createLogger } from './logger';

const logger = createLogger('rate-limit-core');

/** In-memory fallback when KV is unreachable */
const inMemoryFallback = new Map<string, { count: number; windowStart: number }>();
const CLEANUP_EVERY_N = 100;
let fallbackCounter = 0;

interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSec: number;
}

/**
 * Check whether a request is within the sliding-window rate limit.
 *
 * @param params.kv        - KV namespace for persistent storage
 * @param params.key       - Unique key for this rate limit bucket (e.g., "ws-connect:user@example.com")
 * @param params.limit     - Maximum requests allowed per window
 * @param params.windowMs  - Sliding window duration in milliseconds
 * @param params.ttlSeconds - KV entry TTL in seconds (should exceed windowMs)
 * @returns Whether the request is allowed, the current count, and retry-after hint
 */
export async function checkRateLimit(params: {
  kv: KVNamespace;
  key: string;
  limit: number;
  windowMs: number;
  ttlSeconds: number;
}): Promise<RateLimitResult> {
  const { kv, key, limit, windowMs, ttlSeconds } = params;
  const now = Date.now();

  try {
    const data = await kv.get<{ count: number; windowStart: number }>(key, 'json');

    let count = 1;
    let windowStart = now;

    if (data && data.windowStart > now - windowMs) {
      count = data.count + 1;
      windowStart = data.windowStart;
    }

    if (count > limit) {
      const retryAfterSec = Math.ceil((windowStart + windowMs - now) / 1000);
      return { allowed: false, count, retryAfterSec };
    }

    await kv.put(key, JSON.stringify({ count, windowStart }), {
      expirationTtl: ttlSeconds,
    });

    return { allowed: true, count, retryAfterSec: 0 };
  } catch (err) {
    // KV failed -- fall back to in-memory
    logger.warn('Rate limit KV operation failed, using in-memory fallback', { key, error: String(err) });

    const entry = inMemoryFallback.get(key);

    if (entry && (now - entry.windowStart) < windowMs) {
      entry.count++;
      if (entry.count > limit) {
        const retryAfterSec = Math.ceil((entry.windowStart + windowMs - now) / 1000);
        return { allowed: false, count: entry.count, retryAfterSec };
      }
      return { allowed: true, count: entry.count, retryAfterSec: 0 };
    }

    inMemoryFallback.set(key, { count: 1, windowStart: now });

    // Periodic cleanup to prevent unbounded growth
    fallbackCounter++;
    if (fallbackCounter % CLEANUP_EVERY_N === 0) {
      const cutoff = now - windowMs;
      for (const [k, v] of inMemoryFallback) {
        if (v.windowStart < cutoff) inMemoryFallback.delete(k);
      }
    }

    return { allowed: true, count: 1, retryAfterSec: 0 };
  }
}
