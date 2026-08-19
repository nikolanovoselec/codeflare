/**
 * container-lifecycle - Lifecycle hook logic for the Container DO.
 *
 * Extracted from index.ts (CF-012). Holds the bodies of onStart, collectMetrics,
 * destroy, onStop, and onError. The thin DO class in index.ts implements the
 * SDK-required method signatures and delegates to these functions, passing
 * itself (plus a small set of capability callbacks for stop/schedule/
 * deleteSchedules/super.destroy that are SDK-provided methods, not plain state).
 *
 * See the CONTAINER LIFECYCLE + KV STATUS CONTRACT block in index.ts for the
 * canonical description of when the SDK invokes each hook.
 */
import { toError, toErrorMessage } from '../lib/error-types';
import { updateEnvVars, type ContainerHost } from './container-config';
import {
  collectMetrics as doCollectMetrics,
  updateKvStatus,
  openNotRunningConfirmation,
  beginMonitorTransportRecovery,
  SHUTDOWN_REQUESTED_KEY,
  TRANSPORT_FAILURE_STREAK_KEY,
  TRANSPORT_RECOVERY_KEY,
  FINAL_SYNC_BUDGET_MS,
  type MetricsState,
  type MetricsCallbacks,
} from './container-metrics';

const SESSION_ID_KEY = '_sessionId';

/**
 * SDK-provided method capabilities the lifecycle hooks need beyond plain state.
 * These are real methods on the Container superclass (stop/schedule/
 * deleteSchedules) or the superclass override (superDestroy), so they are
 * passed as callbacks rather than reached through the host's data fields.
 */
export interface LifecycleHost extends ContainerHost {
  /** Lifecycle-only mutable fields not already declared on ContainerHost. */
  containerStartedAt: number;
  lastSeenInputAt: number | null;
  _usageSeconds: number;
  _shutdownStartedAt: number;

  stop(signal: number | string): Promise<void>;
  schedule(delaySec: number, method: string): Promise<unknown>;
  deleteSchedules(method: string): void;
  /** Calls super.destroy() on the DO class (SDK teardown). */
  superDestroy(): Promise<void>;
}

/** Called when the container starts successfully. */
export async function onStart(host: LifecycleHost): Promise<void> {
  host.containerStartedAt = Date.now();
  // A fresh start means no deliberate stop is in flight: clear any stale
  // shutdown marker a prior destroy() left in storage, so a later transient
  // false-stopped on this run can self-heal (REQ-SESSION-018 AC4).
  try { await host.ctx.storage.delete(SHUTDOWN_REQUESTED_KEY); } catch { /* best-effort */ }
  // Recovery residue is one startup prerequisite. A batch delete prevents a
  // partial clear, and a failure leaves metrics unarmed rather than letting the
  // new lifecycle inherit an exhausted record or a near-abort failure streak.
  await host.ctx.storage.delete([TRANSPORT_FAILURE_STREAK_KEY, TRANSPORT_RECOVERY_KEY]);
  updateEnvVars(host);
  await updateKvStatus(host.ctx, host.env, host._bucketName, 'running', 'lastStartedAt');
  // Also set lastActiveAt to start time so the frontend timer icon
  // has a reference timestamp even before any user input occurs.
  await updateKvStatus(host.ctx, host.env, host._bucketName, null, 'lastActiveAt');
  host.logger.info('Container started');
  // Clear any stale schedule rows from previous runs before arming fresh
  try { host.deleteSchedules('collectMetrics'); } catch { /* no-op if table empty */ }
  await host.schedule(60, 'collectMetrics');
}

export async function collectMetrics(host: LifecycleHost): Promise<void> {
  const callbacks: MetricsCallbacks = {
    stop: (signal: number | string) => host.stop(signal as number),
    schedule: (delaySec: number, method: string) => host.schedule(delaySec, method) as Promise<unknown>,
    idleTimeoutPref: host.idleTimeoutPref,
    setIdleTimeoutPref: (next: string) => { host.idleTimeoutPref = next; },
  };
  await doCollectMetrics(host as unknown as MetricsState, host.ctx, host.env, callbacks);
}

// Durable audit of the final-sync outcome on teardown (#516). Persisted to DO
// storage (survives the destroy) AND logged, so a drain that is skipped or fails
// on a stop/delete is never silent. The collectMetrics drain callers keep using
// the plain best-effort drainFinalSync; only the teardown path audits.
const FINAL_SYNC_AUDIT_KEY = 'finalSyncAudit';
type FinalSyncOutcome = 'completed' | 'incomplete' | 'errored';
// Outcome plus the observable detail (HTTP status + the host's reason string) so
// a non-completed final sync is queryable post-mortem. The budget-inversion 504
// surfaces as { outcome:'incomplete', httpStatus:504, reason:'timeout' }.
type FinalSyncResult = { outcome: FinalSyncOutcome; httpStatus?: number; reason?: string };

// Teardown-path variant of drainFinalSync that RETURNS the outcome so destroy()
// can audit it. Unlike drainFinalSync it does NOT self-guard on
// ctx.container.running: that flag reads transiently false on a DO wake /
// deploy-roll while the container is alive (#516), and skipping the drain there
// silently drops the last edits on stop/delete. Attempt the drain regardless; a
// genuinely-dead container makes port.fetch error/timeout, which is swallowed
// and reported as 'errored' (still best-effort, still bounded by budgetMs).
async function drainFinalSyncAudited(host: LifecycleHost, budgetMs: number, authToken: string | null): Promise<FinalSyncResult> {
  if (!authToken) return { outcome: 'errored', reason: 'missing-auth-token' };
  if (budgetMs <= 0) return { outcome: 'errored', reason: 'teardown-deadline-exhausted' };
  if (!host.ctx.container?.running) {
    // We still attempt: a not-running reading at the start is worth recording as
    // the likely transient the #516 fix exists to survive.
    host.logger.warn('Final sync attempted while container reads not-running (possible transient)', { budgetMs });
  }
  try {
    const port = host.ctx.container?.getTcpPort(8080);
    if (!port) return { outcome: 'errored', reason: 'no-container-port' };
    // The Authorization header is load-bearing: this raw port.fetch bypasses the
    // DO's public fetch override (the only place the auth header is injected),
    // and the in-container host 401s any /internal/* request without a Bearer
    // token (auth-check.ts exempts only /health and /activity). Without it every
    // teardown drain died at the auth gate in ~100ms - observed as 30 days of
    // outcome:incomplete httpStatus:401 audits with zero successes, i.e. the
    // actual bisync-on-delete data loss (the budget inversion fixed in #521 was
    // real but unreachable behind this 401).
    const res = await port.fetch('http://localhost/internal/final-sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(budgetMs),
    });
    // The host reports its own reason in the body ({ synced, reason }); capture
    // it for the audit so a 504/'timeout' or 'bisync-failed' is distinguishable.
    let reason: string | undefined;
    try { reason = ((await res.json()) as { reason?: string }).reason; } catch { /* body may be empty */ }
    return { outcome: res.ok ? 'completed' : 'incomplete', httpStatus: res.status, reason };
  } catch (err) {
    return { outcome: 'errored', reason: toError(err).message };
  }
}

// Replace the silent swallow with a durable audit event (#516): persist the
// outcome under FINAL_SYNC_AUDIT_KEY (same durable store SHUTDOWN_REQUESTED_KEY
// uses, so it survives the destroy and is observable by a later incarnation /
// tests) and log it (info on success, warn otherwise).
async function recordFinalSyncAudit(host: LifecycleHost, result: FinalSyncResult, sessionId: string | null): Promise<void> {
  // sessionId is captured by destroy() before the storage-clear nulls it, so a
  // non-completed final sync stays correlatable to the deleted session in logs.
  const event: {
    outcome: FinalSyncOutcome; at: number; running: boolean;
    sessionId?: string; httpStatus?: number; reason?: string;
  } = { outcome: result.outcome, at: Date.now(), running: host.ctx.container?.running ?? false };
  if (sessionId) event.sessionId = sessionId;
  if (result.httpStatus !== undefined) event.httpStatus = result.httpStatus;
  if (result.reason) event.reason = result.reason;
  if (result.outcome === 'completed') {
    host.logger.info('Final sync audit (teardown)', event);
  } else {
    host.logger.warn('Final sync did NOT complete on teardown', event);
  }
  try { await host.ctx.storage.put(FINAL_SYNC_AUDIT_KEY, event); } catch { /* storage racing teardown */ }
}

/**
 * Override destroy to drain a final R2 bisync while the container is still
 * running, BEFORE signalling stop (REQ-SESSION-011) - the platform SIGKILLs the
 * container ~3s after stop, far short of a bisync, so the entrypoint trap that
 * used to run the final sync is now only a best-effort backstop. Storage
 * identifiers are cleared first so any onStop() racing the exit cannot
 * resurrect the KV entry (REQ-SESSION-009).
 */
export async function destroy(host: LifecycleHost): Promise<void> {
  const hardKillMs = 135_000;
  host._shutdownStartedAt = Date.now();
  const start = host._shutdownStartedAt;
  const withinDeadline = async <T>(operation: Promise<T>): Promise<T> => {
    const remaining = hardKillMs - (Date.now() - start);
    if (remaining <= 0) throw new Error('teardown deadline exceeded');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error('teardown deadline exceeded')), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  host.logger.info('Destroying container, clearing operational storage');
  // Capture the session id BEFORE the storage-clear below nulls host._sessionId,
  // so the final-sync audit (recorded after the drain) stays correlatable.
  const auditSessionId = host._sessionId;
  // Capture the container auth token BEFORE the clear deletes it from storage
  // and nulls the in-memory copy: the final-sync drain runs AFTER the clear and
  // must authenticate against the in-container host or it 401s and the session
  // deletes with the last edits unsynced. Storage fallback covers a DO that was
  // re-created for this delete and never hydrated the in-memory field.
  let auditAuthToken: string | null = host._containerAuthToken;
  if (!auditAuthToken) {
    try { auditAuthToken = (await withinDeadline(host.ctx.storage.get<string>('containerAuthToken'))) ?? null; } catch { auditAuthToken = null; }
  }
  // Persist the deliberate-stop marker and drop the metrics alarm BEFORE
  // clearing identifiers. If a DO eviction interrupts this teardown, the
  // reconstructed instance (which resets in-memory fields to 0) still reads the
  // persisted marker, so the surviving collectMetrics alarm cannot self-heal a
  // session the user is deliberately stopping back to running (REQ-SESSION-018
  // AC4). onStart() clears the marker on the next fresh start.
  try { await withinDeadline(host.ctx.storage.put(SHUTDOWN_REQUESTED_KEY, Date.now())); } catch { /* storage racing teardown */ }
  // Record the stop while the identifiers that write still needs are in hand.
  // onStop() cannot: the clear below nulls _bucketName, so its updateKvStatus
  // hits the missing-identifiers guard and writes nothing, leaving a torn-down
  // session recorded as running. That is not cosmetic -- the terminal upgrade's
  // authoritative 4503 gate reads exactly this field, so the record staying
  // 'running' is what drops reconnects onto the forward path instead of telling
  // the client to stop. Observed in prod 2026-07-27: a teardown that overran its
  // budget and was SIGKILLed left the session 'running' and the tab retried it
  // about once a second for 20+ minutes.
  //
  // Ordered AFTER the marker put above, not before it: a KV await is not a DO
  // storage op, so the input gate does not hold off alarm delivery across it. A
  // collectMetrics tick landing in that window would read KV 'stopped' with no
  // marker yet persisted, take the self-heal branch, and re-assert 'running' --
  // undoing exactly what this write exists to do.
  //
  // Safe on both callers: the delete route deletes the record after destroy()
  // returns, so this write is superseded rather than resurrecting anything
  // (REQ-SESSION-009), and the stop route already wrote the same value before
  // calling in. Best-effort, like every other step of teardown.
  try {
    await withinDeadline(updateKvStatus(host.ctx, host.env, host._bucketName, 'stopped', 'lastActiveAt'));
  } catch { /* teardown proceeds regardless */ }
  try { host.deleteSchedules('collectMetrics'); } catch { /* no-op if table empty */ }
  // Recovery residue must not survive teardown even when another operational
  // key deletion fails below.
  try { await withinDeadline(host.ctx.storage.delete(TRANSPORT_RECOVERY_KEY)); } catch { /* best-effort */ }
  try {
    await withinDeadline(Promise.all([
      host.ctx.storage.delete(SESSION_ID_KEY),
      host.ctx.storage.delete('bucketName'),
      host.ctx.storage.delete('workspaceSyncEnabled'),
      host.ctx.storage.delete('fastStartEnabled'),
      host.ctx.storage.delete('tabConfig'),
      host.ctx.storage.delete('sleepAfter'),
      host.ctx.storage.delete(TRANSPORT_FAILURE_STREAK_KEY),
      // Drop auth and vault keys before the next lifecycle can reuse this DO.
      host.ctx.storage.delete('containerAuthToken'),
      host.ctx.storage.delete('vaultKey'),
    ]));
    host._bucketName = null;
    host._sessionId = null;
    host._r2AccessKeyId = null;
    host._r2SecretAccessKey = null;
    host._containerAuthToken = null;
    host._vaultKey = null;
    host._openaiApiKey = null;
    host._geminiApiKey = null;
    host._githubToken = null;
    host._cloudflareApiToken = null;
    host._cloudflareAccountId = null;
    host._encryptionKey = null;
    host._remoteCurationActive = false;
    host._remoteCurationReleaseDigest = null;
    host._sessionMode = 'default';
    host.logger.info('Operational storage cleared');
  } catch (err) {
    host.logger.error('Failed to clear storage', toError(err));
  }

  // REQ-SESSION-011 + #516: ALWAYS attempt the final drain on a deliberate
  // stop/delete, even when ctx.container.running reads transiently false (a DO
  // wake / deploy-roll can report false while the container is alive - the same
  // transient NOT_RUNNING_CONFIRM_MS guards in collectMetrics). Skipping the
  // drain on that transient silently lost the last edits on delete (#516). The
  // drain is best-effort and bounded; a genuinely-dead container errors out fast
  // and is swallowed. The teardown clock starts here so the 135s hard force-kill
  // ceiling spans the whole drain-then-stop sequence: 120s sync budget + 15s for
  // the actual stop. The old design relied on the entrypoint's SIGTERM trap to
  // run the final bisync, but the platform kills the container ~3s after SIGTERM
  // - far short of a bisync that can take up to ~2min under the 15-min cadence
  // (AD56) - so the trap was cut off and the last edits never reached R2 (data
  // loss on stop/delete). Syncing here removes the kill-grace dependency; the
  // trap remains a best-effort backstop. See AD57.
  const warnThresholdMs = 110_000;
  const pollMs = 250;
  let warned = false;

  // Authoritative final sync (bounded). Best-effort: the drain swallows
  // failure/timeout so we always fall through to stop. Emit a durable audit
  // event recording the outcome so a skipped/failed final sync on delete is
  // never silent (#516).
  let syncResult: FinalSyncResult;
  try {
    syncResult = await withinDeadline(drainFinalSyncAudited(
      host,
      Math.max(1, Math.min(FINAL_SYNC_BUDGET_MS, hardKillMs - (Date.now() - start))),
      auditAuthToken,
    ));
  } catch (err) {
    syncResult = { outcome: 'errored', reason: toError(err).message };
  }
  try {
    await withinDeadline(recordFinalSyncAudit(host, syncResult, auditSessionId));
  } catch (err) {
    host.logger.warn('Final sync audit exceeded teardown deadline', { error: toError(err).message });
  }

  if (host.ctx.container?.running) {
    try {
      await withinDeadline(host.stop('SIGTERM'));
      while (host.ctx.container?.running && Date.now() - start < hardKillMs) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (!warned && Date.now() - start >= warnThresholdMs) {
          warned = true;
          host.logger.warn('Shutdown approaching budget ceiling', {
            elapsedMs: Date.now() - start,
            budgetMs: hardKillMs,
            warnThresholdMs,
          });
        }
      }
      const elapsed = Date.now() - start;
      if (host.ctx.container?.running) {
        host.logger.warn('Graceful shutdown timeout, escalating to SIGKILL', { timeoutMs: hardKillMs, elapsed });
      } else {
        host.logger.info('Graceful shutdown complete', { elapsed });
      }
    } catch (err) {
      host.logger.warn('Graceful shutdown failed, falling back to SIGKILL', { error: toError(err).message });
    }
  }

  // Dispatch the SDK's force-destroy even when earlier stages consumed the
  // entire budget. When time remains, bound the await to that same deadline;
  // when it does not, observe the promise in the background so a later provider
  // rejection is handled, then reject the teardown as unconfirmed.
  const superDestroyPromise = host.superDestroy();
  const remaining = hardKillMs - (Date.now() - start);
  if (remaining <= 0) {
    void superDestroyPromise.catch((err) => {
      host.logger.warn('Forced destroy failed after teardown deadline', { error: toError(err).message });
    });
    const deadlineError = new Error('teardown deadline exceeded');
    host.logger.warn('Forced destroy failed or exceeded teardown deadline', { error: deadlineError.message });
    throw deadlineError;
  }
  try {
    await withinDeadline(superDestroyPromise);
  } catch (err) {
    host.logger.warn('Forced destroy failed or exceeded teardown deadline', { error: toError(err).message });
    throw err;
  }
}

/** Called when the container stops. */
export async function onStop(host: LifecycleHost): Promise<void> {
  // Kill the collectMetrics alarm loop - without this, the schedule
  // continues firing on a dead container indefinitely (zombie alarms).
  try { host.deleteSchedules('collectMetrics'); } catch { /* no-op if table empty */ }
  const shutdownElapsedMs = host._shutdownStartedAt > 0 ? Date.now() - host._shutdownStartedAt : null;
  host.logger.info('Container stopped', { shutdownElapsedMs });
  await updateKvStatus(host.ctx, host.env, host._bucketName, 'stopped', 'lastActiveAt');
}

/** Called when the container encounters an error. */
export async function onError(host: LifecycleHost, error: unknown): Promise<void> {
  const errorMessage = toErrorMessage(error);
  host.logger.error('Container error', error instanceof Error ? error : new Error(errorMessage));

  // The Containers SDK already aborts its Durable Object when this exact
  // container-services failure occurs during startup. Its monitor path instead
  // marks private SDK state stopped and invokes onError, which makes the
  // running-only watchdog miss the same recovery opportunity. Persist and arm
  // the existing bounded incident before reconstructing the coordinator.
  if (errorMessage.toLowerCase().includes('network connection lost')) {
    const recovery = await beginMonitorTransportRecovery(
      host.ctx,
      async () => {
        try { host.deleteSchedules('collectMetrics'); } catch { /* no-op if table empty */ }
        return await host.schedule(5, 'collectMetrics');
      },
    );
    if (recovery !== 'fallback') return;
  }
  // The SDK (@cloudflare/containers v0.3.5) calls onError - and awaits it -
  // when its monitor flags the container as exited (crash, deploy-roll,
  // platform reap); it does NOT call onStop on that path, so without a write
  // here the session could dangle 'running' forever (codeflare#153). But onError
  // ALSO fires on TRANSIENT errors where the container is actually alive (a
  // deploy-roll the container survives, a brief monitor blip): observed in prod
  // a spurious "Container error" fired onError on a live Pi session, the
  // !running guard passed on a momentary false reading, and an immediate
  // 'stopped' write then stuck - the collectMetrics clobber guard refused to
  // correct it and the session hung falsely-stopped for ~14 min until a real
  // restart. So onError no longer writes 'stopped' itself. Monitor-side network
  // loss first enters bounded coordinator reconstruction above; other not-running
  // errors, and exhausted monitor recovery, open the SAME confirmation window
  // collectMetrics uses and
  // re-arms a single tick (deleteSchedules first so onError can't stack a
  // duplicate alarm onto a still-armed loop), delegating the stopped decision
  // to that window: a container that stays down is confirmed stopped within
  // NOT_RUNNING_CONFIRM_MS, and one that recovers clears the window with no
  // false stopped (REQ-SESSION-018 AC3). openNotRunningConfirmation only writes
  // DO storage, never KV, so a post-destroy onError cannot resurrect the record;
  // the re-armed tick bails as a zombie DO once destroy() has cleared the
  // identifiers. onStart() re-asserts 'running' on the next start.
  if (!host.ctx.container?.running) {
    await openNotRunningConfirmation(host.ctx);
    try { host.deleteSchedules('collectMetrics'); } catch { /* no-op if table empty */ }
    await host.schedule(60, 'collectMetrics');
  }
}
