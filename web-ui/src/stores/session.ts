import { createStore, produce } from 'solid-js/store';
import { batch, createSignal } from 'solid-js';
import type { SessionWithStatus, SessionStatus, InitProgress, RepositoryRestoreStatus, SessionTerminals, AgentType, TabConfig, UserPreferences, PiSurface } from '../types';
import * as api from '../api/client';
import { ApiError } from '../api/fetch-helper';
import { upgradeAgentConfigs } from '../api/storage';
import { cloneIntoSession, type CloneIntoSessionResult } from '../api/github';
import type { ManagedReleaseProgress } from '../api/client';
import { terminalStore } from './terminal';
import { cloneAttempt, forgetCloneAttempt, setCloneAttempt } from './clone-attempts';
import { logger } from '../lib/logger';
import { applyOrderedProjection, type BackendLifecycle } from '../lib/session-presentation';
import { cleanupSessionVaultCache, sweepOrphanVaultCaches } from '../lib/vault-cache';
import { MAX_STOP_POLL_ATTEMPTS, STOP_POLL_INTERVAL_MS, MAX_STOP_POLL_ERRORS, MAX_STARTUP_POLL_ERRORS, SESSION_POLL_TRANSITION_MS, CONTEXT_EXPIRY_MS } from '../lib/constants';
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
  invalidateSessionStatusReads,
  getSessionCatalogRevision,
  beginSessionStatusRead,
  sessionStatusUnavailable,
  sessionMissCounters,
  refreshSessionStatuses,
  refreshSessionAncillaryStatus,
  startSessionListPolling,
  stopSessionListPolling,
  markSessionStarted,
  clearSessionStartedGuard,
  isWithinStartupGuard,
  resetStartupGuards,
  resetManagedCheckState,
} from './session-polling';

// Re-export usage functions so existing consumers keep working
export {
  getUsageState,
  isAtUsageQuota,
  getUsageWarningLevel,
  getDismissedQuotaLevel,
  setDismissedQuotaLevel,
} from './session-usage';

/**
 * Session Store — central facade for session lifecycle management.
 *
 * Delegates to: session-tabs, session-polling,
 * session-usage, tiling, r2-readiness, preferences.
 */

// ── Session Metrics ─────────────────────────────────────────────────────────

export interface SessionMetrics {
  bucketName: string;
  syncStatus: 'pending' | 'syncing' | 'success' | 'failed' | 'skipped';
  cpu?: string;
  mem?: string;
  hdd?: string;
}

/** Batch status entry shape from the backend */
type BatchStatusEntry = {
  status: 'stopped' | 'starting' | 'running' | 'unreachable' | 'stopping';
  lifecycle?: 'stopped' | 'starting' | 'running' | 'unreachable' | 'stopping';
  generation?: number;
  revision?: number;
  unreachableDeadlineMs?: number;
  ptyActive?: boolean;
  startupStage?: string;
  lastStartedAt?: string;
  lastActiveAt?: string;
  editorReady?: boolean;
  editorReadyError?: boolean;
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
  preferences: UserPreferences;
  maxSessions: number;
  preseedUpgrading: boolean;
  preseedUpgradeFailed: boolean;
  managedReleaseStatus: 'current' | 'upgrading' | 'update_pending' | null;
  managedReleaseProgress: ManagedReleaseProgress | null;
  managedReleaseBlockedReason: 'runtime_incompatible' | null;
  /** REQ-ENTERPRISE-020: the bucket's encryption regime is migrating (Governed Mode flip). Reuses the Upgrading affordance to disable New Session. */
  bucketMigrating: boolean;
  /** REQ-ENTERPRISE-020: a Governed Mode flip is wanted but deferred until the user's running sessions stop (D1: no force-kill). */
  bucketMigrationPending: boolean;
  bucketMigrationHaltedAt: string | null;
  /** REQ-ENTERPRISE-020: 0–99 re-encrypt progress % for the Migrating button; null until the backend knows it. */
  bucketMigrationPercent: number | null;
  enterpriseMode: boolean;
  saasMode: boolean;
  /** Creation-selectable agents from GET /api/user; null only before hydration.
   * App supplies the legacy deployment-mode fallback when the field is absent. */
  allowedAgents: AgentType[] | null;
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
  preferences: {},
  maxSessions: 3,
  preseedUpgrading: false,
  preseedUpgradeFailed: false,
  managedReleaseStatus: null,
  managedReleaseProgress: null,
  managedReleaseBlockedReason: null,
  bucketMigrating: false,
  bucketMigrationPending: false,
  bucketMigrationHaltedAt: null,
  bucketMigrationPercent: null,
  enterpriseMode: false,
  saasMode: false,
  allowedAgents: null,
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
terminalStore.registerSessionStoppedCallback?.((sessionId) => {
  // The closed socket can belong to an older lifecycle. Only the existing
  // ordered D1 projection path may dispose the current session's workspace.
  if (localKillAttempts.has(sessionId)) return;
  void refreshSessionStatuses();
});

// Register R2 readiness dependencies (extracted to r2-readiness.ts)
registerR2ReadinessDeps({
  getR2Status: api.getR2Status,
  ensureR2Token: api.ensureR2Token,
});

// ── Core session helpers ────────────────────────────────────────────────────

function updateSessionStatus(id: string, status: SessionStatus, deferRunningEffects = false): void {
  const index = state.sessions.findIndex((sess) => sess.id === id);
  if (index !== -1) {
    if (status === 'stopped') {
      releaseKillAttempt(id);
    } else if (localKillAttempts.has(id)) {
      // Keep the local termination intent through an older live observation;
      // otherwise the mounted-runtime guard would mask the eventual exit.
      status = 'stopping';
    }
    setState('sessions', index, 'status', status);
    if (status === 'running' && !deferRunningEffects) {
      forgetCloneAttempt(id, true);
      markSessionStarted(id);
    }
    if (status === 'stopped' || status === 'stopping') clearSessionStartedGuard(id);
  }
}

function isSessionInitializing(sessionId: string): boolean {
  return state.initializingSessionIds[sessionId] === true;
}

/** One gate for every stopped/missing observation from eventually-consistent KV. */
function shouldRetainNegativeKv(sessionId: string): boolean {
  return localKillAttempts.has(sessionId)
    || isSessionInitializing(sessionId)
    || isWithinStartupGuard(sessionId)
    || terminalStore.ownsSession?.(sessionId) === true;
}

async function runPreseedUpdate<T>(operation: () => Promise<T>): Promise<T> {
  if (state.preseedUpgrading) throw new Error('Session environment update already in progress');
  setState('preseedUpgrading', true);
  try {
    return await operation();
  } finally {
    setState('preseedUpgrading', false);
  }
}

// Page-local attempt history survives stale/out-of-order target observations.
// Undefined groups older target-less responses into one observed upgrade episode.
const preseedAttempts = new Map<string | undefined, 'started' | 'completed' | 'failed'>();
let preseedUpgradeTarget: string | undefined;
let preseedUpgradeNeeded = false;
let preseedUpgradeEpoch = 0;

async function performPreseedUpgrade(): Promise<void> {
  if (!preseedUpgradeNeeded || state.preseedUpgrading) return;
  const target = preseedUpgradeTarget;
  const epoch = preseedUpgradeEpoch;
  preseedAttempts.set(target, 'started');
  setState('preseedUpgradeFailed', false);
  try {
    const result = await runPreseedUpdate(upgradeAgentConfigs);
    if (epoch !== preseedUpgradeEpoch) return;
    preseedAttempts.set(target, 'completed');
    if (!preseedUpgradeNeeded || target !== preseedUpgradeTarget || state.managedReleaseStatus !== 'upgrading') return;
    // Completion is observational; only a status check can establish current.
    const completion = result.managedReleaseProgress;
    if (completion && state.managedReleaseProgress?.phase !== 'finalizing') {
      setState('managedReleaseProgress', completion.total > 0
        ? { ...completion, phase: 'writing' }
        : completion);
    }
  } catch (err) {
    logger.warn('[SessionStore] preseed auto-upgrade failed:', err);
    if (epoch !== preseedUpgradeEpoch) return;
    preseedAttempts.set(target, 'failed');
    if (preseedUpgradeNeeded && target === preseedUpgradeTarget) setState('preseedUpgradeFailed', true);
  }
}

async function retryPreseedUpgrade(): Promise<void> {
  if (state.preseedUpgradeFailed) await performPreseedUpgrade();
}

function applyManagedReleaseBatch(
  status: 'current' | 'upgrading' | 'update_pending' | undefined,
  needsUpgrade: boolean | undefined,
  progress?: ManagedReleaseProgress,
  target?: string,
): void {
  if (status !== undefined) {
    setState('managedReleaseStatus', status);
    setState('managedReleaseProgress', status === 'upgrading' ? progress ?? null : null);
  }
  if (needsUpgrade === undefined) return;
  if (!needsUpgrade || status === 'current' || status === 'update_pending') {
    preseedUpgradeNeeded = false;
    preseedUpgradeEpoch++;
    preseedAttempts.clear();
    setState('preseedUpgradeFailed', false);
    return;
  }
  preseedUpgradeNeeded = true;
  preseedUpgradeTarget = target;
  setState('preseedUpgradeFailed', preseedAttempts.get(target) === 'failed');
  if (!preseedAttempts.has(target)) void performPreseedUpgrade();
}

// A local Stop owns its own confirmation poll; persisted stopping does not.
const localStopAttempts = new Map<string, { superseded: boolean }>();
const [terminationRevision, setTerminationRevision] = createSignal(0);
// Keep successful commands deduplicated until authoritative polling confirms exit.
const localKillAttempts = new Map<string, { request: Promise<void> | null; generation?: number }>();

function releaseKillAttempt(id: string): void {
  if (localKillAttempts.delete(id)) setTerminationRevision(value => value + 1);
}

function reconcileKillGeneration(id: string, deferRunningEffects = false): boolean {
  const attempt = localKillAttempts.get(id);
  const session = state.sessions.find((candidate) => candidate.id === id);
  if (!attempt || !session) return false;
  if (session.generation !== attempt.generation) {
    // A command for the old runtime must not pin a replacement as stopping.
    releaseKillAttempt(id);
    if (session.lifecycle) updateSessionStatus(id, session.lifecycle, deferRunningEffects);
    return session.lifecycle === 'running';
  } else if (session.status === 'stopped') {
    releaseKillAttempt(id);
  }
  return false;
}

function isLocallyStopping(id: string): boolean {
  return localStopAttempts.get(id)?.superseded === false;
}

// Register polling dependencies (extracted to session-polling.ts)
registerPollingDeps({
  getState: () => state,
  setStateProduce: (fn) => setState(produce(fn)),
  setStateRaw: (...args: any[]) => {
    (setState as any)(...args);
    if (args[0] === 'sessions' && args[2] === 'generation') {
      const session = state.sessions[args[1]];
      if (session) reconcileKillGeneration(session.id);
    }
  },
  updateSessionStatus,
  isSessionInitializing,
  isLocallyStopping,
  shouldRetainNegativeKv,
  setAuthExpired,
  applyMetricsUpdate,
  applyManagedReleaseBatch,
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
  const requestedCatalogRevision = getSessionCatalogRevision();
  let acceptedCatalogRevision = requestedCatalogRevision;
  const reportAvailability = beginSessionStatusRead();

  setState('loading', true);
  setState('error', null);

  let batchError: string | null = null;
  let batchAuthFailure = false;
  try {
    // Ancillary work owns its own values, never catalog availability.
    void refreshSessionAncillaryStatus().catch((err) => {
      logger.warn('[SessionStore] ancillary status refresh failed:', err);
    });
    const batchRequest = api.getBatchSessionStatus().catch((err) => {
      logger.warn('[SessionStore] getBatchSessionStatus failed:', err);
      batchError = err instanceof Error ? err.message : 'Failed to fetch session statuses';
      batchAuthFailure = err instanceof ApiError && err.status === 401;
      return { statuses: {} as Record<string, BatchStatusEntry> };
    });
    const sessions = await api.getSessions();
    if (thisGen !== loadSessionsGeneration || requestedCatalogRevision !== getSessionCatalogRevision()) return;

    const existingSessions = new Map(state.sessions.map(s => [s.id, s]));
    const existingStatuses = new Map(state.sessions.map(s => [s.id, s.status]));
    const oldIds = new Set(state.sessions.map(s => s.id));
    const listedIds = new Set(sessions.map(s => s.id));

    const sessionsWithStatus: SessionWithStatus[] = sessions.map((s) => {
      const local = existingSessions.get(s.id);
      const listedStatus = s.status ?? local?.status ?? 'stopped';
      const listed = {
        lifecycle: (s.lifecycle ?? listedStatus) as BackendLifecycle,
        generation: s.generation,
        revision: s.revision,
      };
      const localNewer = local && applyOrderedProjection({
        lifecycle: (local.lifecycle ?? (local.status === 'initializing' || local.status === 'error'
          ? 'running' : local.status)) as BackendLifecycle,
        generation: local.generation,
        revision: local.revision,
      }, listed) !== listed;
      if (local && localNewer) return local;
      const kill = localKillAttempts.get(s.id);
      const keepLocalStatus = local && (local.status === 'initializing'
        || (kill && kill.generation === s.generation && listedStatus !== 'stopped')
        || isLocallyStopping(s.id) || isSessionInitializing(s.id));
      return {
        ...s,
        status: keepLocalStatus && local ? local.status : listedStatus,
      };
    });
    // KV LIST may temporarily omit a recently written record. The same negative-
    // evidence gate used by polling decides whether local lifecycle ownership wins.
    for (const existing of existingSessions.values()) {
      if (!listedIds.has(existing.id) && shouldRetainNegativeKv(existing.id)) {
        sessionsWithStatus.push(existing);
      }
    }
    invalidateSessionStatusReads();
    acceptedCatalogRevision = getSessionCatalogRevision();
    sessionMissCounters.clear();
    setState('sessions', sessionsWithStatus);
    setState('loading', false);
    const provisionalRunning = new Set<string>();
    for (const session of state.sessions) {
      if (reconcileKillGeneration(session.id, true)) provisionalRunning.add(session.id);
    }
    // REQ-VAULT-034 AC2: sweep orphan legacy SilverBullet markers only after
    // an authoritative session-list fetch succeeds. Dashboard mount can
    // see the initial empty store before loadSessions resolves; sweeping
    // there deleted the active browser's Vault cache by mistake.
    void sweepOrphanVaultCaches(sessionsWithStatus.map((s) => s.id)).catch((err) =>
      logger.warn('vault orphan cache sweep failed', { error: err instanceof Error ? err.message : String(err) }),
    );

    const newIds = new Set(sessionsWithStatus.map(s => s.id));
    for (const id of oldIds) {
      if (!newIds.has(id)) {
        cleanupTerminalsForSession(id);
      }
    }

    // Publish the authoritative catalog before optional status enrichment.
    const batchResponse = await batchRequest;
    if (thisGen !== loadSessionsGeneration || acceptedCatalogRevision !== getSessionCatalogRevision()) return;
    if (batchError) {
      if (reportAvailability(batchAuthFailure ? sessionStatusUnavailable() : true)) setState('error', batchError);
    } else {
      reportAvailability(false);
    }
    const batchStatuses = batchResponse.statuses;

    for (const session of sessionsWithStatus) {
      if (thisGen !== loadSessionsGeneration) return;

      if (session.workspace === 'vscode') {
        cleanupTerminalsForSession(session.id);
      }

      const batchStatus = batchStatuses[session.id];
      if (!batchStatus) {
        continue;
      }

      const current = state.sessions.find((candidate) => candidate.id === session.id);
      const incomingProjection = {
        lifecycle: batchStatus.status as BackendLifecycle,
        generation: batchStatus.generation,
        revision: batchStatus.revision,
      };
      const ordered = applyOrderedProjection(
        {
          lifecycle: (current?.lifecycle ?? (current?.status === 'initializing' || current?.status === 'error' ? 'running' : current?.status ?? 'stopped')) as BackendLifecycle,
          generation: current?.generation,
          revision: current?.revision,
        },
        incomingProjection,
      );
      if (ordered !== incomingProjection) continue;

      // Propagate durable fields from batch-status. Terminal connectivity is
      // device-local and is never overwritten by a backend projection.
      const idx = state.sessions.findIndex(s => s.id === session.id);
      if (idx === -1) continue;
      if (batchStatus.lastActiveAt) setState('sessions', idx, 'lastActiveAt', batchStatus.lastActiveAt);
      if (batchStatus.lastStartedAt) setState('sessions', idx, 'lastStartedAt', batchStatus.lastStartedAt);
      setState('sessions', idx, 'startupStage', batchStatus.startupStage);
      if (batchStatus.editorReady !== undefined) setState('sessions', idx, 'editorReady', batchStatus.editorReady);
      setState('sessions', idx, 'editorReadyError', batchStatus.editorReadyError === true);

      // Populate sessionMetrics from batch-status metrics
      if (batchStatus.metrics) {
        setState(produce(s => {
          applyMetricsUpdate(s.sessionMetrics, session.id, batchStatus.metrics!);
        }));
      }

      const currentStatus = state.sessions.find((candidate) => candidate.id === session.id)?.status;
      if (isLocallyStopping(session.id)) continue;
      if (currentStatus === 'initializing' || isSessionInitializing(session.id)) {
        if (batchStatus.generation !== undefined && batchStatus.revision !== undefined) {
          setState('sessions', idx, { lifecycle: batchStatus.lifecycle ?? batchStatus.status,
            generation: batchStatus.generation, revision: batchStatus.revision });
        }
        continue;
      }
      if (batchStatus.status === 'stopped' && currentStatus !== 'stopping'
        && (batchStatus.generation === undefined || batchStatus.revision === undefined || isWithinStartupGuard(session.id))
        && shouldRetainNegativeKv(session.id)) continue;

      const wasRunning = existingStatuses.get(session.id) === 'running';
      updateSessionStatus(session.id, batchStatus.status);
      const latestIndex = state.sessions.findIndex((candidate) => candidate.id === session.id);
      if (latestIndex !== -1) {
        setState('sessions', latestIndex, 'lifecycle', batchStatus.lifecycle ?? batchStatus.status);
        if (batchStatus.generation !== undefined) setState('sessions', latestIndex, 'generation', batchStatus.generation);
        if (batchStatus.revision !== undefined) setState('sessions', latestIndex, 'revision', batchStatus.revision);
        if (batchStatus.unreachableDeadlineMs !== undefined) setState('sessions', latestIndex, 'unreachableDeadlineMs', batchStatus.unreachableDeadlineMs);
      }
      if (batchStatus.status === 'running') {
        if (!wasRunning && session.workspace !== 'vscode') {
          initializeTerminalsForSession(session.id);
        }
      } else if (wasRunning && batchStatus.status === 'stopped') {
        // Container stopped externally (hibernation/crash) — kill WS retry loops
        // so reconnect attempts don't keep waking the DO. Fresh connect() calls
        // are made when the user starts the session again.
        terminalStore.disposeSession(session.id);
      }
    }
    // Resolve list and batch order before disposing a previously stopping
    // transport: a newer running batch must retain the surviving connection.
    if (thisGen !== loadSessionsGeneration) return;
    for (const session of state.sessions) {
      reconcileKillGeneration(session.id);
      if (session.status === 'running') {
        forgetCloneAttempt(session.id, true);
        if (provisionalRunning.has(session.id)) markSessionStarted(session.id);
      }
      if (existingStatuses.get(session.id) === 'stopping' && session.status === 'stopped') {
        terminalStore.disposeSession(session.id);
      }
    }
  } catch (err) {
    if (thisGen !== loadSessionsGeneration || acceptedCatalogRevision !== getSessionCatalogRevision()
      || !reportAvailability(err instanceof ApiError && err.status === 401 ? sessionStatusUnavailable() : true)) return;
    setState('error', err instanceof Error ? err.message : 'Failed to load sessions');
  } finally {
    if (thisGen === loadSessionsGeneration) {
      setState('loading', false);
    }
  }
}

async function createSession(name: string, agentType?: AgentType, tabConfig?: TabConfig[], clone?: api.CreateSessionClone, surface?: PiSurface): Promise<SessionWithStatus | null> {
  try {
    const submittedTabConfig = state.preferences.herdrEnabled === true
      ? tabConfig?.slice(0, 1)
      : tabConfig;
    const session = surface
      ? await api.createSession(name, agentType, submittedTabConfig, clone, surface)
      : await api.createSession(name, agentType, submittedTabConfig, clone);
    const sessionWithStatus: SessionWithStatus = {
      ...session,
      status: 'stopped',
    };
    invalidateSessionStatusReads();
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

// Create a new session that clones `repo` at container start, then route it by
// its server-selected workspace: historical/Terminal sessions keep activation,
// while VS Code sessions start without taking terminal ownership. `ref` is omitted
// so the backend clones the repo's default branch. Return the saved ID even
// when Start fails or is cancelled so a retry does not create another session.
async function createSessionWithClone(repo: string, agentType?: AgentType): Promise<{ sessionId: string; started: boolean } | null> {
  // Name the session after the repo (owner/name -> name). An empty name would be
  // rejected by the backend (name is min(1) when present; only OMISSION falls
  // back to "Terminal"), and the repo name is a more useful label anyway.
  const name = repo.split('/')[1] || repo;
  const session = await createSession(name, agentType, undefined, { repo });
  if (!session) return null;
  const attempt = cloneAttempt(repo);
  if (attempt?.phase === 'creating') setCloneAttempt(repo, { ...attempt, sessionId: session.id });
  if (session.workspace !== 'vscode') {
    setActiveSession(session.id);
  }
  if (agentType) {
    void updateUserPreferences({ lastAgentType: agentType });
  }
  const started = await startSession(session.id).then(result => result !== 'cancelled', () => false);
  return { sessionId: session.id, started };
}

// Retry may not take over cleanup while Stop or Kill owns confirmation.
function canRetryCloneStart(id: string): boolean {
  // A termination owner can release after the final status is published.
  terminationRevision();
  const status = state.sessions.find(session => session.id === id)?.status;
  return (status === 'stopped' || status === 'error') && !isLocallyStopping(id) && !localKillAttempts.has(id);
}

async function retryCloneStart(id: string): Promise<boolean> {
  if (!canRetryCloneStart(id)) return false;
  return startSession(id).then(result => result !== 'cancelled', () => false);
}

async function renameSession(id: string, name: string): Promise<void> {
  try {
    // REQ-SESSION-027 AC2: the Worker sanitizes the requested name, so show the
    // name it accepted rather than the one typed.
    const updated = await api.updateSession(id, { name });
    const index = state.sessions.findIndex((s) => s.id === id);
    if (index !== -1) {
      setState('sessions', index, 'name', updated.name);
    }
  } catch (err) {
    setState('error', err instanceof Error ? err.message : 'Failed to rename session');
  }
}

async function deleteSession(id: string): Promise<void> {
  dismissRepositoryRestore(id);
  try {
    const startupCleanup = startupCleanups.get(id);
    if (startupCleanup) {
      startupCleanup();
      startupCleanups.delete(id);
    }
    await api.deleteSession(id);
    forgetCloneAttempt(id);
    invalidateSessionStatusReads();
    releaseKillAttempt(id);
    sessionMissCounters.delete(id);
    cleanupTerminalsForSession(id);
    // REQ-VAULT-034 AC1: drop legacy session-scoped SilverBullet localStorage markers.
    // Bucket-stable databases and SW registration remain untouched; best-effort and async
    // -- we do not block the UI on it.
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

interface RepositoryRestoreNotice {
  status: Exclude<RepositoryRestoreStatus, 'pending'>;
  repo?: string;
  repos?: string[];
  outcome?: CloneIntoSessionResult['outcome'];
}

const [repositoryRestoreNotices, setRepositoryRestoreNotices] = createStore<Record<string, RepositoryRestoreNotice>>({});
const repositoryRestoreTimers = new Map<string, ReturnType<typeof setTimeout>>();
const repositoryCloneRequests = new Map<string, symbol>();

function dismissRepositoryRestore(id: string): void {
  clearTimeout(repositoryRestoreTimers.get(id));
  repositoryRestoreTimers.delete(id);
  repositoryCloneRequests.delete(id);
  setRepositoryRestoreNotices(produce(notices => { delete notices[id]; }));
}

async function cloneRepositoryIntoSession(args: { repo: string; sessionId: string }): Promise<CloneIntoSessionResult> {
  const { sessionId: id, repo } = args;
  dismissRepositoryRestore(id);
  const request = Symbol();
  repositoryCloneRequests.set(id, request);
  setRepositoryRestoreNotices(id, { status: 'restoring', repo });

  const result = await cloneIntoSession(args);
  if (repositoryCloneRequests.get(id) === request) {
    repositoryCloneRequests.delete(id);
    setRepositoryRestoreNotices(id, {
      status: result.outcome === 'cloned' ? 'complete' : 'issues', repo, outcome: result.outcome,
    });
    if (result.outcome === 'cloned') {
      repositoryRestoreTimers.set(id, setTimeout(() => dismissRepositoryRestore(id), 5_000));
    }
  }
  return result;
}

function watchRepositoryRestore(id: string, generation: number, initial: RepositoryRestoreStatus, initialRepos?: string[]): void {
  let repos = initialRepos;
  let failures = 0;
  const deadline = Date.now() + 10 * 60_000;
  const ownsObservation = () => {
    const session = state.sessions.find(item => item.id === id);
    return !!session && (session.status === 'running' || session.status === 'unreachable')
      && (session.generation === undefined || session.generation <= generation);
  };
  const update = (status: RepositoryRestoreStatus) => {
    if (status !== 'pending') setRepositoryRestoreNotices(id, { status, ...(repos?.length ? { repos } : {}) });
    if (status === 'complete') {
      repositoryRestoreTimers.set(id, setTimeout(() => dismissRepositoryRestore(id), 5_000));
    } else if (status === 'pending' || status === 'restoring') {
      const timer = setTimeout(async () => {
        const current = () => repositoryRestoreTimers.get(id) === timer;
        if (!current()) return;
        if (!ownsObservation() || Date.now() >= deadline) {
          dismissRepositoryRestore(id);
          return;
        }
        try {
          const observation = await api.getStartupStatus(id);
          if (!current()) return;
          if (!ownsObservation() || (observation.generation !== undefined && observation.generation > generation)
            || (observation.generation === generation && (observation.confirmedStopped || observation.stage === 'error'))) {
            dismissRepositoryRestore(id);
            return;
          }
          if (observation.generation !== generation || !observation.details.repositoryRestore) {
            throw new Error('Repository restore status unavailable');
          }
          failures = 0;
          if (!repos?.length && observation.details.repositoryRestoreRepos?.length) repos = observation.details.repositoryRestoreRepos;
          update(observation.details.repositoryRestore);
        } catch {
          if (!current()) return;
          if (++failures >= MAX_STARTUP_POLL_ERRORS) dismissRepositoryRestore(id);
          else update(status);
        }
      }, SESSION_POLL_TRANSITION_MS);
      repositoryRestoreTimers.set(id, timer);
    } else {
      repositoryRestoreTimers.delete(id);
    }
  };
  update(initial);
}

function startSession(id: string, surface?: PiSurface): Promise<void | 'cancelled'> {
  dismissRepositoryRestore(id);
  const session = state.sessions.find((candidate) => candidate.id === id);
  const retryEditorTimeout = session?.workspace === 'vscode' && session.editorReadyError === true;

  startupCleanups.get(id)?.();
  startupCleanups.delete(id);
  return new Promise((resolve, reject) => {
    let pending = true;
    setState(
      produce((s) => {
        s.initializingSessionIds[id] = true;
        delete s.initProgressBySession[id];
      })
    );
    updateSessionStatus(id, 'initializing');

    const releaseUnconfirmedStart = (error: string) => {
      startupCleanups.delete(id);
      setState(produce((s) => {
        delete s.initializingSessionIds[id];
        delete s.initProgressBySession[id];
      }));
      const current = state.sessions.find((candidate) => candidate.id === id);
      if (current?.status === 'initializing') updateSessionStatus(id, current.lifecycle ?? 'stopped');
      void loadSessions();
      reject(new Error(error));
    };

    let readyProgress: InitProgress | undefined;
    const cleanup = api.startSession(
      id,
      (progress) => {
        if (!pending) return;
        if (progress.stage === 'ready') {
          readyProgress = progress; // Publish only after checking generation ownership below.
          return;
        }
        setState(
          produce((s) => {
            s.initProgressBySession[id] = progress;
          })
        );
      },
      (generation, revision) => {
        if (!pending) return;
        pending = false;
        const index = state.sessions.findIndex((session) => session.id === id);
        const current = state.sessions[index];
        if (!current || isLocallyStopping(id) || localKillAttempts.has(id)
          || (current.generation !== undefined && current.generation > generation)
          || (current.generation === generation && (current.lifecycle === 'stopped' || current.lifecycle === 'stopping'))) {
          releaseUnconfirmedStart('This Start was superseded.');
          return;
        }
        startupCleanups.delete(id);
        batch(() => {
          // Ready can advance Chat's projection even if a poll already saw this generation.
          if (surface === 'chat' && revision !== undefined && (generation > (current.generation ?? 0)
            || (generation === current.generation && (current.revision === undefined || revision > current.revision)))) {
            setState('sessions', index, { generation, lifecycle: 'running', revision });
          }
          updateSessionStatus(id, 'running');
        });
        const repositoryRestore = readyProgress?.repositoryRestore;
        if (current.workspace !== 'vscode' && repositoryRestore) watchRepositoryRestore(id, generation, repositoryRestore, readyProgress?.repositoryRestoreRepos);
        if (index !== -1 && state.sessions[index].workspace === 'vscode') {
          setState('sessions', index, 'editorReady', true);
          setState('sessions', index, 'editorReadyError', false);
          setState(produce((s) => {
            delete s.initializingSessionIds[id];
            delete s.initProgressBySession[id];
          }));
        } else {
          initializeTerminalsForSession(id);
          if (readyProgress) setState('initProgressBySession', id, readyProgress);
        }
        resolve();
      },
      (error, code) => {
        if (!pending) return;
        pending = false;
        if (code === 'SESSION_START_UNCONFIRMED') {
          releaseUnconfirmedStart(error);
          return;
        }
        startupCleanups.delete(id);
        setState(
          produce((s) => {
            delete s.initializingSessionIds[id];
            delete s.initProgressBySession[id];
          })
        );
        updateSessionStatus(id, 'error');
        setState('error', error);
        if (code === 'MANAGED_ENVIRONMENT_UPDATE_PENDING') {
          // The rejection itself is evidence of a blocked start, not of why it
          // is blocked. Show it immediately, then ask the managed-status owner
          // directly; an unrelated batch-status failure must not hide the gate.
          setState('managedReleaseStatus', 'update_pending');
          setState('managedReleaseProgress', null);
          // Keep the observed block visible if the follow-up read is unavailable.
          void refreshSessionAncillaryStatus().catch(() => undefined);
        }
        reject(new Error(error));
      },
      { retryEditorTimeout, ...(surface && { surface }) },
    );

    if (pending) startupCleanups.set(id, () => {
      pending = false;
      cleanup();
      // Cancellation settles the caller without publishing Ready or a startup error.
      resolve('cancelled');
    });
  });
}

async function stopSession(id: string): Promise<void> {
  dismissRepositoryRestore(id);
  const previous = localStopAttempts.get(id);
  if (previous && (!previous.superseded || localKillAttempts.has(id))) return;
  const attempt = { superseded: localKillAttempts.has(id) };
  const ownsStop = () => !attempt.superseded && localStopAttempts.get(id) === attempt;
  // A delayed Stop response can only confirm exit for its original runtime.
  const attemptedSession = state.sessions.find((session) => session.id === id);
  const generation = attemptedSession?.generation;
  const revision = attemptedSession?.revision;
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
    localStopAttempts.set(id, attempt);
    updateSessionStatus(id, 'stopping');
    await api.stopSession(id);
    // KILL takes confirmation ownership even if this HTTP caller was hung.
    if (!ownsStop()) return;

    // Poll batch-status until session reaches 'stopped' (sync may still be running)
    const pollForStopped = (): Promise<void> => {
      return new Promise((resolve) => {
        let pollCount = 0;
        let consecutiveErrors = 0;
        let finished = false;

        // Undefined confirmation is neutral cancellation, not a failed Stop.
        const finishStopPolling = (confirmed?: boolean) => {
          if (finished) return;
          if (!ownsStop()) confirmed = undefined;
          finished = true;
          clearInterval(interval);
          startupCleanups.delete(id);
          if (confirmed) {
            updateSessionStatus(id, 'stopped');
            terminalStore.disposeSession(id);
          } else if (confirmed === false) {
            setState('error', 'Stop could not be confirmed. Refresh status or retry stopping.');
          }
          resolve();
        };

        const interval = setInterval(async () => {
          if (!ownsStop()) {
            finishStopPolling();
            return;
          }
          pollCount++;

          if (pollCount >= MAX_STOP_POLL_ATTEMPTS) {
            finishStopPolling(false);
            return;
          }

          try {
            const batchResp = await api.getBatchSessionStatus();
            consecutiveErrors = 0;
            const sessionStatus = batchResp.statuses[id];
            if (finished) return;
            const current = state.sessions.find((session) => session.id === id);
            if (!current || current.generation !== generation) {
              finishStopPolling();
              return;
            }
            // Missing/unordered evidence is uncertainty, never positive exit.
            if (!sessionStatus || generation === undefined || revision === undefined
              || sessionStatus.generation !== generation || sessionStatus.revision === undefined) return;
            const incoming = {
              lifecycle: sessionStatus.status as BackendLifecycle,
              generation: sessionStatus.generation,
              revision: sessionStatus.revision,
            };
            const ordered = applyOrderedProjection({
              lifecycle: (current.lifecycle ?? 'stopping') as BackendLifecycle,
              generation: current.generation,
              revision: current.revision,
            }, incoming);
            // Catalog refresh may already have accepted this exit revision.
            // Ordering rejects stale evidence; only the original Stop needs a newer revision.
            if (ordered === incoming && incoming.lifecycle === 'stopped'
              && incoming.revision > revision) {
              const index = state.sessions.findIndex((session) => session.id === id);
              setState('sessions', index, 'lifecycle', incoming.lifecycle);
              setState('sessions', index, 'revision', incoming.revision);
              finishStopPolling(true);
            }
          } catch {
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_STOP_POLL_ERRORS) {
              finishStopPolling(false);
            }
          }
        }, STOP_POLL_INTERVAL_MS);

        // Cancellation must settle the caller and release its local attempt.
        startupCleanups.set(id, () => finishStopPolling());
      });
    };

    await pollForStopped();
  } catch (err) {
    if (ownsStop()) {
      setState('error', err instanceof Error ? err.message : 'Failed to stop session');
    }
  } finally {
    if (localStopAttempts.get(id) === attempt) {
      localStopAttempts.delete(id);
      setTerminationRevision(value => value + 1);
    }
  }
}

function killSession(id: string): Promise<void> {
  dismissRepositoryRestore(id);
  reconcileKillGeneration(id);
  const pending = localKillAttempts.get(id);
  if (pending?.request) return pending.request;

  const stop = localStopAttempts.get(id);
  if (stop) stop.superseded = true;
  startupCleanups.get(id)?.();
  startupCleanups.delete(id);
  setState(produce((s) => {
    delete s.initializingSessionIds[id];
    delete s.initProgressBySession[id];
  }));
  // This is local command intent, not exit evidence. Existing ordered status
  // polling remains responsible for confirming stopped and disposing transport.
  updateSessionStatus(id, 'stopping');

  const generation = state.sessions.find((session) => session.id === id)?.generation;
  const request: Promise<void> = api.killSession(id).catch((err) => {
    if (localKillAttempts.get(id)?.request === request) {
      // Uncertainty releases submission deduplication, not runtime ownership.
      localKillAttempts.set(id, { request: null, generation });
      setState('error', err instanceof Error ? err.message : 'Failed to kill session');
    }
  });
  localKillAttempts.set(id, { request, generation });
  return request;
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
  for (const id of new Set([...repositoryRestoreTimers.keys(), ...Object.keys(repositoryRestoreNotices)])) dismissRepositoryRestore(id);
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
  repositoryRestoreNotices,
  dismissRepositoryRestore,
  cloneRepositoryIntoSession,
  get sessions() { return state.sessions; },
  get activeSessionId() { return state.activeSessionId; },
  get loading() { return state.loading; },
  get error() { return state.error; },
  get statusUnavailable() { return sessionStatusUnavailable(); },
  getActiveSession,
  isSessionInitializing,
  getInitProgressForSession,
  getMetricsForSession,
  stopAllPolling,
  startSessionListPolling,
  stopSessionListPolling,
  loadSessions,
  createSession,
  createSessionWithClone,
  canRetryCloneStart,
  retryCloneStart,
  renameSession,
  deleteSession,
  startSession,
  stopSession,
  killSession,
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
  get preferences() { return state.preferences; },
  loadPreferences,
  updatePreferences: updateUserPreferences,
  runPreseedUpdate,
  retryPreseedUpgrade,
  refreshSessionAncillaryStatus,
  get maxSessions() { return state.maxSessions; },
  isAtSessionLimit,
  hasRecentContext,
  get preseedUpgrading() { return state.preseedUpgrading; },
  get preseedUpgradeFailed() { return state.preseedUpgradeFailed; },
  get managedReleaseStatus() { return state.managedReleaseStatus; },
  get managedReleaseProgress() { return state.managedReleaseProgress; },
  get managedReleaseBlockedReason() { return state.managedReleaseBlockedReason; },
  get bucketMigrating() { return state.bucketMigrating; },
  get bucketMigrationPending() { return state.bucketMigrationPending; },
  get bucketMigrationHaltedAt() { return state.bucketMigrationHaltedAt; },
  get bucketMigrationPercent() { return state.bucketMigrationPercent; },
  get enterpriseMode() { return state.enterpriseMode; },
  setEnterpriseMode: (value: boolean) => setState('enterpriseMode', value),
  get saasMode() { return state.saasMode; },
  setSaasMode: (value: boolean) => setState('saasMode', value),
  get allowedAgents() { return state.allowedAgents; },
  setAllowedAgents: (value: AgentType[] | null) => setState('allowedAgents', value),
  get r2Ready() { return isR2Ready(); },
  startR2Polling,
  stopR2Polling,
  get authExpired() { return authExpired(); },
  // @internal -- exposed for tests (AD23)
  updateSessionStatus,
  refreshSessionStatuses,
  _resetMissCounters: () => sessionMissCounters.clear(),
  _resetStartupGuards: () => resetStartupGuards(),
  _resetAuthExpired: () => setAuthExpired(false),
  _resetManagedCheckState: () => resetManagedCheckState(),
};
