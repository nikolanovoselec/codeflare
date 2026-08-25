/**
 * Sync fan-out helper (REQ-STOR-015 AC1 + AC4).
 *
 * Enumerates a user's running sessions and forwards POST
 * /internal/bisync-trigger to each Container DO. Used by:
 *
 * - POST /api/sessions/sync (foreground, user-driven Sync-now button)
 * - Upload-side auto-trigger after R2 PUT (background via
 *   executionCtx.waitUntil)
 *
 * Hibernation safety: stateless. No Worker-side cache, no DO-side
 * cache. Each call freshly enumerates KV (which is authoritative for
 * session status per REQ-STOR-014) and freshly forwards to each
 * Container DO. Hibernated DOs / sleeping containers return 503,
 * which is translated to 'not-running' so the caller can mark the
 * session as "skipped" rather than "failed".
 *
 * Fan-out correctness: under the existing `--conflict-resolve newer`
 * semantics in entrypoint.sh, the merge is commutative and associative
 * on absolute mtime. Parallel and serial fan-out produce the same
 * final R2 state per file. See AD56.
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
 * Enumerate the authenticated user's running sessions and fan-out the
 * bisync trigger. Per-session failures are isolated (REQ-STOR-015 AC3).
 */
export async function fanOutBisyncTrigger(
  env: Pick<Env, 'KV' | 'CONTAINER'>,
  bucketName: string
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
          // Path intentionally NOT in the DO's typed INTERNAL_ROUTES table (no
          // leading underscore) so the DO's fetch() override forwards
          // through super.fetch() with auth injection. The host's
          // /internal/bisync-trigger handler sends SIGUSR1 to the
          // bisync daemon.
          const res = await container.fetch(
            new Request('http://container/internal/bisync-trigger', { method: 'POST' })
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
