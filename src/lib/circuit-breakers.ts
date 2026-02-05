import { CircuitBreaker } from './circuit-breaker';

/**
 * Circuit breaker for container health checks (singleton).
 */
export const containerHealthCB = new CircuitBreaker('container-health', {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  halfOpenMaxAttempts: 2,
});

/**
 * Circuit breaker for internal container operations
 * Used for setBucketName, getBucketName, and other internal endpoints
 */
export const containerInternalCB = new CircuitBreaker('container-internal', {
  failureThreshold: 3,
  resetTimeoutMs: 15000,
});

/**
 * Circuit breaker for container session operations
 * Used for /sessions endpoint and session-related operations
 */
export const containerSessionsCB = new CircuitBreaker('container-sessions', {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
});

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
