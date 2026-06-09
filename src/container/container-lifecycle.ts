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
  SHUTDOWN_REQUESTED_KEY,
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

// Teardown-path variant of drainFinalSync that RETURNS the outcome so destroy()
// can audit it. Unlike drainFinalSync it does NOT self-guard on
// ctx.container.running: that flag reads transiently false on a DO wake /
// deploy-roll while the container is alive (#516), and skipping the drain there
// silently drops the last edits on stop/delete. Attempt the drain regardless; a
// genuinely-dead container makes port.fetch error/timeout, which is swallowed
// and reported as 'errored' (still best-effort, still bounded by budgetMs).
async function drainFinalSyncAudited(host: LifecycleHost, budgetMs: number): Promise<FinalSyncOutcome> {
  if (!host.ctx.container?.running) {
    // We still attempt: a not-running reading at the start is worth recording as
    // the likely transient the #516 fix exists to survive.
    host.logger.warn('Final sync attempted while container reads not-running (possible transient)', { budgetMs });
  }
  try {
    const port = host.ctx.container?.getTcpPort(8080);
    if (!port) return 'errored';
    const res = await port.fetch('http://localhost/internal/final-sync', {
      method: 'POST',
      signal: AbortSignal.timeout(budgetMs),
    });
    return res.ok ? 'completed' : 'incomplete';
  } catch {
    return 'errored';
  }
}

// Replace the silent swallow with a durable audit event (#516): persist the
// outcome under FINAL_SYNC_AUDIT_KEY (same durable store SHUTDOWN_REQUESTED_KEY
// uses, so it survives the destroy and is observable by a later incarnation /
// tests) and log it (info on success, warn otherwise).
async function recordFinalSyncAudit(host: LifecycleHost, outcome: FinalSyncOutcome): Promise<void> {
  const event = { outcome, at: Date.now(), running: host.ctx.container?.running ?? false };
  if (outcome === 'completed') {
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
  host.logger.info('Destroying container, clearing operational storage');
  // Persist the deliberate-stop marker and drop the metrics alarm BEFORE
  // clearing identifiers. If a DO eviction interrupts this teardown, the
  // reconstructed instance (which resets in-memory fields to 0) still reads the
  // persisted marker, so the surviving collectMetrics alarm cannot self-heal a
  // session the user is deliberately stopping back to running (REQ-SESSION-018
  // AC4). onStart() clears the marker on the next fresh start.
  try { await host.ctx.storage.put(SHUTDOWN_REQUESTED_KEY, Date.now()); } catch { /* storage racing teardown */ }
  try { host.deleteSchedules('collectMetrics'); } catch { /* no-op if table empty */ }
  try {
    await host.ctx.storage.delete(SESSION_ID_KEY);
    await host.ctx.storage.delete('bucketName');
    await host.ctx.storage.delete('workspaceSyncEnabled');
    await host.ctx.storage.delete('fastStartEnabled');
    await host.ctx.storage.delete('tabConfig');
    await host.ctx.storage.delete('sleepAfter');
    // Drop the persisted auth token: the next session under this DO ID will
    // be a different container instance with a fresh token, so reusing the
    // old one would let an unrelated request out of a previous lifecycle
    // authenticate against the new container.
    await host.ctx.storage.delete('containerAuthToken');
    // REQ-VAULT-008 AC1: wipe the vault key so deletion is
    // forward-secret. The browser's IDB ciphertext (if not yet
    // cleaned by the frontend lifecycle hook) becomes permanently
    // unrecoverable once this delete commits.
    await host.ctx.storage.delete('vaultKey');
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
  host._shutdownStartedAt = Date.now();
  const hardKillMs = 135_000;
  const warnThresholdMs = 110_000;
  const pollMs = 250;
  const start = host._shutdownStartedAt;
  let warned = false;

  // Authoritative final sync (bounded). Best-effort: the drain swallows
  // failure/timeout so we always fall through to stop. Emit a durable audit
  // event recording the outcome so a skipped/failed final sync on delete is
  // never silent (#516).
  const syncOutcome = await drainFinalSyncAudited(host, Math.min(FINAL_SYNC_BUDGET_MS, hardKillMs - (Date.now() - start)));
  await recordFinalSyncAudit(host, syncOutcome);

  if (host.ctx.container?.running) {
    try {
      await host.stop('SIGTERM');
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

  return host.superDestroy();
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
  host.logger.error('Container error', error instanceof Error ? error : new Error(toErrorMessage(error)));
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
  // restart. So onError no longer writes 'stopped' itself. On a not-running
  // reading it opens the SAME confirmation window collectMetrics uses and
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
