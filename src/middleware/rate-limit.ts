import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import type { AuthVariables } from './auth';
import { RateLimitError } from '../lib/error-types';
import { ANONYMOUS_RATE_LIMIT_KEY } from '../lib/constants';
import { createLogger } from '../lib/logger';
import { checkRateLimit } from '../lib/rate-limit-core';

const logger = createLogger('rate-limit');

let stressTestWarningLogged = false;

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
  /** CF-003: When true, deny requests if KV is unavailable. Use for security-critical endpoints. */
  failClosed?: boolean;
}

/**
 * Create a rate limiting middleware for Hono
 *
 * Uses Cloudflare KV to track request counts per user/IP.
 * If KV is not available, rate limiting is skipped — unless `failClosed` is
 * set, in which case the request is denied (security-critical endpoints).
 * If a KV operation fails, falls back to in-memory rate limiting
 * via the shared rate-limit-core module (or denies, when `failClosed`).
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
    // CF-015: Non-SaaS operator-set bypass only. In SaaS production this branch is
    // unreachable - the AD26 trust model is enforced by the hard guard at
    // src/index.ts:78-80, which 503s any request when SAAS_MODE && STRESS_TEST_MODE
    // are both active before this middleware runs.
    if (c.env.STRESS_TEST_MODE === 'active') {
      if (!stressTestWarningLogged) {
        logger.warn('STRESS_TEST_MODE is active - all HTTP rate limits bypassed');
        stressTestWarningLogged = true;
      }
      return next();
    }

    const kv = c.env.KV;
    if (!kv) {
      // CF-003: failClosed limiters (security-critical, unauthenticated surfaces)
      // deny when the KV binding is unavailable rather than waving traffic
      // through — matching the `failClosed` contract ("deny when KV is
      // unavailable"). General limiters fail open and skip rate limiting.
      if (config.failClosed) {
        c.header('Retry-After', '60');
        c.header('X-RateLimit-Limit', config.maxRequests.toString());
        c.header('X-RateLimit-Remaining', '0');
        throw new RateLimitError('Rate limiting is temporarily unavailable. Please try again later.');
      }
      // Skip rate limiting if KV not available
      return next();
    }

    // Use bucket name (user ID) or IP as rate limit key
    // bucketName is set by authMiddleware which runs before this
    const bucketName = c.get('bucketName');
    const identifier = bucketName || c.req.header('CF-Connecting-IP') || ANONYMOUS_RATE_LIMIT_KEY;
    const key = `${config.keyPrefix || 'ratelimit'}:${identifier}`;

    const ttlSeconds = Math.ceil(config.windowMs / 1000) + 60; // Add 60s buffer
    const result = await checkRateLimit({
      kv,
      key,
      limit: config.maxRequests,
      windowMs: config.windowMs,
      ttlSeconds,
      failClosed: config.failClosed,
    });

    if (!result.allowed) {
      // CF-012: Attach advisory rate-limit headers to the 429. Headers set on the
      // context survive the throw -> app.onError(...) path, so the RATE_LIMIT_ERROR
      // response carries Retry-After + X-RateLimit-* (REQ-SEC-007 AC4).
      c.header('Retry-After', result.retryAfterSec.toString());
      c.header('X-RateLimit-Limit', config.maxRequests.toString());
      c.header('X-RateLimit-Remaining', '0');
      throw new RateLimitError(`Rate limit exceeded. Try again in ${result.retryAfterSec} seconds.`);
    }

    c.header('X-RateLimit-Limit', config.maxRequests.toString());
    c.header('X-RateLimit-Remaining', Math.max(0, config.maxRequests - result.count).toString());

    return next();
  };
}
