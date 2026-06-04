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

/**
 * Override destroy to do a graceful SIGTERM shutdown so the entrypoint trap
 * runs final R2 bisync (REQ-SESSION-011) before SDK teardown SIGKILLs the
 * container. Storage identifiers are cleared first so any onStop() racing
 * with the trap-driven exit cannot resurrect the KV entry (REQ-SESSION-009).
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

  if (host.ctx.container?.running) {
    // 135s = 120s budget for the entrypoint's final bisync (set in
    // entrypoint.sh:shutdown_handler) plus a 15s buffer for clean
    // process exit. Budget history: 25_000 (original) -> 75_000
    // (vault rollout: vault edits in the last seconds were silently
    // truncated when the SDK SIGKILLed mid-bisync) -> 135_000 (this
    // change, alongside the 15-min cadence). Under the 15-min
    // cadence (AD56) a single final bisync can accumulate more
    // changes than under the old 60s cadence, so the watchdog at
    // the entrypoint layer needed 120s; the DO budget tracks that
    // plus the same 15s clean-exit buffer. See AD57.
    host._shutdownStartedAt = Date.now();
    const timeoutMs = 135_000;
    const warnThresholdMs = 110_000;
    const pollMs = 250;
    const start = host._shutdownStartedAt;
    let warned = false;
    try {
      await host.stop('SIGTERM');
      while (host.ctx.container?.running && Date.now() - start < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (!warned && Date.now() - start >= warnThresholdMs) {
          warned = true;
          host.logger.warn('Shutdown approaching budget ceiling', {
            elapsedMs: Date.now() - start,
            budgetMs: timeoutMs,
            warnThresholdMs,
          });
        }
      }
      const elapsed = Date.now() - start;
      if (host.ctx.container?.running) {
        host.logger.warn('Graceful shutdown timeout, escalating to SIGKILL', { timeoutMs, elapsed });
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
