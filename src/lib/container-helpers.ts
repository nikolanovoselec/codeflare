import type { Context } from 'hono';
import type { Env } from '../types';
import type { DurableObjectStub } from '@cloudflare/workers-types';
import { getContainer } from '@cloudflare/containers';
import { SESSION_ID_PATTERN } from './constants';
import { containerHealthCB } from './circuit-breakers';
import { toErrorMessage, ValidationError } from './error-types';

// Type for context variables set by container middleware
type ContainerVariables = {
  bucketName: string;
};

/** Extracts sessionId from query param (?sessionId=). Used by container routes. Session CRUD routes use Hono path params (c.req.param('id')) instead. */
export function getSessionIdFromQuery(c: Context): string {
  const sessionId = c.req.query('sessionId');
  if (!sessionId) throw new ValidationError('Missing sessionId parameter');
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ValidationError('Invalid sessionId format');
  }
  return sessionId;
}

export function getContainerId(bucketName: string, sessionId: string): string {
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new ValidationError('Invalid sessionId format');
  }
  return `${bucketName}-${sessionId}`;
}

export function getContainerContext<V extends ContainerVariables>(
  c: Context<{ Bindings: Env; Variables: V }>
) {
  const bucketName = c.get('bucketName');
  const sessionId = getSessionIdFromQuery(c);
  const containerId = getContainerId(bucketName, sessionId);
  const container = getContainer(c.env.CONTAINER, containerId);
  return { bucketName, sessionId, containerId, container };
}

// ============================================================================
// Health Check Utilities
// ============================================================================

export interface HealthData {
  status?: string;
  syncStatus?: string;
  syncError?: string | null;
  userPath?: string;
  prewarmReady?: boolean;
  cpu?: string;
  mem?: string;
  hdd?: string;
}

// ============================================================================
// Circuit Breaker Health Check
// ============================================================================

export interface ContainerHealthResult {
  healthy: boolean;
  data?: HealthData;
  error?: string;
  status?: string;
}

/**
 * Check container health using the circuit breaker.
 * This is a single check (not polling) that's protected by the circuit breaker.
 * Use this for quick status checks in routes.
 *
 * @param container - The container stub to check
 * @returns Health check result with status and optional data
 */
export async function checkContainerHealth(
  container: DurableObjectStub
): Promise<ContainerHealthResult> {
  try {
    const response = await containerHealthCB.execute(() =>
      container.fetch(new Request('http://container/health', { method: 'GET' }))
    );

    if (!response.ok) {
      return { healthy: false, error: `Health check returned ${response.status}` };
    }

    const data = await response.json() as HealthData;
    return { healthy: true, data };
  } catch (error) {
    return {
      healthy: false,
      error: toErrorMessage(error)
    };
  }
}

/**
 * Safe health check that avoids auto-starting stopped containers.
 * Uses container.getState() (read-only) to check if the container is running
 * before calling checkContainerHealth() which uses container.fetch() (auto-starts).
 *
 * @param container - The container stub to check
 * @returns Health check result with status and optional data
 */
export async function safeCheckContainerHealth(
  container: DurableObjectStub
): Promise<ContainerHealthResult> {
  try {
    const state = await (container as unknown as { getState(): Promise<{ status: string }> }).getState();
    const isUp = state.status === 'running' || state.status === 'healthy';
    if (!isUp) {
      return { healthy: false, status: state.status };
    }
  } catch {
    // getState() failed — container is not available
    return { healthy: false, status: 'unknown' };
  }

  return checkContainerHealth(container);
}
