import type { Context } from 'hono';
import type { Env } from '../types';
import { getContainer } from '@cloudflare/containers';
import { SESSION_ID_PATTERN } from './constants';
import { getContainerHealthCB } from './circuit-breakers';
import { toErrorMessage, ValidationError } from './error-types';

// Type for context variables set by container middleware
type ContainerVariables = {
  bucketName: string;
};

/** Narrow authenticated DO RPC to an already-existing container port. */
interface ContainerStubWithState extends DurableObjectStub {
  forwardExisting(request: Request): Promise<Response>;
}

export function forwardExisting(container: DurableObjectStub, request: Request): Promise<Response> {
  return (container as ContainerStubWithState).forwardExisting(request);
}

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
  initFlagObserved?: boolean;
  terminalServiceReady?: boolean;
  editorReady?: boolean;
  editorReadyTimedOut?: boolean;
  cpu?: string;
  mem?: string;
  hdd?: string;
}

// ============================================================================
// Circuit Breaker Health Check
// ============================================================================

interface ContainerHealthResult {
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
async function checkContainerHealth(
  container: DurableObjectStub,
  containerId: string
): Promise<ContainerHealthResult> {
  try {
    const response = await getContainerHealthCB(containerId).execute(() =>
      forwardExisting(container, new Request('http://container/health', { method: 'GET' }))
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
 * Safe health check that never invokes the SDK auto-starting fetch. A response
 * from the existing private port proves transport readiness even when the
 * persisted SDK state is stale; no response remains retryable uncertainty.
 *
 * @param container - The container stub to check
 * @returns Health check result with status and optional data
 */
export async function safeCheckContainerHealth(
  container: DurableObjectStub,
  containerId: string
): Promise<ContainerHealthResult> {
  return checkContainerHealth(container, containerId);
}
