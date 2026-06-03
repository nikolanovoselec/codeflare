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
  // when its monitor detects the container exited unexpectedly (crash,
  // deploy-roll, platform reap); it does NOT call onStop on that path, so
  // without this write the session dangles 'running' forever (codeflare#153).
  // Guard on !running so a transient startup port-check error (onError can
  // fire while the container is still coming up) cannot flip a live session
  // to 'stopped'; the collectMetrics not-running branch is the 60s catch-all
  // if this is skipped. No cross-await serialization is assumed: updateKvStatus
  // re-reads sessionId/bucketName from storage and the session from KV on
  // every call, and destroy() clears those first, so a post-destroy write
  // no-ops instead of resurrecting the record. onStart() re-asserts 'running'
  // on the next start.
  if (!host.ctx.container?.running) {
    await updateKvStatus(host.ctx, host.env, host._bucketName, 'stopped', 'lastActiveAt');
  }
}
