/**
 * container-metrics — Metrics collection, idle detection, and Timekeeper pings.
 *
 * Extracted from Container DO (index.ts) to reduce file size.
 * All functions receive explicit state/context parameters instead of `this`.
 */
import type { DurableObjectState } from '@cloudflare/workers-types';
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

/** Callbacks provided by the Container class for SDK operations. */
export interface MetricsCallbacks {
  renewActivityTimeout: () => void;
  stop: (signal: number | string) => Promise<void>;
  schedule: (delaySec: number, method: string) => Promise<unknown>;
  parseSleepAfterMs: () => number;
  sleepAfter: string;
}

// ---------------------------------------------------------------------------
// parseSleepAfterMs
// ---------------------------------------------------------------------------

/** Parse sleepAfter string ('5m', '30m', '1h', '2h') to milliseconds. */
export function parseSleepAfterMs(s: string): number {
  if (s.endsWith('h')) return parseInt(s, 10) * 3_600_000;
  if (s.endsWith('m')) return parseInt(s, 10) * 60_000;
  return 300_000; // fallback 5 minutes
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
// collectMetrics
// ---------------------------------------------------------------------------

/**
 * Collect health metrics, detect idle state, ping Timekeeper, and re-arm the schedule.
 *
 * Mutates `state` (lastSeenInputAt, _usageSeconds) in place.
 */
export async function collectMetrics(
  state: MetricsState,
  ctx: DurableObjectState,
  env: Env,
  callbacks: MetricsCallbacks,
): Promise<void> {
  // Don't collect or re-arm if container process is dead.
  // onStart() will restart the schedule loop on next container start.
  if (!ctx.container?.running) {
    logger.info('collectMetrics: container not running, skipping');
    return;
  }

  // Keep-alive: renew sleepAfter only when new user input is detected.
  // User-input-based idle detection. super.fetch() resets the SDK's sleepAfter
  // timer on every proxied request (including WebSocket reconnects), so we cannot
  // rely on onActivityExpired() alone. Instead, collectMetrics() tracks real user
  // input and explicitly stops the container when idle exceeds sleepAfter duration.
  try {
    const activityPort = ctx.container.getTcpPort(TERMINAL_SERVER_PORT);
    const activityRes = await activityPort.fetch('http://localhost/activity');
    if (!activityRes.ok) {
      logger.warn('collectMetrics: /activity returned non-OK, NOT renewing', { status: activityRes.status });
    } else {
      const activity = await activityRes.json() as ActivityState;

      const hasNewInput = activity.lastInputAt !== null
        && activity.lastInputAt !== state.lastSeenInputAt;

      if (hasNewInput) {
        callbacks.renewActivityTimeout();
      }
      state.lastSeenInputAt = activity.lastInputAt;

      // Explicit idle-stop: check if idle duration exceeds sleepAfter.
      // super.fetch() resets the SDK timer on every HTTP request (including
      // WS reconnects), so onActivityExpired() may not fire for short timeouts.
      // Use containerStartedAt as fallback when user never typed (lastInputAt null).
      const referenceTime = activity.lastInputAt ?? state.containerStartedAt;
      const idleMs = Date.now() - referenceTime;
      const sleepMs = callbacks.parseSleepAfterMs();
      if (idleMs > sleepMs) {
        logger.info('collectMetrics: idle exceeded sleepAfter, stopping', {
          idleMs, sleepMs, referenceTime, lastInputAt: activity.lastInputAt,
        });
        // Write KV status before stop — DO state can be lost during shutdown
        await updateKvStatus(ctx, env, state._bucketName, 'stopped', 'lastActiveAt');
        await callbacks.stop('SIGTERM');
        return;
      }

      logger.info('collectMetrics: activity check', {
        renewed: hasNewInput,
        lastInputAt: activity.lastInputAt,
        lastSeenInputAt: state.lastSeenInputAt,
        connectedClients: activity.connectedClients,
        hasActiveConnections: activity.hasActiveConnections,
        idleMs, sleepMs, sleepAfter: callbacks.sleepAfter,
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
        // Only write metrics while container is running — prevents overwriting
        // a "stopped" status that onStop() may have written concurrently.
        // Read-modify-write only touches .metrics, never .status.
        const key = getSessionKey(bucketName, sessionId);
        const session = await env.KV.get<Session>(key, 'json');
        if (session) {
          const updated = {
            ...session,
            metrics: {
              cpu: health.cpu,
              mem: health.mem,
              hdd: health.hdd,
              syncStatus: health.syncStatus,
              updatedAt: new Date().toISOString(),
            },
            lastActiveAt: state.lastSeenInputAt
              ? new Date(state.lastSeenInputAt).toISOString()
              : session.lastActiveAt,
          };
          await putSessionWithMetadata(env.KV, key, updated);
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
