import { createStore, produce } from 'solid-js/store';
import { createSignal } from 'solid-js';
import type { SessionWithStatus, SessionStatus, InitProgress, SessionTerminals, AgentType, TabConfig, TabPreset, UserPreferences } from '../types';
import * as api from '../api/client';
import { terminalStore } from './terminal';
import { logger } from '../lib/logger';
import { cleanupSessionVaultCache } from '../lib/vault-cache';
import { MAX_STOP_POLL_ATTEMPTS, STOP_POLL_INTERVAL_MS, MAX_STOP_POLL_ERRORS, CONTEXT_EXPIRY_MS } from '../lib/constants';
import {
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
import { updateStatsFromBatch } from './storage';
import {
  registerR2ReadinessDeps,
  startR2Polling,
  stopR2Polling,
  isR2Ready,
} from './r2-readiness';
import {
  registerPreferencesDeps,
  loadPreferences,
  updateUserPreferences,
} from './preferences';
import {
  registerPollingDeps,
  sessionMissCounters,
  refreshSessionStatuses,
  startSessionListPolling,
  stopSessionListPolling,
  markSessionStarted,
  clearSessionStartedGuard,
} from './session-polling';

// Re-export usage functions so existing consumers keep working
export {
  setUsageState,
  getUsageState,
  isAtUsageQuota,
  getUsageWarningLevel,
  getDismissedQuotaLevel,
  setDismissedQuotaLevel,
} from './session-usage';
export type { UsageWarningLevel, UsageState } from './session-usage';

/**
 * Session Store — central facade for session lifecycle management.
 *
 * Delegates to: session-tabs, session-presets, session-polling,
 * session-usage, tiling, r2-readiness, preferences.
 */

// ── Session Metrics ─────────────────────────────────────────────────────────

interface SessionMetrics {
  bucketName: string;
  syncStatus: 'pending' | 'syncing' | 'success' | 'failed' | 'skipped';
  cpu?: string;
  mem?: string;
  hdd?: string;
}

/** Batch status entry shape from the backend */
type BatchStatusEntry = {
  status: 'running' | 'stopped';
  ptyActive: boolean;
  startupStage?: string;
  lastStartedAt?: string;
  lastActiveAt?: string;
  metrics?: { cpu?: string; mem?: string; hdd?: string; syncStatus?: string; updatedAt?: string };
};

/**
 * Populate sessionMetrics from batch-status metrics.
 * Mutates the `sessionMetrics` record in place — designed for use inside `produce()` or direct object mutation.
 */
export function applyMetricsUpdate(
  sessionMetrics: Record<string, SessionMetrics>,
  sessionId: string,
  metrics: { cpu?: string; mem?: string; hdd?: string; syncStatus?: string },
): void {
  sessionMetrics[sessionId] = {
    bucketName: sessionMetrics[sessionId]?.bucketName || '...',
    syncStatus: (metrics.syncStatus as SessionMetrics['syncStatus']) || sessionMetrics[sessionId]?.syncStatus || 'pending',
    cpu: metrics.cpu || '...',
    mem: metrics.mem || '...',
    hdd: metrics.hdd || '...',
  };
}

export interface SessionState {
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
  maxSessions: number;
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
  maxSessions: 3,
});

// Auth expiry detection — set when background polling gets a 401/auth redirect.
// Exposed as a reactive signal so Layout can show a re-auth banner.
const [authExpired, setAuthExpired] = createSignal(false);

// ── Dependency registration for extracted modules ───────────────────────────

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

// Register R2 readiness dependencies (extracted to r2-readiness.ts)
registerR2ReadinessDeps({
  getR2Status: api.getR2Status,
  ensureR2Token: api.ensureR2Token,
});

// ── Core session helpers ────────────────────────────────────────────────────

function updateSessionStatus(id: string, status: SessionStatus): void {
  const index = state.sessions.findIndex((sess) => sess.id === id);
  if (index !== -1) {
    setState('sessions', index, 'status', status);
    if (status === 'running') markSessionStarted(id);
    if (status === 'stopped' || status === 'stopping') clearSessionStartedGuard(id);
  }
}

function isSessionInitializing(sessionId: string): boolean {
  return state.initializingSessionIds[sessionId] === true;
}

// Register polling dependencies (extracted to session-polling.ts)
registerPollingDeps({
  getState: () => state,
  setStateProduce: (fn) => setState(produce(fn)),
  setStateRaw: (...args: any[]) => (setState as any)(...args),
  updateSessionStatus,
  isSessionInitializing,
  setAuthExpired,
  applyMetricsUpdate,
});

// ── Session CRUD & lifecycle ────────────────────────────────────────────────

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
    const [sessions, batchResponse] = await Promise.all([
      api.getSessions(),
      api.getBatchSessionStatus().catch((err) => {
        logger.warn('[SessionStore] getBatchSessionStatus failed:', err);
        setState('error', err instanceof Error ? err.message : 'Failed to fetch session statuses');
        return { statuses: {} as Record<string, BatchStatusEntry>, maxSessions: state.maxSessions };
      }),
    ]);
    const batchStatuses = batchResponse.statuses;
    if (batchResponse.maxSessions !== undefined) setState('maxSessions', batchResponse.maxSessions);
    if ('storageStats' in batchResponse && batchResponse.storageStats) updateStatsFromBatch(batchResponse.storageStats);

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

      // Propagate per-session fields from batch-status onto SessionWithStatus.
      // ptyActive/startupStage are frontend-only mirrors of the latest poll —
      // consumers (e.g. Layout vault-button gate) read them off the session.
      const idx = sessionsWithStatus.findIndex(s => s.id === session.id);
      if (idx !== -1) {
        if (batchStatus.lastActiveAt) setState('sessions', idx, 'lastActiveAt', batchStatus.lastActiveAt);
        if (batchStatus.lastStartedAt) setState('sessions', idx, 'lastStartedAt', batchStatus.lastStartedAt);
        setState('sessions', idx, 'ptyActive', batchStatus.ptyActive);
        setState('sessions', idx, 'startupStage', batchStatus.startupStage);
      }

      // Populate sessionMetrics from batch-status metrics
      if (batchStatus.metrics) {
        setState(produce(s => {
          applyMetricsUpdate(s.sessionMetrics, session.id, batchStatus.metrics!);
        }));
      }

      if (batchStatus.status === 'running') {
        const wasRunning = existingStatuses.get(session.id) === 'running';
        updateSessionStatus(session.id, 'running');
        if (!wasRunning) {
          initializeTerminalsForSession(session.id);
        }
      } else {
        const wasRunning = existingStatuses.get(session.id) === 'running';
        updateSessionStatus(session.id, batchStatus.status);
        // Container stopped externally (hibernation/crash) — kill WS retry loops
        // so reconnect attempts don't keep waking the DO. Fresh connect() calls
        // are made when the user starts the session again.
        if (wasRunning && batchStatus.status === 'stopped') {
          terminalStore.disposeSession(session.id);
        }
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
    sessionMissCounters.delete(id);
    cleanupTerminalsForSession(id);
    // REQ-VAULT-008 AC8: drop the per-session SilverBullet IDB cache,
    // localStorage marker, and SW registration. Best-effort and async
    // — we do not block the UI on it.
    void cleanupSessionVaultCache(id).catch((err) =>
      logger.warn('vault cache cleanup failed', { id, error: err instanceof Error ? err.message : String(err) }),
    );
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
            const batchResp = await api.getBatchSessionStatus();
            consecutiveErrors = 0;
            const sessionStatus = batchResp.statuses[id];
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

        // Track stop-polling interval for cleanup
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

function getInitProgressForSession(sessionId: string): InitProgress | null {
  return state.initProgressBySession[sessionId] || null;
}

function stopAllPolling(): void {
  for (const [sessionId, cleanup] of startupCleanups) {
    cleanup();
    logger.debug(`[SessionStore] Stopped startup polling for session ${sessionId}`);
  }
  startupCleanups.clear();
}

function getMetricsForSession(sessionId: string): SessionMetrics | null {
  return state.sessionMetrics[sessionId] || null;
}

// Register preferences dependencies (extracted to preferences.ts)
registerPreferencesDeps({
  api: { getPreferences: api.getPreferences, updatePreferences: api.updatePreferences },
  logger,
  setPreferences: (prefs: UserPreferences) => setState('preferences', prefs),
  getPreferences: () => state.preferences,
});

/** Check if user has reached max concurrent running sessions (counts running + initializing). */
function isAtSessionLimit(): boolean {
  const runningCount = state.sessions.filter(s => s.status === 'running' || s.status === 'initializing').length;
  return runningCount >= state.maxSessions;
}

/** Check if a stopped session's context may still be alive (lastActiveAt < CONTEXT_EXPIRY_MS ago, i.e. 30m) */
function hasRecentContext(session: SessionWithStatus): boolean {
  if (!session.lastActiveAt) return false;
  return Date.now() - new Date(session.lastActiveAt).getTime() < CONTEXT_EXPIRY_MS;
}

export const sessionStore = {
  get sessions() { return state.sessions; },
  get activeSessionId() { return state.activeSessionId; },
  get loading() { return state.loading; },
  get error() { return state.error; },
  getActiveSession,
  isSessionInitializing,
  getInitProgressForSession,
  getMetricsForSession,
  stopAllPolling,
  startSessionListPolling,
  stopSessionListPolling,
  loadSessions,
  createSession,
  renameSession,
  deleteSession,
  startSession,
  stopSession,
  setActiveSession,
  clearError,
  dismissInitProgressForSession,
  getTerminalsForSession,
  initializeTerminalsForSession,
  addTerminalTab,
  removeTerminalTab,
  setActiveTerminalTab,
  cleanupTerminalsForSession,
  reorderTerminalTabs,
  setTilingLayout,
  getTilingForSession,
  getTabOrder,
  updateTerminalLabel,
  get presets() { return state.presets; },
  loadPresets,
  savePreset,
  deletePreset,
  renamePreset,
  saveBookmarkForSession,
  applyPresetToSession,
  get preferences() { return state.preferences; },
  loadPreferences,
  updatePreferences: updateUserPreferences,
  get maxSessions() { return state.maxSessions; },
  isAtSessionLimit,
  hasRecentContext,
  get r2Ready() { return isR2Ready(); },
  startR2Polling,
  stopR2Polling,
  get authExpired() { return authExpired(); },
  // @internal -- exposed for tests (AD23)
  updateSessionStatus,
  refreshSessionStatuses,
  _resetMissCounters: () => sessionMissCounters.clear(),
  _resetAuthExpired: () => setAuthExpired(false),
};
