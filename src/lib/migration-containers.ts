/**
 * Governed Mode (REQ-ENTERPRISE-020) container coordination for the R2 regime migration.
 *
 * The in-container rclone bisync daemon writes R2 directly with its baked SSE-C regime, so
 * the Worker cannot header-gate it. Before a migration re-encrypts a bucket, every running
 * session container must be drained (destroyed); the migration is only started when none is
 * healthy (D1: no force-kill from a background poll — the user is asked to stop sessions).
 */
import { getContainer } from '@cloudflare/containers';
import type { Env, Session } from '../types';
import { getContainerId, safeCheckContainerHealth } from './container-helpers';
import { listRunningSessionIds } from './session-helpers';
import { getSessionKey, putSessionWithMetadata } from './kv-keys';

/** True if ANY of the bucket's running sessions has a live container (short-circuits). */
export async function hasHealthyContainer(
  env: Pick<Env, 'KV' | 'CONTAINER'>,
  bucketName: string,
): Promise<boolean> {
  const sessionIds = await listRunningSessionIds(env, bucketName);
  for (const sessionId of sessionIds) {
    try {
      const containerId = getContainerId(bucketName, sessionId);
      const container = getContainer(env.CONTAINER, containerId);
      const health = await safeCheckContainerHealth(container, containerId);
      if (health.healthy) return true;
    } catch {
      /* unreachable container is not healthy — keep scanning */
    }
  }
  return false;
}

/**
 * Stop + destroy every running session container so no writer holds the old regime during
 * the re-encrypt. Marks KV `stopped` first (so batch-status skips the container probe),
 * then best-effort destroys — mirrors POST /api/sessions/:id/stop. Per-session failures are
 * isolated; a container that is already gone is a no-op.
 */
export async function drainContainers(
  env: Pick<Env, 'KV' | 'CONTAINER'>,
  bucketName: string,
): Promise<void> {
  const sessionIds = await listRunningSessionIds(env, bucketName);
  await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        const key = getSessionKey(bucketName, sessionId);
        const session = await env.KV.get<Session>(key, 'json');
        if (session && session.status === 'running') {
          await putSessionWithMetadata(env.KV, key, { ...session, status: 'stopped' as const, lastStatusCheck: Date.now() });
        }
        const container = getContainer(env.CONTAINER, getContainerId(bucketName, sessionId));
        await container.destroy();
      } catch {
        /* best-effort drain — container may already be stopped */
      }
    }),
  );
}
