import * as api from '../api/client';
import { ApiError } from '../api/fetch-helper';
import { terminalStore } from './terminal';
import { logger } from '../lib/logger';
import { SESSION_LIST_POLL_INTERVAL_MS } from '../lib/constants';
import { updateStatsFromBatch } from './storage';
import { setUsageState } from './session-usage';
import type { SessionWithStatus, SessionStatus } from '../types';

/**
 * Session List Polling — extracted from session.ts (CF-013).
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
  sessionMetrics: Record<string, any>;
}

type StateGetter = () => PollingStateView;
type ProduceSetter = (fn: (s: any) => void) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawSetter = (...args: any[]) => void;
type StatusUpdater = (id: string, status: SessionStatus) => void;
type InitChecker = (id: string) => boolean;
type AuthExpiredSetter = (expired: boolean) => void;
type MetricsUpdater = (
  sessionMetrics: Record<string, any>,
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

export function registerPollingDeps(deps: {
  getState: StateGetter;
  setStateProduce: ProduceSetter;
  setStateRaw: RawSetter;
  updateSessionStatus: StatusUpdater;
  isSessionInitializing: InitChecker;
  setAuthExpired: AuthExpiredSetter;
  applyMetricsUpdate: MetricsUpdater;
}): void {
  getState = deps.getState;
  setStateProduce = deps.setStateProduce;
  setStateRaw = deps.setStateRaw;
  updateSessionStatusFn = deps.updateSessionStatus;
  isSessionInitializingFn = deps.isSessionInitializing;
  setAuthExpiredFn = deps.setAuthExpired;
  applyMetricsUpdateFn = deps.applyMetricsUpdate;
}

// ============================================================================
// Startup guard — protect recently-started sessions from stale KV 'stopped'
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
  // Guard expired — clean up
  sessionStartedAt.delete(sessionId);
  return false;
}

// ============================================================================
// Consecutive-miss tracking
// ============================================================================

export const sessionMissCounters = new Map<string, number>();
export const REMOVAL_THRESHOLD = 3;

// ============================================================================
// Poll interval handle
// ============================================================================

let sessionListPollInterval: ReturnType<typeof setInterval> | null = null;

// ============================================================================
// refreshSessionStatuses
// ============================================================================

/**
 * Lightweight status refresh — only fetches batch-status and updates
 * existing session statuses in-place. Does NOT replace the sessions
 * array or set loading state, so the dashboard doesn't flicker.
 * Also updates storage stats when storageStats is present in the batch response.
 */
export async function refreshSessionStatuses(): Promise<void> {
  try {
    const state = getState();
    const batchResponse = await api.getBatchSessionStatus();
    const batchStatuses = batchResponse.statuses;
    if (batchResponse.maxSessions !== undefined) setStateRaw('maxSessions', batchResponse.maxSessions);
    if (batchResponse.storageStats) updateStatsFromBatch(batchResponse.storageStats);
    if (batchResponse.usage) {
      setUsageState(batchResponse.usage.monthlySeconds, batchResponse.usage.monthlyQuotaSeconds);
    }

    // Consecutive-miss tracking: only remove sessions after REMOVAL_THRESHOLD misses.
    // Skip initializing sessions — they may not appear in batch status yet.
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
      setStateProduce((s: any) => {
        s.sessions = s.sessions.filter((sess: SessionWithStatus) => !removedIds.includes(sess.id));
      });
    }
    for (const session of getState().sessions) {
      const remote = batchStatuses[session.id];
      if (!remote) continue;

      // Propagate per-session fields from batch-status onto SessionWithStatus.
      // ptyActive/startupStage are frontend-only mirrors of the latest poll —
      // consumers (e.g. Layout vault-button gate) read them off the session.
      const idx = getState().sessions.findIndex(s => s.id === session.id);
      if (idx !== -1) {
        if (remote.lastActiveAt) setStateRaw('sessions', idx, 'lastActiveAt', remote.lastActiveAt);
        if (remote.lastStartedAt) setStateRaw('sessions', idx, 'lastStartedAt', remote.lastStartedAt);
        setStateRaw('sessions', idx, 'ptyActive', remote.ptyActive);
        setStateRaw('sessions', idx, 'startupStage', remote.startupStage);
      }

      // Populate sessionMetrics from batch-status metrics
      if (remote.metrics) {
        setStateProduce((s: any) => {
          applyMetricsUpdateFn(s.sessionMetrics, session.id, remote.metrics!);
        });
      }

      // Guard 1: Manual stop — don't overwrite "stopping" with stale KV "running"
      if (session.status === 'stopping') continue;

      // Guard 2: Startup — block ALL KV transitions while session is initializing.
      // isSessionInitializing tracks the full startup flow (SSE stream), not just
      // the 'initializing' status. KV may still show 'stopped' during container start.
      if (session.status === 'initializing' || isSessionInitializingFn(session.id)) continue;

      // Guard 3: Recently-started session — protect from stale KV 'stopped'
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
    // Detect auth expiry: stop polling and surface to UI instead of thrashing
    if (err instanceof ApiError && err.status === 401) {
      logger.warn('[SessionStore] Auth expired — stopping background polling');
      setAuthExpiredFn(true);
      stopSessionListPolling();
      return;
    }
    // Silently ignore other errors — this is background polling
  }
}

// ============================================================================
// start / stop polling
// ============================================================================

export function startSessionListPolling(): void {
  if (sessionListPollInterval !== null) return;
  sessionListPollInterval = setInterval(() => {
    refreshSessionStatuses();
  }, SESSION_LIST_POLL_INTERVAL_MS);
}

export function stopSessionListPolling(): void {
  if (sessionListPollInterval !== null) {
    clearInterval(sessionListPollInterval);
    sessionListPollInterval = null;
  }
}
