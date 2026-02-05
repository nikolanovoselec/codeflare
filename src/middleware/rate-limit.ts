import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import type { AuthVariables } from './auth';
import { RateLimitError } from '../lib/error-types';
import { ANONYMOUS_RATE_LIMIT_KEY } from '../lib/constants';
import { createLogger } from '../lib/logger';

const logger = createLogger('rate-limit');

// In-memory fallback when KV is unreachable (FIX-15)
const inMemoryRateLimit = new Map<string, { count: number; windowStart: number }>();
const CLEANUP_EVERY_N_REQUESTS = 100;
let fallbackRequestCounter = 0;

/**
 * Configuration for the rate limiter
 */
/** @internal */
export interface RateLimitConfig {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum number of requests allowed per window */
  maxRequests: number;
  /** Key prefix for KV storage (default: 'ratelimit') */
  keyPrefix?: string;
}

/**
 * Rate limit data stored in KV
 */
interface RateLimitData {
  count: number;
  windowStart: number;
}

/**
 * Create a rate limiting middleware for Hono
 *
 * Uses Cloudflare KV to track request counts per user/IP.
 * If KV is not available, rate limiting is skipped.
 *
 * @example
 * ```typescript
 * import { createRateLimiter } from '../middleware/rate-limit';
 *
 * const sessionRateLimiter = createRateLimiter({
 *   windowMs: 60 * 1000, // 1 minute
 *   maxRequests: 10,     // 10 requests per minute
 *   keyPrefix: 'session-create',
 * });
 *
 * app.post('/sessions', sessionRateLimiter, async (c) => {
 *   // Handle request
 * });
 * ```
 *
 * @param config - Rate limit configuration
 * @returns Hono middleware handler
 */
export function createRateLimiter(config: RateLimitConfig): MiddlewareHandler<{ Bindings: Env; Variables: Partial<AuthVariables> }> {
  return async (c, next) => {
    const kv = c.env.KV;
    if (!kv) {
      // Skip rate limiting if KV not available
      return next();
    }

    // Use bucket name (user ID) or IP as rate limit key
    // bucketName is set by authMiddleware which runs before this
    const bucketName = c.get('bucketName');
    const identifier = bucketName || c.req.header('CF-Connecting-IP') || ANONYMOUS_RATE_LIMIT_KEY;
    const key = `${config.keyPrefix || 'ratelimit'}:${identifier}`;

    const now = Date.now();
    const windowStart = now - config.windowMs;

    try {
      // Get current request count
      const data = await kv.get<RateLimitData>(key, 'json');

      let count = 1;
      let currentWindowStart = now;

      if (data) {
        if (data.windowStart > windowStart) {
          // Still in the same window
          count = data.count + 1;
          currentWindowStart = data.windowStart;
        }
        // Otherwise, start a new window (count stays 1, windowStart is now)
      }

      if (count > config.maxRequests) {
        const retryAfter = Math.ceil((currentWindowStart + config.windowMs - now) / 1000);
        throw new RateLimitError(`Rate limit exceeded. Try again in ${retryAfter} seconds.`);
      }

      // Update the count
      await kv.put(key, JSON.stringify({ count, windowStart: currentWindowStart }), {
        expirationTtl: Math.ceil(config.windowMs / 1000) + 60, // Add 60s buffer
      });

      c.header('X-RateLimit-Limit', config.maxRequests.toString());
      c.header('X-RateLimit-Remaining', Math.max(0, config.maxRequests - count).toString());
    } catch (err) {
      if (err instanceof RateLimitError) {
        throw err;
      }
      // KV operation failed — use in-memory fallback instead of letting request through (FIX-15)
      console.warn('[rate-limit] KV failed, activating in-memory fallback for key:', key);
      logger.warn('Rate limit KV operation failed, using in-memory fallback', { key, error: String(err) });

      const fallbackNow = Date.now();
      const windowMs = config.windowMs;
      const entry = inMemoryRateLimit.get(key);

      if (entry && (fallbackNow - entry.windowStart) < windowMs) {
        entry.count++;
        if (entry.count > config.maxRequests) {
          const retryAfter = Math.ceil((entry.windowStart + windowMs - fallbackNow) / 1000);
          throw new RateLimitError(`Rate limit exceeded. Try again in ${retryAfter} seconds.`);
        }
      } else {
        inMemoryRateLimit.set(key, { count: 1, windowStart: fallbackNow });
      }

      // Proactive cleanup every N requests to prevent unbounded growth (FIX-36)
      fallbackRequestCounter++;
      if (fallbackRequestCounter % CLEANUP_EVERY_N_REQUESTS === 0) {
        const cutoff = fallbackNow - windowMs;
        for (const [k, v] of inMemoryRateLimit) {
          if (v.windowStart < cutoff) inMemoryRateLimit.delete(k);
        }
      }
    }

    return next();
  };
}
