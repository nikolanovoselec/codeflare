/**
 * container-metrics — Metrics collection, idle detection, and Timekeeper pings.
 *
 * Extracted from Container DO (index.ts) to reduce file size.
 * All functions receive explicit state/context parameters instead of `this`.
 */
import type { Env, Session } from '../types';
import { TERMINAL_SERVER_PORT } from '../lib/constants';
import { toError } from '../lib/error-types';
import { getSessionKey, putSessionWithMetadata } from '../lib/kv-keys';
import { createLogger } from '../lib/logger';
import type { ActivityState } from '../lib/activity-policy';
import { isSaasModeActive } from '../lib/onboarding';

const SESSION_ID_KEY = '_sessionId';
const logger = createLogger('container-metrics');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mutable state fields that metrics collection needs to read/write. */
export interface MetricsState {
  _bucketName: string | null;
  _sessionId: string | null;
  _userEmail: string | null;
  _usageSeconds: number;
  containerStartedAt: number;
  lastSeenInputAt: number | null;
}

/** Callbacks provided by the Container class for idle detection + scheduling. */
export interface MetricsCallbacks {
  stop: (signal: number | string) => Promise<void>;
  schedule: (delaySec: number, method: string) => Promise<unknown>;
  /** Cached value from class field. collectMetrics re-reads storage as the
   *  authoritative source on every tick to avoid drift from stale caches. */
  idleTimeoutPref: string;
  /** Update the in-memory cache after a fresh storage read. */
  setIdleTimeoutPref: (next: string) => void;
}

// ---------------------------------------------------------------------------
// parseSleepAfterMs
// ---------------------------------------------------------------------------

/** Parse sleepAfter string ('5m', '30m', '1h', '2h') to milliseconds.
 *
 * Fail-safe direction: an unrecognized or malformed string returns the maximum
 * supported timeout (2h) rather than the minimum. A short fallback would cause
 * the container to die early when the pref is missing/corrupted; a long
 * fallback only causes the container to live slightly longer than the user
 * expected. Errs on the side of preserving user work over saving compute.
 *
 * The validated regex `/^(5m|15m|30m|1h|2h)$/` at the storage write site means
 * this fallback should only ever fire on truly broken input. Log it loudly
 * (caller logs).
 *
 */
// DO-storage key holding the wall-clock ms at which the container first read
// not-running in an unbroken streak. Persisted (not in-memory) so it survives
// the DO hibernation/reset that itself triggers the transient false reading.
const NOT_RUNNING_SINCE_KEY = 'metricsNotRunningSince';
// DO-storage key marking that a deliberate stop (destroy(), user Stop/Delete)
// is in flight. The self-heal reads it to tell a falsely-stopped live session
// (heal it back to running) from a deliberately-stopping one (leave it
// stopped). PERSISTED, not an in-memory field, for the same reason the
// not-running window is: destroy() can be interrupted by a DO eviction whose
// reconstructed instance would reset any in-memory flag to 0, and the surviving
// metrics alarm would then resurrect a session the user just stopped. destroy()
// sets this before it clears identifiers; onStart() clears it on a fresh start.
export const SHUTDOWN_REQUESTED_KEY = 'shutdownRequested';
// A container must read not-running continuously for at least this long before
// collectMetrics writes 'stopped'. Spans more than one 60s alarm tick so a
// single transient `ctx.container.running === false` (DO hibernation wake or
// deploy-roll, while the container is actually alive) cannot flip a live
// session to stopped. This catch-all covers exits the SDK never surfaces as
// onError; onError itself now feeds the SAME window rather than writing stopped
// directly (openNotRunningConfirmation), so a transient error that fires onError
// while the container is actually alive can no longer flip a live session to
// stopped (REQ-SESSION-018 AC3).
const NOT_RUNNING_CONFIRM_MS = 90_000;

// Budget the DO gives the in-container final sync (drainFinalSync) to complete
// before a stop (REQ-SESSION-011 AC4). 120s pairs with the 135s teardown
// hard-cap in destroy() (120s sync + 15s for the actual stop), and with the
// 115s internal poll cap in the host server's /internal/final-sync endpoint.
export const FINAL_SYNC_BUDGET_MS = 120_000;

/**
 * Open the not-running confirmation window without writing 'stopped'.
 *
 * Called by onError (container-lifecycle.ts) on a not-running reading so the
 * stopped decision is deferred to collectMetrics' confirmation window instead
 * of being written immediately on a single, possibly-transient reading. Sets
 * the marker only if not already open, so an in-progress streak is not reset.
 * The caller re-arms a collectMetrics tick so the window gets evaluated.
 */
export async function openNotRunningConfirmation(ctx: DurableObjectState): Promise<void> {
  const since = await ctx.storage.get<number>(NOT_RUNNING_SINCE_KEY);
  if (typeof since !== 'number') {
    await ctx.storage.put(NOT_RUNNING_SINCE_KEY, Date.now());
  }
}

export const SLEEP_AFTER_FALLBACK_MS = 7_200_000; // 2h
export function parseSleepAfterMs(s: string): number {
  if (s.endsWith('h')) {
    const h = parseInt(s, 10);
    if (!Number.isNaN(h) && h > 0) return h * 3_600_000;
  }
  if (s.endsWith('m')) {
    const m = parseInt(s, 10);
    if (!Number.isNaN(m) && m > 0) return m * 60_000;
  }
  logger.warn('parseSleepAfterMs: unrecognized value, falling back to 2h', { input: s });
  return SLEEP_AFTER_FALLBACK_MS;
}

// ---------------------------------------------------------------------------
// updateKvStatus
// ---------------------------------------------------------------------------

/**
 * Update a timestamp field on the KV session record (best-effort).
 * Optionally sets session.status (e.g. 'stopped' on hibernation).
 */
export async function updateKvStatus(
  ctx: DurableObjectState,
  env: Env,
  bucketNameOverride: string | null,
  status: 'running' | 'stopped' | null,
  field: 'lastStartedAt' | 'lastActiveAt',
): Promise<void> {
  try {
    const sessionId = await ctx.storage.get<string>(SESSION_ID_KEY);
    // Fallback: if _bucketName isn't set on the instance, try loading from storage
    const bucketName = bucketNameOverride || await ctx.storage.get<string>('bucketName') || null;
    if (!sessionId || !bucketName) {
      logger.info('updateKvStatus: missing identifiers', { status, field, sessionId: !!sessionId, bucketName: !!bucketName });
      return;
    }
    const key = getSessionKey(bucketName, sessionId);
    const session = await env.KV.get<Session>(key, 'json');
    if (!session) {
      logger.info('updateKvStatus: session not found in KV', { key, status, field });
      return;
    }
    const updated = {
      ...session,
      ...(status !== null ? { status } : {}),
      [field]: new Date().toISOString(),
    };
    await putSessionWithMetadata(env.KV, key, updated);
    logger.info('updateKvStatus: wrote to KV', { key, status, field });
  } catch (err) {
    logger.error('Failed to update KV status', toError(err));
  }
}

// ---------------------------------------------------------------------------
// drainFinalSync
// ---------------------------------------------------------------------------

/**
 * Drain a final R2 sync while the container is still fully alive, BEFORE any
 * stop (REQ-SESSION-011). Calls the in-container POST /internal/final-sync,
 * which triggers a fresh bisync and blocks until it reaches a terminal status;
 * we await that up to budgetMs via an AbortController.
 *
 * Why this exists: the old design relied on the entrypoint's SIGTERM trap to
 * run the final bisync, but the platform kills the container ~3s after SIGTERM -
 * far short of a bisync that can take up to ~2min under the 15-min cadence - so
 * the trap was cut off and the last edits never reached R2. Syncing here, while
 * the container is alive and the DO holds the teardown open, removes the
 * dependency on the kill grace entirely. Best-effort: any non-OK/timeout/error
 * is logged and swallowed so the caller still proceeds to stop (the 135s
 * teardown hard-cap is the backstop). Mirrors the /health probe's port (8080).
 */
export async function drainFinalSync(ctx: DurableObjectState, budgetMs: number): Promise<void> {
  if (!ctx.container?.running) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const port = ctx.container.getTcpPort(8080);
    const res = await port.fetch('http://localhost/internal/final-sync', {
      method: 'POST',
      signal: controller.signal,
    });
    if (res.ok) {
      logger.info('drainFinalSync: final sync completed before stop');
    } else {
      logger.warn('drainFinalSync: final sync did not complete, proceeding to stop', { status: res.status });
    }
  } catch (err) {
    logger.warn('drainFinalSync: final sync errored/timed out, proceeding to stop', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// collectMetrics
// ---------------------------------------------------------------------------

/**
 * Collect health metrics, detect idle state, ping Timekeeper, and re-arm the schedule.
 *
 * Mutates `state` (lastSeenInputAt, _usageSeconds) in place.
 *
 * ALARM-LOOP LIFECYCLE: this runs as a one-shot DO alarm that re-arms itself
 * (callbacks.schedule(60, ...)) ONLY while ctx.container.running. If the
 * container is not running on entry, the loop marks the session stopped (the
 * authoritative catch-all for an exit the SDK surfaced as onError, not onStop)
 * and returns WITHOUT re-arming; onStart() restarts the loop on the next start.
 * Consequences worth knowing: (a) DO alarms can fire late (observed ~60s drift
 * in prod); (b) the loop does NOT run while the DO/container is hibernated, so
 * the metrics heartbeat (m.u) can go stale on a perfectly healthy session.
 * That staleness is why a heartbeat-age heuristic is NOT a valid liveness
 * signal - KV status must come from the lifecycle hooks (see the contract above
 * container/index.ts::onStart). Removing that heuristic is codeflare#153.
 *
 * TIMESTAMP TAXONOMY (four distinct clocks - do not conflate):
 *   lastInputAt        in-container /activity: wall-clock of the last PTY
 *                      KEYSTROKE (user input) only. Does NOT advance on terminal
 *                      OUTPUT, WebSocket traffic, vault/SilverBullet activity, or
 *                      an autonomously-working agent. The idle reference:
 *                      idleMs = Date.now() - (lastInputAt ?? containerStartedAt).
 *   lastSeenInputAt    MetricsState's cached copy of lastInputAt for this tick.
 *   lastActiveAt (KV)  mirrors lastInputAt (input-driven). Feeds the dashboard
 *                      sleep-timer countdown. NOT a liveness signal.
 *   metrics.updatedAt  KV meta m.u: wall-clock re-stamped here EVERY tick
 *     (m.u)            regardless of input. Metrics-staleness display only; it
 *                      freezes whenever this loop is not running (see above), so
 *                      it must not be used to infer liveness.
 */
export async function collectMetrics(
  state: MetricsState,
  ctx: DurableObjectState,
  env: Env,
  callbacks: MetricsCallbacks,
): Promise<void> {
  // Container reads as not-running. This is EITHER a genuine exit (crash,
  // deploy-roll, platform idle-reap) that the SDK never surfaced as onError,
  // OR a transient false reading: `ctx.container.running` momentarily reports
  // false when an alarm wakes a hibernated DO or during a deploy-roll, while
  // the container is actually alive. Writing 'stopped' on a single such tick
  // both flips a live session to stopped (kicking the user to the dashboard)
  // AND kills the alarm loop (the re-arm at the foot of this function only
  // fires while running), freezing metrics until the next onStart. So require
  // the not-running reading to persist across NOT_RUNNING_CONFIRM_MS before
  // treating it as a real exit, re-arming meanwhile so the streak can be
  // observed (REQ-SESSION-018). The marker lives in DO storage so it survives
  // the hibernation/reset that causes the false reading.
  if (!ctx.container?.running) {
    const now = Date.now();
    const since = await ctx.storage.get<number>(NOT_RUNNING_SINCE_KEY);
    // No marker yet (real DO storage returns undefined; some mocks null): open
    // the window and re-arm without writing stopped.
    if (typeof since !== 'number') {
      await ctx.storage.put(NOT_RUNNING_SINCE_KEY, now);
      logger.info('collectMetrics: container not running, opening confirmation window', {
        confirmMs: NOT_RUNNING_CONFIRM_MS,
      });
      try { await callbacks.schedule(60, 'collectMetrics'); } catch { /* DO shutting down */ }
      return;
    }
    if (now - since < NOT_RUNNING_CONFIRM_MS) {
      logger.info('collectMetrics: container not running, within confirmation window', {
        elapsedMs: now - since, confirmMs: NOT_RUNNING_CONFIRM_MS,
      });
      // Re-arm so the streak is re-checked; onStart's deleteSchedules dedupes
      // if the container recovers and restarts the loop concurrently.
      try { await callbacks.schedule(60, 'collectMetrics'); } catch { /* DO shutting down */ }
      return;
    }
    logger.info('collectMetrics: container not running past confirmation window, marking stopped', {
      elapsedMs: now - since,
    });
    await ctx.storage.delete(NOT_RUNNING_SINCE_KEY);
    await updateKvStatus(ctx, env, state._bucketName, 'stopped', 'lastActiveAt');
    return;
  }
  // Container is running - clear any pending not-running confirmation marker so
  // a future transient blip starts a fresh streak.
  await ctx.storage.delete(NOT_RUNNING_SINCE_KEY);

  // User-input-based idle detection. The SDK's sleepAfter timer is pinned to
  // 24h and refreshes on every WebSocket message (in both directions) in
  // @cloudflare/containers v0.2.x, so it would keep a container alive as
  // long as any bytes flow — including background output from `tail -f` or
  // `yes`. collectMetrics polls the in-container /activity endpoint for
  // lastInputAt (PTY input only) and explicitly stops the container when
  // idle exceeds the user-configured threshold.
  //
  // Re-read the idle-timeout pref from DO storage every tick. The class field
  // cache may be stale if (a) the DO instance was hibernated and re-loaded
  // and the construction's storage read raced with a setBucketName write, or
  // (b) some code path wrote 'sleepAfter' to storage without updating the
  // cache. Storage is the authoritative source.
  let idleTimeoutPref = callbacks.idleTimeoutPref;
  try {
    const stored = await ctx.storage.get<string>('sleepAfter');
    if (stored && /^(5m|15m|30m|1h|2h)$/.test(stored)) {
      if (stored !== idleTimeoutPref) {
        logger.info('collectMetrics: refreshing idleTimeoutPref from storage', {
          cached: idleTimeoutPref, stored,
        });
        callbacks.setIdleTimeoutPref(stored);
      }
      idleTimeoutPref = stored;
    } else if (stored !== undefined) {
      logger.warn('collectMetrics: storage holds invalid sleepAfter value, ignoring', { stored });
    }
  } catch (err) {
    logger.warn('collectMetrics: failed to refresh idleTimeoutPref from storage', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const sleepMs = parseSleepAfterMs(idleTimeoutPref);

  try {
    const activityPort = ctx.container.getTcpPort(TERMINAL_SERVER_PORT);
    const activityRes = await activityPort.fetch('http://localhost/activity');
    if (!activityRes.ok) {
      logger.warn('collectMetrics: /activity returned non-OK', { status: activityRes.status });
    } else {
      const activity = await activityRes.json() as ActivityState;

      state.lastSeenInputAt = activity.lastInputAt;

      // Explicit idle-stop: stop the container when idle exceeds the
      // user-configured threshold. Fall back to containerStartedAt when
      // the user has never typed (lastInputAt null).
      const referenceTime = activity.lastInputAt ?? state.containerStartedAt;
      const idleMs = Date.now() - referenceTime;
      if (idleMs > sleepMs) {
        logger.info('collectMetrics: idle exceeded threshold, stopping', {
          idleMs, sleepMs, idleTimeoutPref, referenceTime, lastInputAt: activity.lastInputAt,
        });
        // Write KV status before stop — DO state can be lost during shutdown
        await updateKvStatus(ctx, env, state._bucketName, 'stopped', 'lastActiveAt');
        // Drain a final R2 sync while the container is still alive, before the
        // SIGTERM that the platform would otherwise cut off ~3s in
        // (REQ-SESSION-011). Best-effort, bounded to the 120s sync budget.
        await drainFinalSync(ctx, FINAL_SYNC_BUDGET_MS);
        await callbacks.stop('SIGTERM');
        return;
      }

      logger.info('collectMetrics: activity check', {
        lastInputAt: activity.lastInputAt,
        lastSeenInputAt: state.lastSeenInputAt,
        connectedClients: activity.connectedClients,
        hasActiveConnections: activity.hasActiveConnections,
        idleMs, sleepMs, idleTimeoutPref,
      });
    }
  } catch (err) {
    logger.warn('collectMetrics: activity check failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const tcpPort = ctx.container.getTcpPort(8080);
    const res = await tcpPort.fetch('http://localhost/health');

    if (!res.ok) {
      // Health endpoint returned non-200 (e.g. container still booting).
      // Don't parse — just log and re-arm below.
      logger.info('collectMetrics: health non-OK', { status: res.status });
    } else {
      const health = await res.json() as { cpu?: string; mem?: string; hdd?: string; syncStatus?: string };

      const sessionId = await ctx.storage.get<string>(SESSION_ID_KEY);
      // Fallback: if _bucketName isn't set on the instance, try loading from storage
      const bucketName = state._bucketName || await ctx.storage.get<string>('bucketName') || null;

      if (!sessionId || !bucketName) {
        logger.info('collectMetrics: missing identifiers, not re-arming (zombie DO)', { sessionId: !!sessionId, bucketName: !!bucketName });
        return; // Don't re-arm schedule — zombie DO, let it die
      } else if (ctx.container?.running) {
        // Only reached while the container is demonstrably running (running
        // branch, after a successful /health fetch). The normal write touches
        // .metrics and mirrors lastActiveAt; .status is normally left alone.
        const key = getSessionKey(bucketName, sessionId);
        const session = await env.KV.get<Session>(key, 'json');
        if (session) {
          const metrics = {
            cpu: health.cpu,
            mem: health.mem,
            hdd: health.hdd,
            syncStatus: health.syncStatus,
            updatedAt: new Date().toISOString(),
          };
          const lastActiveAt = state.lastSeenInputAt
            ? new Date(state.lastSeenInputAt).toISOString()
            : session.lastActiveAt;

          if (session.status === 'stopped') {
            // KV reads stopped while the container is demonstrably alive. Read
            // the PERSISTED deliberate-stop marker (survives a DO eviction that
            // would reset an in-memory flag) to disambiguate.
            const shutdownRequested = await ctx.storage.get<number>(SHUTDOWN_REQUESTED_KEY);
            if (typeof shutdownRequested === 'number') {
              // Deliberate stop in flight (destroy()/user Stop): leave the
              // stopped status to settle, skip the write so we don't resurrect a
              // session the user is deliberately stopping.
              logger.info('collectMetrics: session stopped with shutdown in flight, leaving stopped', { key });
            } else {
              // Self-heal a FALSE stopped (REQ-SESSION-018 AC4): the container is
              // alive, KV reads stopped, and no shutdown is in flight, so the
              // status was wrongly flipped (e.g. onError on a transient error, or
              // the catch-all racing a recovery). Re-assert running so a live
              // session is not left showing stopped on the dashboard until the
              // next start. (idle-stop returns before this block; onStop
              // deleteSchedules the loop, so those deliberate paths never reach here.)
              logger.warn('collectMetrics: container running but KV stopped, re-asserting running (self-heal)', { key });
              await putSessionWithMetadata(env.KV, key, { ...session, status: 'running' as const, metrics, lastActiveAt });
            }
          } else {
            await putSessionWithMetadata(env.KV, key, { ...session, metrics, lastActiveAt });
          }
        }
      }
    }
  } catch (err) {
    logger.warn('collectMetrics: fetch/write failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // Timekeeper usage ping (SaaS mode only)
  if (isSaasModeActive(env.SAAS_MODE)
      && state._bucketName
      && state._userEmail
      && env.TIMEKEEPER) {
    try {
      state._usageSeconds += 60;
      await ctx.storage.put('usageSeconds', state._usageSeconds);

      const tkId = env.TIMEKEEPER.idFromName(state._bucketName);
      const tk = env.TIMEKEEPER.get(tkId);
      const pingRes = await tk.fetch(new Request('http://timekeeper/ping', {
        method: 'POST',
        body: JSON.stringify({
          bucketName: state._bucketName,
          sessionId: state._sessionId,
          totalSeconds: state._usageSeconds,
          email: state._userEmail!,
        }),
        headers: { 'Content-Type': 'application/json' },
      }));

      if (pingRes.ok) {
        const { quotaExceeded } = await pingRes.json() as { quotaExceeded: boolean };
        if (quotaExceeded) {
          logger.warn('Quota exceeded — stopping container', { bucketName: state._bucketName });
          // Drain a final R2 sync while the container is still alive
          // (REQ-SESSION-011), then stop. Best-effort, bounded.
          await drainFinalSync(ctx, FINAL_SYNC_BUDGET_MS);
          await callbacks.stop('SIGTERM');
          return; // Don't re-arm after stop
        }
      }
    } catch (err) {
      // Non-fatal: log and continue — Timekeeper will catch up on next ping
      logger.warn('Timekeeper ping failed', { error: err instanceof Error ? err.message : String(err) });
    }
  } else {
    logger.info('Timekeeper ping skipped', {
      saasMode: isSaasModeActive(env.SAAS_MODE),
      bucketName: !!state._bucketName,
      userEmail: !!state._userEmail,
      timekeeper: !!env.TIMEKEEPER,
    });
  }

  // Re-arm only if still running. schedule() is one-shot — if we don't
  // re-arm, onStart() will restart the loop on next container start.
  if (ctx.container?.running) {
    try {
      await callbacks.schedule(60, 'collectMetrics');
    } catch {
      // DO is shutting down or destroyed
    }
  }
}
