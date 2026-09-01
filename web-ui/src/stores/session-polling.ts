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
let setAuthExpiredFn: AuthExpiredSetter;
let applyMetricsUpdateFn: MetricsUpdater;
let applyManagedReleaseBatchFn: (status: 'current' | 'upgrading' | 'update_pending' | undefined, needsUpgrade: boolean | undefined, progress?: ManagedReleaseProgress) => void;

export function registerPollingDeps(deps: {
  getState: StateGetter;
  setStateProduce: ProduceSetter;
  setStateRaw: RawSetter;
  updateSessionStatus: StatusUpdater;
  isSessionInitializing: InitChecker;
  setAuthExpired: AuthExpiredSetter;
  applyMetricsUpdate: MetricsUpdater;
  applyManagedReleaseBatch: (status: 'current' | 'upgrading' | 'update_pending' | undefined, needsUpgrade: boolean | undefined, progress?: ManagedReleaseProgress) => void;
}): void {
  getState = deps.getState;
  setStateProduce = deps.setStateProduce;
  setStateRaw = deps.setStateRaw;
  updateSessionStatusFn = deps.updateSessionStatus;
  isSessionInitializingFn = deps.isSessionInitializing;
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
function isWithinStartupGuard(sessionId: string): boolean {
  const startedAt = sessionStartedAt.get(sessionId);
  if (!startedAt) return false;
  if (Date.now() - startedAt < STARTUP_GUARD_MS) return true;
  // Guard expired - clean up
  sessionStartedAt.delete(sessionId);
  return false;
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

const MANAGED_RELEASE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let lastManagedCheckAt = 0;
// The poll runs on setInterval without awaiting, and a forced check can start while one
// is outstanding, so this counts probes rather than flagging one: clearing on the first
// settle would let the next poll re-probe while another is still in flight.
let managedChecksInFlight = 0;

/** Test-only: clear the module-level probe window and in-flight count between cases. */
export function resetManagedCheckState(): void {
  lastManagedCheckAt = 0;
  managedChecksInFlight = 0;
}

/** Issue the batch-status call, counting an outstanding managed-release probe. */
async function fetchBatchSessionStatus(includePreseedCheck: boolean) {
  if (!includePreseedCheck) return api.getBatchSessionStatus({ includePreseedCheck });
  managedChecksInFlight += 1;
  try {
    return await api.getBatchSessionStatus({ includePreseedCheck });
  } finally {
    managedChecksInFlight -= 1;
  }
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
    // Each managed check costs a KV read plus an R2 GET and two HEADs server-side, so a
    // settled release is re-probed on the freshness window rather than every poll.
    // Transient states keep the full poll cadence so convergence stays visible.
    const now = Date.now();
    const includePreseedCheck = forceManagedReleaseCheck
      || (state.managedReleaseStatus !== null
        && managedChecksInFlight === 0
        && (state.managedReleaseStatus !== 'current'
          || now - lastManagedCheckAt >= MANAGED_RELEASE_CHECK_INTERVAL_MS));
    const batchResponse = await fetchBatchSessionStatus(includePreseedCheck);
    // Only a completed check consumes the window; a failed call must not suppress the next.
    if (includePreseedCheck) lastManagedCheckAt = now;
    const batchStatuses = batchResponse.statuses;
    if (batchResponse.maxSessions !== undefined) setStateRaw('maxSessions', batchResponse.maxSessions);
    if (batchResponse.storageStats) updateStatsFromBatch(batchResponse.storageStats);
    if (batchResponse.usage) {
      setUsageState(batchResponse.usage.monthlySeconds, batchResponse.usage.monthlyQuotaSeconds);
    }
    if (batchResponse.managedReleaseStatus !== undefined) {
      applyManagedReleaseBatchFn(batchResponse.managedReleaseStatus, batchResponse.preseedNeedsUpgrade, batchResponse.managedReleaseProgress);
    }

    // REQ-ENTERPRISE-020: mirror the Governed Mode migration flags on EVERY background poll (not just the
    // full loadSessions). Without this, a migration that completes between full loads leaves the New Session
    // button stuck on "Migrating" until a manual page reload; mirroring here clears it within one 5s poll.
    setStateRaw('bucketMigrating', batchResponse.bucketMigrating === true);
    setStateRaw('bucketMigrationPending', batchResponse.bucketMigrationPending === true);
    setStateRaw('bucketMigrationPercent', typeof batchResponse.bucketMigrationPercent === 'number' ? batchResponse.bucketMigrationPercent : null);

    // Consecutive-miss tracking: only remove sessions after REMOVAL_THRESHOLD misses.
    // Skip initializing sessions - they may not appear in batch status yet.
    const removedIds: string[] = [];
    for (const session of state.sessions) {
      if (!batchStatuses[session.id]) {
        if (session.status === 'initializing' || session.id === state.activeSessionId) continue;
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

      // Guard 3: Recently-started session - protect from stale KV 'stopped'
      // for 3 minutes after first reaching 'running'. Only 4503 (from Container
      // DO) and manual stopSession() can stop a guarded session. This guard
      // persists even if the user navigates to the dashboard.
      if (remote.status === 'stopped' && isWithinStartupGuard(session.id)) continue;

      // KV is source of truth for non-active, non-starting sessions.
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
