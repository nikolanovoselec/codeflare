import { createLogger } from '../../lib/logger';
import { createRateLimiter } from '../../middleware/rate-limit';
import { CF_API_BASE } from '../../lib/constants';

export { CF_API_BASE };

export const logger = createLogger('setup');

/**
 * Rate limiter for setup configure endpoint
 * Limits to 5 configure attempts per minute
 */
export const setupRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 5,
  keyPrefix: 'setup-configure',
});

// Step tracking type
export type SetupStep = { step: string; status: 'pending' | 'success' | 'error'; error?: string };

/**
 * Push a new pending step and return its index for later status updates.
 */
export function addStep(steps: SetupStep[], step: string): number {
  steps.push({ step, status: 'pending' });
  return steps.length - 1;
}

/**
 * Extract the worker name from the request hostname.
 * For workers.dev: first part of hostname (e.g., "codeflare" from "codeflare.test.workers.dev")
 * For custom domains or other: uses envWorkerName if provided, otherwise defaults to "codeflare"
 */
export function getWorkerNameFromHostname(requestUrl: string, envWorkerName?: string): string {
  const hostname = new URL(requestUrl).hostname;

  if (hostname.endsWith('.workers.dev')) {
    return hostname.split('.')[0];
  }

  if (envWorkerName) {
    return envWorkerName;
  }

  return 'codeflare';
}

/**
 * Detect common Cloudflare auth/permission errors from API responses.
 * Returns a descriptive error message if an auth issue is detected, or null otherwise.
 */
export function detectCloudflareAuthError(
  status: number,
  errors: Array<{ code?: number; message?: string }>
): string | null {
  const isAuthStatus = status === 401 || status === 403;
  const hasAuthErrorCode = errors.some(e => e.code === 9103 || e.code === 10000);
  const hasAuthMessage = errors.some(e =>
    e.message?.toLowerCase().includes('authentication')
    || e.message?.toLowerCase().includes('permission')
    || e.message?.toLowerCase().includes('invalid access token')
  );

  if (isAuthStatus || hasAuthErrorCode || hasAuthMessage) {
    const details = errors.map(e => `${e.code ?? '?'}: ${e.message ?? 'unknown'}`).join(', ');
    return `Authentication/permission error (HTTP ${status}): ${details}`;
  }

  return null;
}
