import { createStore, produce } from 'solid-js/store';
import type { Session, SessionWithStatus, SessionStatus, InitProgress, InitStage, TerminalTab, SessionTerminals, TileLayout, TilingState, AgentType, TabConfig, TabPreset, UserPreferences } from '../types';
import * as api from '../api/client';
import { terminalStore, sendInputToTerminal } from './terminal';
import { logger } from '../lib/logger';
import { METRICS_POLL_INTERVAL_MS, STARTUP_POLL_INTERVAL_MS, MAX_STARTUP_POLL_ERRORS, MAX_TERMINALS_PER_SESSION, MAX_STOP_POLL_ATTEMPTS, STOP_POLL_INTERVAL_MS, MAX_STOP_POLL_ERRORS, SESSION_LIST_POLL_INTERVAL_MS, CONTEXT_EXPIRY_MS } from '../lib/constants';
import {
  LAYOUT_MIN_TABS,
  getBestLayoutForTabCount,
  isLayoutCompatible,
  setTilingLayout,
  getTilingForSession,
  getTabOrder,
  registerSessionStoreAccess,
} from './tiling';
import { registerProcessNameCallback } from './terminal';
import {
  loadTerminalsFromStorage,
  saveTerminalsToStorage,
  registerTabsDeps,
  initializeTerminalsForSession,
  addTerminalTab,
  removeTerminalTab,
  setActiveTerminalTab,
  getTerminalsForSession,
  reorderTerminalTabs,
  updateTerminalLabel,
  cleanupTerminalsForSession,
} from './session-tabs';
import {
  registerPresetsDeps,
  loadPresets,
  savePreset,
  deletePreset,
  renamePreset,
  saveBookmarkForSession,
  applyPresetToSession,
} from './session-presets';

/**
 * Session Store — central facade for session lifecycle management.
 *
 * Responsibilities:
 *  - CRUD operations for sessions (list, create, rename, delete)
 *  - Session start/stop with startup-status polling
 *  - Active session selection and view-state tracking
 *  - Per-session metrics polling (CPU, mem, sync status)
 *  - User preferences persistence
 *
 * Delegates to:
 *  - `session-tabs.ts` for terminal tab management
 *  - `session-presets.ts` for tab preset CRUD
 *  - `tiling.ts` for tiling layout logic
 */

// ============================================================================
// Session Metrics Type
// ============================================================================
interface SessionMetrics {
  bucketName: string;
  syncStatus: 'pending' | 'syncing' | 'success' | 'failed' | 'skipped';
  cpu?: string;
  mem?: string;
  hdd?: string;
}

interface SessionState {
  sessions: SessionWithStatus[];
  activeSessionId: string | null;
  loading: boolean;
  error: string | null;
  initializingSessionIds: Record<string, boolean>;
  initProgressBySession: Record<string, InitProgress>;
  terminalsPerSession: Record<string, SessionTerminals>;
  sessionMetrics: Record<string, SessionMetrics>;
  presets: TabPreset[];
  preferences: UserPreferences;
}

const [state, setState] = createStore<SessionState>({
  sessions: [],
  activeSessionId: null,
  loading: false,
  error: null,
  initializingSessionIds: {},
  initProgressBySession: {},
  terminalsPerSession: loadTerminalsFromStorage(),
  sessionMetrics: {},
  presets: [],
  preferences: {},
});

// Register dependencies for extracted modules
registerTabsDeps(
  () => state,
  (fn) => setState(produce(fn)),
  terminalStore,
  () => saveTerminalsToStorage(state.terminalsPerSession),
);

registerPresetsDeps(
  () => ({ sessions: state.sessions, presets: state.presets, terminalsPerSession: state.terminalsPerSession, error: state.error }),
  (fn) => setState(produce(fn)),
  (key, value) => setState(key, value),
  terminalStore,
);

// Register session store access for tiling module (avoids circular imports)
registerSessionStoreAccess(
  () => state,
  (fn) => setState(produce(fn)),
  () => saveTerminalsToStorage(state.terminalsPerSession),
);

// Register process-name callback for terminal store (avoids circular imports)
registerProcessNameCallback((sessionId, terminalId, processName) => {
  updateTerminalLabel(sessionId, terminalId, processName);
});

// Get active session
function getActiveSession(): SessionWithStatus | undefined {
  return state.sessions.find((s) => s.id === state.activeSessionId);
}

// Track startup polling cleanup functions per session
const startupCleanups = new Map<string, () => void>();

let loadSessionsGeneration = 0;

async function loadSessions(): Promise<void> {
  const thisGen = ++loadSessionsGeneration;

  setState('loading', true);
  setState('error', null);

  try {
    const [sessions, batchStatuses] = await Promise.all([
      api.getSessions(),
      api.getBatchSessionStatus().catch(() => ({} as Record<string, { status: 'running' | 'stopped'; ptyActive: boolean; startupStage?: string; lastStartedAt?: string; lastActiveAt?: string }>)),
    ]);

    if (thisGen !== loadSessionsGeneration) return;

    const existingStatuses = new Map(
      state.sessions.map(s => [s.id, s.status])
    );

    const oldIds = new Set(state.sessions.map(s => s.id));

    const sessionsWithStatus: SessionWithStatus[] = sessions.map((s) => ({
      ...s,
      status: existingStatuses.get(s.id) || ('stopped' as SessionStatus),
    }));
    setState('sessions', sessionsWithStatus);

    const newIds = new Set(sessions.map(s => s.id));
    for (const id of oldIds) {
      if (!newIds.has(id)) {
        cleanupTerminalsForSession(id);
      }
    }

    for (const session of sessionsWithStatus) {
      if (thisGen !== loadSessionsGeneration) return;

      const batchStatus = batchStatuses[session.id];
      if (!batchStatus) {
        continue;
      }

      // Store timestamp fields from batch-status
      if (batchStatus.lastActiveAt || batchStatus.lastStartedAt) {
        const idx = sessionsWithStatus.findIndex(s => s.id === session.id);
        if (idx !== -1) {
          if (batchStatus.lastActiveAt) setState('sessions', idx, 'lastActiveAt', batchStatus.lastActiveAt);
          if (batchStatus.lastStartedAt) setState('sessions', idx, 'lastStartedAt', batchStatus.lastStartedAt);
        }
      }

      if (batchStatus.status === 'running') {
        const wasRunning = existingStatuses.get(session.id) === 'running';
        updateSessionStatus(session.id, 'running');
        if (!wasRunning) {
          initializeTerminalsForSession(session.id);
          startMetricsPolling(session.id);
        }
      } else {
        updateSessionStatus(session.id, batchStatus.status);
      }
    }
  } catch (err) {
    if (thisGen !== loadSessionsGeneration) return;
    setState('error', err instanceof Error ? err.message : 'Failed to load sessions');
  } finally {
    if (thisGen === loadSessionsGeneration) {
      setState('loading', false);
    }
  }
}

async function createSession(name: string, agentType?: AgentType, tabConfig?: TabConfig[]): Promise<SessionWithStatus | null> {
  try {
    const session = await api.createSession(name, agentType, tabConfig);
    const sessionWithStatus: SessionWithStatus = {
      ...session,
      status: 'stopped',
    };
    setState(
      produce((s) => {
        s.sessions.push(sessionWithStatus);
      })
    );
    return sessionWithStatus;
  } catch (err) {
    setState('error', err instanceof Error ? err.message : 'Failed to create session');
    return null;
  }
}

async function renameSession(id: string, name: string): Promise<void> {
  try {
    await api.updateSession(id, { name });
    const index = state.sessions.findIndex((s) => s.id === id);
    if (index !== -1) {
      setState('sessions', index, 'name', name);
    }
  } catch (err) {
    setState('error', err instanceof Error ? err.message : 'Failed to rename session');
  }
}

async function deleteSession(id: string): Promise<void> {
  try {
    const startupCleanup = startupCleanups.get(id);
    if (startupCleanup) {
      startupCleanup();
      startupCleanups.delete(id);
    }
    await api.deleteSession(id);
    stopMetricsPolling(id);
    sessionMissCounters.delete(id);
    cleanupTerminalsForSession(id);
    setState(
      produce((s) => {
        s.sessions = s.sessions.filter((session) => session.id !== id);
        if (s.activeSessionId === id) {
          s.activeSessionId = null;
        }
        delete s.sessionMetrics[id];
      })
    );
  } catch (err) {
    setState('error', err instanceof Error ? err.message : 'Failed to delete session');
  }
}

function startSession(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    setState(
      produce((s) => {
        s.initializingSessionIds[id] = true;
        delete s.initProgressBySession[id];
      })
    );
    updateSessionStatus(id, 'initializing');

    const cleanup = api.startSession(
      id,
      (progress) => {
        setState(
          produce((s) => {
            s.initProgressBySession[id] = progress;
          })
        );
      },
      () => {
        startupCleanups.delete(id);
        updateSessionStatus(id, 'running');
        initializeTerminalsForSession(id);
        startMetricsPolling(id);
        resolve();
      },
      (error) => {
        startupCleanups.delete(id);
        setState(
          produce((s) => {
            delete s.initializingSessionIds[id];
            delete s.initProgressBySession[id];
          })
        );
        updateSessionStatus(id, 'error');
        setState('error', error);
        reject(new Error(error));
      }
    );

    startupCleanups.get(id)?.();
    startupCleanups.set(id, cleanup);
  });
}

async function stopSession(id: string): Promise<void> {
  try {
    const startupCleanup = startupCleanups.get(id);
    if (startupCleanup) {
      startupCleanup();
      startupCleanups.delete(id);
    }
    setState(
      produce((s) => {
        delete s.initializingSessionIds[id];
        delete s.initProgressBySession[id];
      })
    );
    updateSessionStatus(id, 'stopping');
    await api.stopSession(id);
    stopMetricsPolling(id);

    // Poll batch-status until session reaches 'stopped' (sync may still be running)
    const pollForStopped = (): Promise<void> => {
      return new Promise((resolve) => {
        let pollCount = 0;
        let consecutiveErrors = 0;

        const cleanupStopPolling = () => {
          clearInterval(interval);
          startupCleanups.delete(id);
          updateSessionStatus(id, 'stopped');
          terminalStore.disposeSession(id);
          resolve();
        };

        const interval = setInterval(async () => {
          pollCount++;

          if (pollCount >= MAX_STOP_POLL_ATTEMPTS) {
            cleanupStopPolling();
            return;
          }

          try {
            const statuses = await api.getBatchSessionStatus();
            consecutiveErrors = 0;
            const sessionStatus = statuses[id];
            if (!sessionStatus || sessionStatus.status === 'stopped') {
              cleanupStopPolling();
            }
          } catch {
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_STOP_POLL_ERRORS) {
              cleanupStopPolling();
            }
          }
        }, STOP_POLL_INTERVAL_MS);

        // Track stop-polling interval for cleanup (FIX-17)
        startupCleanups.set(id, () => {
          clearInterval(interval);
        });
      });
    };

    await pollForStopped();
  } catch (err) {
    setState('error', err instanceof Error ? err.message : 'Failed to stop session');
  }
}

function updateSessionStatus(id: string, status: SessionStatus): void {
  const index = state.sessions.findIndex((sess) => sess.id === id);
  if (index !== -1) {
    setState('sessions', index, 'status', status);
    if (status !== 'running') {
      stopMetricsPolling(id);
    }
  }
}

function setActiveSession(id: string | null): void {
  setState('activeSessionId', id);

  if (id) {
    const index = state.sessions.findIndex((sess) => sess.id === id);
    if (index !== -1) {
      setState('sessions', index, 'lastAccessedAt', new Date().toISOString());
    }
  }
}

function clearError(): void {
  setState('error', null);
}

function dismissInitProgressForSession(sessionId: string): void {
  setState(
    produce((s) => {
      delete s.initializingSessionIds[sessionId];
      delete s.initProgressBySession[sessionId];
    })
  );
}

function isSessionInitializing(sessionId: string): boolean {
  return state.initializingSessionIds[sessionId] === true;
}

function getInitProgressForSession(sessionId: string): InitProgress | null {
  return state.initProgressBySession[sessionId] || null;
}

// ============================================================================
// Session Metrics
// ============================================================================

async function fetchMetricsForSession(sessionId: string): Promise<void> {
  try {
    const status = await api.getStartupStatus(sessionId);
    if (status.details) {
      setState(produce(s => {
        s.sessionMetrics[sessionId] = {
          bucketName: status.details?.bucketName || '...',
          syncStatus: (status.details?.syncStatus as 'pending' | 'syncing' | 'success' | 'failed' | 'skipped') || 'pending',
          cpu: status.details?.cpu || '...',
          mem: status.details?.mem || '...',
          hdd: status.details?.hdd || '...',
        };
      }));
    }
  } catch (err) {
    logger.warn('[SessionStore] Failed to fetch metrics:', err);
  }
}

const metricsPollingIntervals = new Map<string, ReturnType<typeof setInterval>>();

function startMetricsPolling(sessionId: string): void {
  if (metricsPollingIntervals.has(sessionId)) return;

  fetchMetricsForSession(sessionId);

  metricsPollingIntervals.set(sessionId, setInterval(() => {
    fetchMetricsForSession(sessionId);
  }, METRICS_POLL_INTERVAL_MS));
}

function stopMetricsPolling(sessionId: string): void {
  const interval = metricsPollingIntervals.get(sessionId);
  if (interval) {
    clearInterval(interval);
    metricsPollingIntervals.delete(sessionId);
    logger.debug(`[SessionStore] Stopped metrics polling for session ${sessionId}`);
  }
}

// ============================================================================
// Session List Polling
// ============================================================================

const sessionMissCounters = new Map<string, number>();
const REMOVAL_THRESHOLD = 3;

let sessionListPollInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Lightweight status refresh — only fetches batch-status and updates
 * existing session statuses in-place. Does NOT replace the sessions
 * array or set loading state, so the dashboard doesn't flicker.
 */
async function refreshSessionStatuses(): Promise<void> {
  try {
    const batchStatuses = await api.getBatchSessionStatus();

    // Consecutive-miss tracking: only remove sessions after REMOVAL_THRESHOLD misses
    const removedIds: string[] = [];
    for (const session of state.sessions) {
      if (!batchStatuses[session.id]) {
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
      setState('sessions', (prev) => prev.filter((s) => !removedIds.includes(s.id)));
    }
    for (const session of state.sessions) {
      const remote = batchStatuses[session.id];
      if (!remote) continue;

      // Store timestamp fields
      const idx = state.sessions.findIndex(s => s.id === session.id);
      if (idx !== -1) {
        if (remote.lastActiveAt) setState('sessions', idx, 'lastActiveAt', remote.lastActiveAt);
        if (remote.lastStartedAt) setState('sessions', idx, 'lastStartedAt', remote.lastStartedAt);
      }

      if (remote.status === 'running' && session.status !== 'running' && session.status !== 'initializing') {
        updateSessionStatus(session.id, 'running');
        initializeTerminalsForSession(session.id);
        startMetricsPolling(session.id);
      } else if (remote.status === 'stopped' && session.status !== 'stopped' && session.status !== 'stopping') {
        updateSessionStatus(session.id, 'stopped');
      }
    }
  } catch {
    // Silently ignore — this is background polling
  }
}

function startSessionListPolling(): void {
  if (sessionListPollInterval !== null) return;
  sessionListPollInterval = setInterval(() => {
    refreshSessionStatuses();
  }, SESSION_LIST_POLL_INTERVAL_MS);
}

function stopSessionListPolling(): void {
  if (sessionListPollInterval !== null) {
    clearInterval(sessionListPollInterval);
    sessionListPollInterval = null;
  }
}

function stopAllMetricsPolling(): void {
  metricsPollingIntervals.forEach((interval, sessionId) => {
    clearInterval(interval);
    logger.debug(`[SessionStore] Stopped metrics polling for session ${sessionId}`);
  });
  metricsPollingIntervals.clear();

  for (const [sessionId, cleanup] of startupCleanups) {
    cleanup();
    logger.debug(`[SessionStore] Stopped startup polling for session ${sessionId}`);
  }
  startupCleanups.clear();
}

function getMetricsForSession(sessionId: string): SessionMetrics | null {
  return state.sessionMetrics[sessionId] || null;
}

// ============================================================================
// User Preferences
// ============================================================================

async function loadPreferences(): Promise<void> {
  try {
    const prefs = await api.getPreferences();
    setState('preferences', prefs);
  } catch (err) {
    logger.warn('[SessionStore] Failed to load preferences:', err);
  }
}

async function updatePreferences(prefs: Partial<UserPreferences>): Promise<void> {
  try {
    const updated = await api.updatePreferences(prefs);
    setState('preferences', updated);
  } catch (err) {
    logger.warn('[SessionStore] Failed to update preferences:', err);
  }
}

/** Check if a stopped session's context may still be alive (lastActiveAt < 24h ago) */
function hasRecentContext(session: SessionWithStatus): boolean {
  if (!session.lastActiveAt) return false;
  return Date.now() - new Date(session.lastActiveAt).getTime() < CONTEXT_EXPIRY_MS;
}

// Export store and actions
export const sessionStore = {
  // State (readonly)
  get sessions() {
    return state.sessions;
  },
  get activeSessionId() {
    return state.activeSessionId;
  },
  get loading() {
    return state.loading;
  },
  get error() {
    return state.error;
  },

  // Derived
  getActiveSession,

  // Per-session initialization state accessors
  isSessionInitializing,
  getInitProgressForSession,

  // Session metrics
  getMetricsForSession,
  stopMetricsPolling,
  stopAllMetricsPolling,

  // Session list polling
  startSessionListPolling,
  stopSessionListPolling,

  // Actions
  loadSessions,
  createSession,
  renameSession,
  deleteSession,
  startSession,
  stopSession,
  setActiveSession,
  clearError,
  dismissInitProgressForSession,

  // Nested terminals management (re-exported from session-tabs)
  getTerminalsForSession,
  initializeTerminalsForSession,
  addTerminalTab,
  removeTerminalTab,
  setActiveTerminalTab,
  cleanupTerminalsForSession,

  // Tiling management
  reorderTerminalTabs,
  setTilingLayout,
  getTilingForSession,
  getTabOrder,

  // Dynamic terminal labels
  updateTerminalLabel,

  // Presets (re-exported from session-presets)
  get presets() { return state.presets; },
  loadPresets,
  savePreset,
  deletePreset,
  renamePreset,
  saveBookmarkForSession,
  applyPresetToSession,

  // Preferences
  get preferences() { return state.preferences; },
  loadPreferences,
  updatePreferences,

  // Context lifecycle
  hasRecentContext,

  // @internal -- exposed for tests (AD23)
  updateSessionStatus,
  refreshSessionStatuses,
  _resetMissCounters: () => sessionMissCounters.clear(),
};
