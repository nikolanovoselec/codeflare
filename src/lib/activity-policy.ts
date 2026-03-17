/**
 * Pure decision logic for container activity renewal.
 *
 * Both collectMetrics() and onActivityExpired() need to decide whether to
 * renew the container's activity timeout based on the same set of signals
 * (heartbeat freshness, input recency, grace period). This module extracts
 * that shared logic into a single pure function so the two call-sites
 * stay in sync.
 */

/** Heartbeat older than this is considered stale (5 minutes). */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

/** Input older than this means the user is idle (30 minutes). */
export const INPUT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Grace period after container start where missing input is tolerated (5 minutes). */
export const GRACE_PERIOD_MS = 5 * 60 * 1000;

/** The activity signals coming from the terminal server's /activity endpoint. */
export interface ActivityState {
  readonly hasActiveConnections: boolean;
  readonly connectedClients: number;
  /** undefined = old host (no heartbeat support), null = new host but no heartbeat yet, number = timestamp */
  readonly lastHeartbeatAt?: number | null;
  readonly lastInputAt: number | null;
}

/**
 * Outcome produced by evaluateActivity.  `renew` is the boolean both
 * call-sites branch on; the remaining fields are diagnostic context useful
 * for structured logging.
 */
export interface ActivityDecision {
  readonly renew: boolean;
  /** Which code-path was taken — handy for log messages. */
  readonly reason:
    | 'no-active-connections'
    | 'heartbeat-and-input-recent'
    | 'heartbeat-or-input-stale'
    | 'no-heartbeat-received'
    | 'legacy-input-recent'
    | 'legacy-input-stale';
  readonly heartbeatAgeMs: number | null;
  readonly inputIdleMs: number | null;
  readonly inGracePeriod: boolean;
  readonly inputRecent: boolean;
}

/**
 * Decide whether the container's activity timeout should be renewed.
 *
 * This is a **pure** function — no side effects, no I/O.  Both
 * `collectMetrics()` and `onActivityExpired()` call it with the same
 * shape of data and then act on the returned `renew` flag.
 *
 * Decision matrix:
 *  1. No active WebSocket connections → don't renew.
 *  2. New host (lastHeartbeatAt is a number):
 *     - Heartbeat recent AND input recent → renew.
 *     - Otherwise → don't renew.
 *  3. New host, no heartbeat ever (lastHeartbeatAt === null) → don't renew.
 *  4. Old host (lastHeartbeatAt === undefined):
 *     - Input recent → renew.
 *     - Otherwise → don't renew.
 *
 * "Input recent" means either:
 *   - lastInputAt is null AND we're still inside the grace period, OR
 *   - lastInputAt is within INPUT_IDLE_TIMEOUT_MS of `now`.
 */
export function evaluateActivity(
  activity: ActivityState,
  containerStartedAt: number,
  now: number,
): ActivityDecision {
  const lastInput = activity.lastInputAt;
  const inputIdleMs = lastInput !== null ? now - lastInput : null;
  const inGracePeriod = (now - containerStartedAt) <= GRACE_PERIOD_MS;
  const inputRecent =
    (lastInput === null && inGracePeriod) ||
    (lastInput !== null && inputIdleMs! <= INPUT_IDLE_TIMEOUT_MS);

  const base = { inputIdleMs, inGracePeriod, inputRecent };

  if (!activity.hasActiveConnections) {
    return {
      renew: false,
      reason: 'no-active-connections',
      heartbeatAgeMs: null,
      ...base,
    };
  }

  // New host with heartbeat support
  if (activity.lastHeartbeatAt !== undefined && activity.lastHeartbeatAt !== null) {
    const heartbeatAgeMs = now - activity.lastHeartbeatAt;
    const heartbeatRecent = heartbeatAgeMs <= HEARTBEAT_STALE_MS;

    if (heartbeatRecent && inputRecent) {
      return { renew: true, reason: 'heartbeat-and-input-recent', heartbeatAgeMs, ...base };
    }
    return { renew: false, reason: 'heartbeat-or-input-stale', heartbeatAgeMs, ...base };
  }

  // New host, no heartbeat ever received
  if (activity.lastHeartbeatAt === null) {
    return { renew: false, reason: 'no-heartbeat-received', heartbeatAgeMs: null, ...base };
  }

  // Old host (lastHeartbeatAt === undefined) — legacy input-based fallback
  if (inputRecent) {
    return { renew: true, reason: 'legacy-input-recent', heartbeatAgeMs: null, ...base };
  }
  return { renew: false, reason: 'legacy-input-stale', heartbeatAgeMs: null, ...base };
}
