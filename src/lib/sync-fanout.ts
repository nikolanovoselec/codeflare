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
import type { Env, Session } from '../types';
import {
  getSessionPrefix,
  listAllKvKeys,
  expandSessionMetadata,
  type SessionListMetadata,
} from './kv-keys';
import { getContainerId } from './container-helpers';
import { SESSION_ID_PATTERN } from './constants';

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
  env: Env,
  bucketName: string
): Promise<SyncSessionResult[]> {
  const prefix = getSessionPrefix(bucketName);
  const keys = await listAllKvKeys(env.KV, prefix);

  // Collect running sessions only. Use list-metadata fast path; fall
  // back to KV.get for pre-migration keys (same pattern as batch-status
  // in src/routes/session/lifecycle.ts).
  const runningSessionIds: string[] = [];
  const fallbackKeys: Array<{ name: string }> = [];
  for (const key of keys) {
    const meta = key.metadata as SessionListMetadata | null;
    if (meta && meta.s) {
      const expanded = expandSessionMetadata(meta);
      if (expanded.status === 'running') {
        // Parse sid as the final colon-delimited segment of the KV key.
        // Validate against SESSION_ID_PATTERN to fail-closed on
        // unexpected key shapes — a malformed key should not crash
        // fan-out (code-reviewer 2nd report H2: replaces unsafe `!`).
        const lastColon = key.name.lastIndexOf(':');
        const sid = lastColon >= 0 ? key.name.slice(lastColon + 1) : '';
        if (sid && SESSION_ID_PATTERN.test(sid)) {
          runningSessionIds.push(sid);
        }
      }
    } else {
      fallbackKeys.push(key);
    }
  }
  if (fallbackKeys.length > 0) {
    const fallbackSessions = await Promise.all(
      fallbackKeys.map((key) => env.KV.get<Session>(key.name, 'json'))
    );
    for (const session of fallbackSessions) {
      // Apply the same SESSION_ID_PATTERN guard the fast path uses.
      // A corrupt KV entry whose `id` field contains arbitrary
      // characters would otherwise flow into getContainerId() unchecked.
      if (
        session &&
        session.status === 'running' &&
        SESSION_ID_PATTERN.test(session.id)
      ) {
        runningSessionIds.push(session.id);
      }
    }
  }

  // Fan out with concurrency cap. Each chunk's failures are isolated.
  const results: SyncSessionResult[] = [];
  for (let i = 0; i < runningSessionIds.length; i += FANOUT_CONCURRENCY_CAP) {
    const chunk = runningSessionIds.slice(i, i + FANOUT_CONCURRENCY_CAP);
    const chunkResults = await Promise.all(
      chunk.map(async (sessionId): Promise<SyncSessionResult> => {
        try {
          const containerId = getContainerId(bucketName, sessionId);
          const container = getContainer(env.CONTAINER, containerId);
          // Path intentionally NOT in the DO's internalRoutes map (no
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
