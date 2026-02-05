/**
 * Shared utilities for container routes
 * Includes timeout utilities, circuit breakers, and logger
 */
import type { DurableObjectStub } from '@cloudflare/workers-types';
import { createLogger, type Logger } from '../../lib/logger';
import { isBucketNameResponse } from '../../lib/type-guards';
import { toErrorMessage } from '../../lib/error-types';
import { CONTAINER_FETCH_TIMEOUT } from '../../lib/constants';

// Re-export circuit breakers from central location
export { containerHealthCB, containerInternalCB, containerSessionsCB } from '../../lib/circuit-breakers';

// Local import for use within this module (re-exports aren't local bindings)
import { containerInternalCB } from '../../lib/circuit-breakers';

export const containerLogger = createLogger('container-routes');

/**
 * Races a fetch against a timeout. Returns null on timeout.
 *
 * Note (AD15): The underlying fetch continues in the background until
 * the isolate terminates — AbortSignal is not passed because the
 * caller signature (DurableObjectStub.fetch) doesn't support it.
 * In Cloudflare Workers, isolate termination handles cleanup.
 */
export async function fetchWithTimeout(
  fetchFn: () => Promise<Response>,
  timeoutMs: number = CONTAINER_FETCH_TIMEOUT
): Promise<Response | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  return Promise.race([fetchFn(), timeout]);
}

/**
 * Fetch the stored bucket name from a container's Durable Object.
 * Returns the bucket name string or null if it couldn't be retrieved.
 */
export async function getStoredBucketName(
  container: DurableObjectStub,
  logger: Logger
): Promise<string | null> {
  try {
    const resp = await containerInternalCB.execute(() =>
      container.fetch(
        new Request('http://container/_internal/getBucketName', { method: 'GET' })
      )
    );
    const data = await resp.json();
    if (isBucketNameResponse(data)) {
      return data.bucketName;
    }
    return null;
  } catch (err) {
    const errMsg = toErrorMessage(err);
    if (errMsg.includes('not found') || errMsg.includes('does not exist') || errMsg.includes('Network')) {
      logger.debug('Could not get stored bucket name, DO may not exist yet');
    } else {
      logger.warn('Unexpected error getting stored bucket name', { error: errMsg });
    }
    return null;
  }
}
