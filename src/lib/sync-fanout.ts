/**
 * Sync now fan-out (REQ-STOR-015 AC1–AC3, AC7). The manual route reads
 * the owner's workload-owning sessions from D1 and forwards a trigger to
 * each Container DO. R2 uploads do not trigger fan-out.
 *
 * A 503 becomes `not-running`; one failed request cannot prevent the
 * other sessions from attempting sync. Bisync's newest-file-wins rule
 * does not guarantee convergence for equal or racing mtimes (AD56).
 */
import { getContainer } from '@cloudflare/containers';
import type { Env } from '../types';
import { getContainerId } from './container-helpers';
import { listRunningSessionIds } from './session-helpers';
import { isBucketMigrating } from './r2-regime-state';

/**
 * Maximum concurrent per-session sync triggers in one fan-out call
 * (REQ-STOR-015 AC2). Keeps Worker subrequest / CPU budget bounded
 * if a user has many running sessions. Triggers beyond the cap are
 * processed sequentially in subsequent chunks. Internal-only - no
 * external consumer needs to read it.
 */
const FANOUT_CONCURRENCY_CAP = 8;

export interface SyncSessionResult {
  sessionId: string;
  status: 'triggered' | 'not-running' | 'failed';
  error?: string;
}

/**
 * Fan out the bisync trigger to the authenticated owner's workload-owning
 * sessions. Per-session failures are isolated (REQ-STOR-015 AC3).
 */
export async function fanOutBisyncTrigger(
  env: Pick<Env, 'KV' | 'USAGE_DB' | 'CONTAINER'>,
  bucketName: string,
  trigger: 'automatic' | 'manual' = 'automatic'
): Promise<SyncSessionResult[]> {
  // REQ-ENTERPRISE-020: never trigger bisync while the bucket's regime is migrating — a
  // container's rclone daemon would push its local FS in the pre-flip regime. Containers are
  // drained on migration start; this guards any stale/racing container.
  if (await isBucketMigrating(env, bucketName)) return [];

  const runningSessionIds = await listRunningSessionIds(env, bucketName);

  // Fan out with concurrency cap. Each chunk's failures are isolated.
  const results: SyncSessionResult[] = [];
  for (let i = 0; i < runningSessionIds.length; i += FANOUT_CONCURRENCY_CAP) {
    const chunk = runningSessionIds.slice(i, i + FANOUT_CONCURRENCY_CAP);
    const chunkResults = await Promise.all(
      chunk.map(async (sessionId): Promise<SyncSessionResult> => {
        try {
          const containerId = getContainerId(bucketName, sessionId);
          const container = getContainer(env.CONTAINER, containerId);
          // This host route falls through the DO's internal dispatcher and
          // forwards to the existing private port with the lifecycle bearer.
          // The host signals the daemon; 202 acknowledges admission only.
          const res = await container.fetch(
            new Request('http://container/internal/bisync-trigger', {
              method: 'POST',
              headers: trigger === 'manual' ? { 'X-Codeflare-Sync-Recovery': 'retry' } : {},
            })
          );
          if (res.status === 202) {
            return { sessionId, status: 'triggered' };
          }
          if (res.status === 503) {
            // Container not running (DO 503) or daemon not started
            // (host 503). Either way, no active sync work to trigger.
            return { sessionId, status: 'not-running' };
          }
          return { sessionId, status: 'failed', error: `unexpected status ${res.status}` };
        } catch (err) {
          return {
            sessionId,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );
    results.push(...chunkResults);
  }
  return results;
}
