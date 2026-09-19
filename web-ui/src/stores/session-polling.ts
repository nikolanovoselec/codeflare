import * as api from '../api/client';
import { ApiError } from '../api/fetch-helper';
import { terminalStore } from './terminal';
import { logger } from '../lib/logger';
import { SESSION_POLL_STABLE_MS, SESSION_POLL_TRANSITION_MS } from '../lib/constants';
import { updateStatsFromBatch } from './storage';
import { setUsageState } from './session-usage';
import type { SessionWithStatus, SessionStatus } from '../types';
// Type-only imports - erased at runtime, so they do NOT reintroduce the
// circular dependency that the registerPollingDeps DI pattern guards against.
import type { SessionState, SessionMetrics } from './session';
import type { ManagedReleaseProgress } from '../api/client';

/**
 * Session List Polling - extracted from session.ts (CF-013).
 *
 * Handles background batch-status polling:
 *  - Lightweight status refresh (no loading flicker)
 *  - Consecutive-miss tracking for stale session removal
 *  - Auth-expiry detection (401 → stop polling)
 *
 * Uses dependency injection (registerPollingDeps) to access the session
 * store's state/setState without circular imports.
 */

// ============================================================================
// Dependency injection
// ============================================================================

/** Minimal view of SessionState needed by polling logic */
interface PollingStateView {
  sessions: SessionWithStatus[];
  activeSessionId: string | null;
  sessionMetrics: Record<string, SessionMetrics>;
  managedReleaseStatus: 'current' | 'upgrading' | 'update_pending' | null;
  bucketMigrating: boolean;
  bucketMigrationPending: boolean;
}

type StateGetter = () => PollingStateView;
type ProduceSetter = (fn: (s: SessionState) => void) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawSetter = (...args: any[]) => void;
type StatusUpdater = (id: string, status: SessionStatus) => void;
type InitChecker = (id: string) => boolean;
type NegativeKvGuard = (id: string) => boolean;
type AuthExpiredSetter = (expired: boolean) => void;
type MetricsUpdater = (
  sessionMetrics: Record<string, SessionMetrics>,
  sessionId: string,
  metrics: { cpu?: string; mem?: string; hdd?: string; syncStatus?: string },
) => void;

let getState: StateGetter;
let setStateProduce: ProduceSetter;
let setStateRaw: RawSetter;
let updateSessionStatusFn: StatusUpdater;
let isSessionInitializingFn: InitChecker;
let shouldRetainNegativeKvFn: NegativeKvGuard;
let setAuthExpiredFn: AuthExpiredSetter;
let applyMetricsUpdateFn: MetricsUpdater;
let applyManagedReleaseBatchFn: (status: 'current' | 'upgrading' | 'update_pending' | undefined, needsUpgrade: boolean | undefined, progress?: ManagedReleaseProgress, target?: string) => void;

export function registerPollingDeps(deps: {
  getState: StateGetter;
  setStateProduce: ProduceSetter;
  setStateRaw: RawSetter;
  updateSessionStatus: StatusUpdater;
  isSessionInitializing: InitChecker;
  shouldRetainNegativeKv: NegativeKvGuard;
  setAuthExpired: AuthExpiredSetter;
  applyMetricsUpdate: MetricsUpdater;
  applyManagedReleaseBatch: (status: 'current' | 'upgrading' | 'update_pending' | undefined, needsUpgrade: boolean | undefined, progress?: ManagedReleaseProgress, target?: string) => void;
}): void {
  getState = deps.getState;
  setStateProduce = deps.setStateProduce;
  setStateRaw = deps.setStateRaw;
  updateSessionStatusFn = deps.updateSessionStatus;
  isSessionInitializingFn = deps.isSessionInitializing;
  shouldRetainNegativeKvFn = deps.shouldRetainNegativeKv;
  setAuthExpiredFn = deps.setAuthExpired;
  applyMetricsUpdateFn = deps.applyMetricsUpdate;
  applyManagedReleaseBatchFn = deps.applyManagedReleaseBatch;
}

// ============================================================================
// Startup guard - protect recently-started sessions from stale KV 'stopped'
// ============================================================================

/** Timestamp when each session first reached 'running' status. */
const sessionStartedAt = new Map<string, number>();

/** How long to protect a session from stale KV 'stopped' after it starts running. */
const STARTUP_GUARD_MS = 3 * 60 * 1000; // 3 minutes

/** Record that a session started running (called from status update path). */
export function markSessionStarted(sessionId: string): void {
  if (!sessionStartedAt.has(sessionId)) {
    sessionStartedAt.set(sessionId, Date.now());
  }
}

/** Clear the startup guard for a session (called on dispose/manual stop). */
export function clearSessionStartedGuard(sessionId: string): void {
  sessionStartedAt.delete(sessionId);
}

/** Check if a session is within the startup protection window. */
export function isWithinStartupGuard(sessionId: string): boolean {
  const startedAt = sessionStartedAt.get(sessionId);
  if (!startedAt) return false;
  if (Date.now() - startedAt < STARTUP_GUARD_MS) return true;
  // Guard expired - clean up
  sessionStartedAt.delete(sessionId);
  return false;
}

/** Test-only: clear process-local startup guards between cases. */
export function resetStartupGuards(): void {
  sessionStartedAt.clear();
}

// ============================================================================
// Consecutive-miss tracking
// ============================================================================

export const sessionMissCounters = new Map<string, number>();
const REMOVAL_THRESHOLD = 3;

// ============================================================================
// Recursive poll handle
// ============================================================================

let sessionListPollTimeout: ReturnType<typeof setTimeout> | null = null;
let pollingActive = false;
let visibilityListenerInstalled = false;
let pollInFlight: Promise<void> | null = null;

// ============================================================================
// refreshSessionStatuses
// ============================================================================

const ANCILLARY_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let lastAncillaryCheckAt = 0;
let ancillaryCheckInFlight: Promise<void> | null = null;

/** Test-only: clear the ancillary probe window and in-flight request. */
export function resetManagedCheckState(): void {
  lastAncillaryCheckAt = 0;
  ancillaryCheckInFlight = null;
}

export function refreshSessionAncillaryStatus(): Promise<void> {
  if (ancillaryCheckInFlight) return ancillaryCheckInFlight;
  ancillaryCheckInFlight = api.getSessionAncillaryStatus().then((response) => {
    lastAncillaryCheckAt = Date.now();
    setStateRaw('maxSessions', response.maxSessions);
    if (response.storageStats) updateStatsFromBatch(response.storageStats);
    if (response.usage) setUsageState(response.usage.monthlySeconds, response.usage.monthlyQuotaSeconds);
    if (response.managedReleaseStatus !== undefined || response.preseedNeedsUpgrade !== undefined) {
      applyManagedReleaseBatchFn(response.managedReleaseStatus, response.preseedNeedsUpgrade, response.managedReleaseProgress, response.preseedUpgradeTarget);
    }
    setStateRaw('bucketMigrating', response.bucketMigrating === true);
    setStateRaw('bucketMigrationPending', response.bucketMigrationPending === true);
    setStateRaw('bucketMigrationPercent', response.bucketMigrationPercent ?? null);
  }).finally(() => { ancillaryCheckInFlight = null; });
  return ancillaryCheckInFlight;
}

/**
 * Lightweight status refresh - only fetches batch-status and updates
 * existing session statuses in-place. Does NOT replace the sessions
 * array or set loading state, so the dashboard doesn't flicker.
 * Also updates storage stats when storageStats is present in the batch response.
 */
export async function refreshSessionStatuses(forceManagedReleaseCheck = false): Promise<void> {
  try {
    const state = getState();
    const batchResponse = await api.getBatchSessionStatus();
    const batchStatuses = batchResponse.statuses;
    const ancillaryDue = forceManagedReleaseCheck
      || state.managedReleaseStatus === 'upgrading'
      || state.bucketMigrating
      || state.bucketMigrationPending
      || Date.now() - lastAncillaryCheckAt >= ANCILLARY_CHECK_INTERVAL_MS;
    if (ancillaryDue) await refreshSessionAncillaryStatus().catch(() => undefined);

    // Consecutive-miss tracking: only remove sessions after REMOVAL_THRESHOLD misses.
    // Skip initializing sessions - they may not appear in batch status yet.
    const removedIds: string[] = [];
    for (const session of state.sessions) {
      if (!batchStatuses[session.id]) {
        if (shouldRetainNegativeKvFn(session.id)) {
          sessionMissCounters.delete(session.id);
          continue;
        }
        const count = (sessionMissCounters.get(session.id) || 0) + 1;
        sessionMissCounters.set(session.id, count);
        if (count >= REMOVAL_THRESHOLD) {
          removedIds.push(session.id);
        }
      } else {
        sessionMissCounters.delete(session.id);
      }
    }
    if (removedIds.length > 0) {
      for (const id of removedIds) {
        sessionMissCounters.delete(id);
      }
      setStateProduce((s: SessionState) => {
        s.sessions = s.sessions.filter((sess: SessionWithStatus) => !removedIds.includes(sess.id));
      });
    }
    for (const session of getState().sessions) {
      const remote = batchStatuses[session.id];
      if (!remote) continue;

      // Propagate per-session fields from batch-status onto SessionWithStatus.
      // ptyActive/startupStage are frontend-only mirrors of the latest poll -
      // consumers (e.g. Layout vault-button gate) read them off the session.
      const idx = getState().sessions.findIndex(s => s.id === session.id);
      if (idx !== -1) {
        if (remote.lastActiveAt) setStateRaw('sessions', idx, 'lastActiveAt', remote.lastActiveAt);
        if (remote.lastStartedAt) setStateRaw('sessions', idx, 'lastStartedAt', remote.lastStartedAt);
        setStateRaw('sessions', idx, 'ptyActive', remote.ptyActive);
        setStateRaw('sessions', idx, 'startupStage', remote.startupStage);
        if (remote.editorReady !== undefined) setStateRaw('sessions', idx, 'editorReady', remote.editorReady);
        setStateRaw('sessions', idx, 'editorReadyError', remote.editorReadyError === true);
      }

      // Populate sessionMetrics from batch-status metrics
      if (remote.metrics) {
        setStateProduce((s: SessionState) => {
          applyMetricsUpdateFn(s.sessionMetrics, session.id, remote.metrics!);
        });
      }

      // Guard 1: Manual stop - don't overwrite "stopping" with stale KV "running"
      if (session.status === 'stopping') continue;

      // Guard 2: Startup - block ALL KV transitions while session is initializing.
      // isSessionInitializing tracks the full startup flow (SSE stream), not just
      // the 'initializing' status. KV may still show 'stopped' during container start.
      if (session.status === 'initializing' || isSessionInitializingFn(session.id)) continue;

      // Guard 3: Negative KV evidence cannot stop a newly started session or a
      // session whose terminal transport still owns a socket/retry loop. Manual
      // stop and persisted-state 4503 bypass this path in session.ts/terminal.ts.
      if (remote.status === 'stopped' && shouldRetainNegativeKvFn(session.id)) continue;

      // KV is the dashboard projection for unguarded, transport-free sessions.
      if (remote.status === 'running' && session.status !== 'running') {
        updateSessionStatusFn(session.id, 'running');
      } else if (remote.status === 'stopped' && session.status !== 'stopped') {
        updateSessionStatusFn(session.id, 'stopped');
        terminalStore.disposeSession(session.id);
      }
    }
  } catch (err) {
    // Detect auth expiry: the API helper has started top-level sign-in; stop
    // polling and retain the banner only as a fallback while navigation proceeds.
    if (err instanceof ApiError && err.status === 401) {
      logger.warn('[SessionStore] Auth expired - stopping background polling');
      setAuthExpiredFn(true);
      stopSessionListPolling();
      return;
    }
    // Silently ignore other errors - this is background polling
  }
}

// ============================================================================
// start / stop polling
// ============================================================================

function transitioning(): boolean {
  const state = getState();
  return state.sessions.some((session) => session.status === 'initializing' || session.status === 'stopping')
    || state.managedReleaseStatus === 'upgrading'
    || state.bucketMigrating
    || state.bucketMigrationPending;
}

function clearPollTimeout(): void {
  if (sessionListPollTimeout !== null) {
    clearTimeout(sessionListPollTimeout);
    sessionListPollTimeout = null;
  }
}

function pollWithoutOverlap(): Promise<void> {
  if (pollInFlight) return pollInFlight;
  pollInFlight = refreshSessionStatuses().finally(() => { pollInFlight = null; });
  return pollInFlight;
}

function scheduleNextPoll(): void {
  clearPollTimeout();
  if (!pollingActive || document.visibilityState === 'hidden') return;
  sessionListPollTimeout = setTimeout(async () => {
    sessionListPollTimeout = null;
    if (!pollingActive || document.visibilityState === 'hidden') return;
    await pollWithoutOverlap();
    scheduleNextPoll();
  }, transitioning() ? SESSION_POLL_TRANSITION_MS : SESSION_POLL_STABLE_MS);
}

function handlePollingVisibilityChange(): void {
  clearPollTimeout();
  if (!pollingActive || document.visibilityState === 'hidden') return;
  void pollWithoutOverlap().then(scheduleNextPoll);
}

export function startSessionListPolling(): void {
  if (pollingActive) return;
  pollingActive = true;
  if (!visibilityListenerInstalled) {
    document.addEventListener('visibilitychange', handlePollingVisibilityChange);
    visibilityListenerInstalled = true;
  }
  scheduleNextPoll();
}

export function stopSessionListPolling(): void {
  pollingActive = false;
  clearPollTimeout();
  if (visibilityListenerInstalled) {
    document.removeEventListener('visibilitychange', handlePollingVisibilityChange);
    visibilityListenerInstalled = false;
  }
}
