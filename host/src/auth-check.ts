/**
 * REQ-SEC-012: Container auth-token check.
 *
 * Extracted from server.ts so it can be unit-tested without spawning the full
 * HTTP server (which pulls in node-pty, a native module that only loads inside
 * the Docker container).
 *
 * The /health and /activity endpoints are auth-exempt because collectMetrics()
 * enters the container through the SDK's private TCP plumbing and never runs
 * through the DO's public fetch() override that injects the Authorization
 * header. They expose no user data and no mutable container state.
 */
import crypto from 'crypto';

export const AUTH_EXEMPT_PATHS = new Set(['/health', '/activity']);

export type AuthOutcome =
  | { allowed: true }
  | { allowed: false; status: 503 | 401; body: string };

function safeTokenCompare(provided: string, expected: string): boolean {
  const h = (s: string): Buffer => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(provided), h(expected));
}

/**
 * Decide whether an incoming request is permitted under the
 * REQ-SEC-012 container-auth policy.
 *
 *  - Exempt path -> always allowed.
 *  - No CONTAINER_AUTH_TOKEN configured -> 503 (server not ready).
 *  - Missing or wrong Bearer token -> 401.
 *  - Matching Bearer token -> allowed.
 *
 * Returns a structured AuthOutcome so the caller controls how to write the
 * HTTP response (lets the unit test assert without touching http.ServerResponse).
 */
export function checkContainerAuth(
  pathname: string,
  authorizationHeader: string | undefined,
  expectedToken: string | undefined,
): AuthOutcome {
  if (AUTH_EXEMPT_PATHS.has(pathname)) {
    return { allowed: true };
  }
  if (!expectedToken) {
    return {
      allowed: false,
      status: 503,
      body: JSON.stringify({ error: 'Server not configured (missing auth token)' }),
    };
  }
  const providedToken = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice(7)
    : '';
  if (!providedToken || !safeTokenCompare(providedToken, expectedToken)) {
    return {
      allowed: false,
      status: 401,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }
  return { allowed: true };
}
