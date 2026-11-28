import { createStore, produce } from 'solid-js/store';
import { batch, createSignal } from 'solid-js';
import type { SessionWithStatus, SessionStatus, ShutdownPhase, InitProgress, RepositoryRestoreStatus, SessionTerminals, AgentType, TabConfig, UserPreferences, PiSurface } from '../types';
import * as api from '../api/client';
import { ApiError } from '../api/fetch-helper';
import { upgradeAgentConfigs } from '../api/storage';
import { cloneIntoSession, type CloneIntoSessionResult } from '../api/github';
import type { ManagedReleaseProgress } from '../api/client';
import { terminalStore } from './terminal';
import { cloneAttempt, forgetCloneAttempt, setCloneAttempt } from './clone-attempts';
import { logger } from '../lib/logger';
import { applyOrderedProjection, isSessionCardVisible, isSessionCloneTarget, isShutdownInProgress, sessionCardStatus, type BackendLifecycle } from '../lib/session-presentation';
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
  completedStatusReadVersion,
  sessionMissCounters,
  refreshSessionStatuses,
  refreshAfterShutdownAccepted,
  noteAcceptedDelete,
  hasAcceptedDelete,
  clearAcceptedDelete,
  reconcileAcceptedDelete,
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
  updatedAt?: string;
  statusReadVersion?: number;
  generation?: number;
}

type BatchStatusResponse = Awaited<ReturnType<typeof api.getBatchSessionStatus>>;
type SessionInitProgress = InitProgress & { readyGeneration?: number };
type MemoryRetryAttempt = { token: symbol; generation?: number; revision?: number };

/**
 * Populate sessionMetrics from batch-status metrics.
 * Mutates the `sessionMetrics` record in place — designed for use inside `produce()` or direct object mutation.
 */
export function applyMetricsUpdate(
  sessionMetrics: Record<string, SessionMetrics>,
  sessionId: string,
  metrics: NonNullable<BatchStatusResponse['statuses'][string]['metrics']>,
  statusReadVersion?: number,
  generation?: number,
): void {
  const cached = sessionMetrics[sessionId];
  if (cached?.generation !== undefined && (generation === undefined || generation < cached.generation)) return;
  const previous = cached?.generation === generation ? cached : undefined;
  const usable = (value: string | undefined) => !!value && value !== '...';
  // Availability determines confirmation, not whether a reported sample is worth retaining.
  const useSample = [metrics.cpu, metrics.mem, metrics.hdd].some(usable)
    && (statusReadVersion ?? 0) >= (previous?.statusReadVersion ?? 0);
  const confirmed = statusReadVersion === undefined || statusReadVersion === completedStatusReadVersion();
  const retainMissing = !useSample || !confirmed;
  const reading = (value: string | undefined, lastKnown: string | undefined) =>
    useSample && usable(value) ? value : (retainMissing && lastKnown) || '...';
  const syncStatus = confirmed ? metrics.syncStatus as SessionMetrics['syncStatus'] | undefined : undefined;
  sessionMetrics[sessionId] = {
    bucketName: cached?.bucketName || '...',
    syncStatus: syncStatus || cached?.syncStatus || 'pending',
    cpu: reading(metrics.cpu, previous?.cpu),
    mem: reading(metrics.mem, previous?.mem),
    hdd: reading(metrics.hdd, previous?.hdd),
    updatedAt: useSample ? metrics.updatedAt : previous?.updatedAt,
    statusReadVersion: useSample ? statusReadVersion : previous?.statusReadVersion,
    generation,
  };
}

export interface SessionState {
  sessions: SessionWithStatus[];
  activeSessionId: string | null;
  loading: boolean;
  error: string | null;
  initializingSessionIds: Record<string, boolean>;
  initProgressBySession: Record<string, SessionInitProgress>;
  terminalsPerSession: Record<string, SessionTerminals>;
  sessionMetrics: Record<string, SessionMetrics>;
  memoryRetryAttempts: Partial<Record<string, MemoryRetryAttempt>>;
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
  memoryRetryAttempts: {},
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

function updateSessionStatus(id: string, status: SessionStatus, shutdownPhase?: ShutdownPhase): void {
  const index = state.sessions.findIndex((sess) => sess.id === id);
  if (index !== -1) {
    if (status === 'stopped' && !isShutdownInProgress(shutdownPhase)) {
      releaseKillAttempt(id);
    } else if (localKillAttempts.has(id)) {
      // Keep the local termination intent through an older live observation;
      // otherwise the mounted-runtime guard would mask the eventual exit.
      status = 'stopping';
    }
    setState('sessions', index, 'status', status);
    if (status === 'initializing') setState('sessions', index, 'cardStoppedGeneration', undefined);
    if (status === 'running') markSessionStarted(id);
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

// Legacy Stop owns its confirmation poll. A 202 hands projection to ordered reads
// but retains command deduplication until a newer read takes over.
interface StopAttempt { generation?: number; revision?: number; superseded: boolean; accepted: boolean }
const localStopAttempts = new Map<string, StopAttempt>();
const [terminationRevision, setTerminationRevision] = createSignal(0);
// Keep successful commands deduplicated until authoritative polling confirms exit.
const localKillAttempts = new Map<string, { request: Promise<void> | null; generation?: number }>();

function releaseKillAttempt(id: string): void {
  if (localKillAttempts.delete(id)) setTerminationRevision(value => value + 1);
}

function isMemoryRetryPending(id: string): boolean {
  return !!state.memoryRetryAttempts[id] || state.sessions.some(session => session.id === id && session.retryingMemory);
}

// A Retry acknowledgment isn't a phase projection. Release the local action
// lock only when an ordered read takes over, settles it, or replaces its generation.
function reconcileMemoryRetry(id: string, session?: SessionWithStatus): void {
  const attempt = state.memoryRetryAttempts[id];
  if (!attempt) return;
  if (!session || session.generation !== attempt.generation || session.retryingMemory
    || (!isShutdownInProgress(session.shutdownPhase)
      && session.revision !== undefined && session.revision > (attempt.revision ?? -1))) {
    setState('memoryRetryAttempts', id, undefined);
  }
}

function stoppedCardGeneration(id: string, incoming: Pick<SessionWithStatus, 'status' | 'generation' | 'revision'>,
  previous?: number): number | undefined {
  if (incoming.status !== 'stopped' || incoming.generation === undefined || incoming.revision === undefined) return undefined;
  const ready = state.initProgressBySession[id]?.readyGeneration;
  return incoming.generation === previous || (ready !== undefined && incoming.generation >= ready)
    ? incoming.generation : undefined;
}

function applyShutdownFields(index: number, incoming: BatchStatusResponse['statuses'][string], deferCloneRetirement = false): void {
  const { shutdownPhase, pendingDelete, retryingMemory, snapshotUnavailable } = incoming;
  const session = state.sessions[index];
  const cardStoppedGeneration = stoppedCardGeneration(session.id, incoming, session.cardStoppedGeneration);
  setState('sessions', index, { shutdownPhase, pendingDelete, retryingMemory, snapshotUnavailable, cardStoppedGeneration });
  reconcileMemoryRetry(session.id, session);
  reconcileAcceptedDelete(session.id, incoming);
  if (session.status !== 'initializing' && !isSessionInitializing(session.id)) {
    reconcileKillGeneration(session.id, incoming.status);
    if (!deferCloneRetirement && isSessionCloneTarget(session) && !provisionalRunning.has(session.id)) {
      forgetCloneAttempt(session.id, true);
    }
  }
}

function reconcileKillGeneration(id: string, projectedStatus?: SessionStatus): boolean {
  const attempt = localKillAttempts.get(id);
  const session = state.sessions.find((candidate) => candidate.id === id);
  if (!attempt || !session) return false;
  if (session.generation !== attempt.generation) {
    // A command for the old runtime must not pin a replacement as stopping.
    releaseKillAttempt(id);
    const status = projectedStatus ?? (session.shutdownPhase ? session.status : session.lifecycle);
    if (status) updateSessionStatus(id, status, session.shutdownPhase);
    return status === 'running' && !session.shutdownPhase;
  } else if (session.status === 'stopped' && !isShutdownInProgress(session.shutdownPhase)) {
    releaseKillAttempt(id);
  }
  return false;
}

function releaseStopAttempt(id: string, attempt: StopAttempt): void {
  if (localStopAttempts.get(id) !== attempt) return;
  localStopAttempts.delete(id);
  setTerminationRevision(value => value + 1);
}

function isLocallyStopping(id: string, incoming?: { generation?: number; revision?: number }): boolean {
  const attempt = localStopAttempts.get(id);
  if (!attempt || attempt.superseded) return false;
  if (incoming?.generation !== undefined && incoming.revision !== undefined) {
    if (attempt.generation !== undefined && incoming.generation > attempt.generation) {
      attempt.superseded = true;
      startupCleanups.get(id)?.();
      releaseStopAttempt(id, attempt);
      return false;
    }
    if (attempt.accepted && (attempt.generation === undefined || incoming.generation === attempt.generation)
      && incoming.revision > (attempt.revision ?? -1)) {
      releaseStopAttempt(id, attempt);
      return false;
    }
  }
  return true;
}

// Register polling dependencies (extracted to session-polling.ts)
registerPollingDeps({
  getState: () => state,
  setStateProduce: (fn) => setState(produce(fn)),
  setStateRaw: (...args: any[]) => (setState as any)(...args),
  updateSessionStatus,
  applyShutdownFields,
  removeConfirmedSession,
  isSessionInitializing,
  hasCompletedReady: (id) => state.initProgressBySession[id]?.readyGeneration !== undefined,
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
// A superseded catalog load leaves its provisional replacement for the winning load.
const provisionalRunning = new Map<string, { generation: number; revision: number }>();

async function loadSessions(): Promise<void> {
  const thisGen = ++loadSessionsGeneration;
  const requestedCatalogRevision = getSessionCatalogRevision();
  let acceptedCatalogRevision = requestedCatalogRevision;
  const { version, reportAvailability } = beginSessionStatusRead();

  setState('loading', true);
  setState('error', null);

  let batchError: string | null = null;
  let batchAuthFailure = false;
  try {
    // Ancillary work owns its own values, never catalog availability.
    void refreshSessionAncillaryStatus().catch((err) => {
      logger.warn('[SessionStore] ancillary status refresh failed:', err);
    });
    const batchRequest = api.getBatchSessionStatus().catch((err): BatchStatusResponse => {
      logger.warn('[SessionStore] getBatchSessionStatus failed:', err);
      batchError = err instanceof Error ? err.message : 'Failed to fetch session statuses';
      batchAuthFailure = err instanceof ApiError && err.status === 401;
      return { statuses: {} };
    });
    const sessions = await api.getSessions();
    if (thisGen !== loadSessionsGeneration || requestedCatalogRevision !== getSessionCatalogRevision()) return;

    const existingSessions = new Map(state.sessions.map(s => [s.id, s]));
    const existingStatuses = new Map(state.sessions.map(s => [s.id, s.status]));
    const previouslyShuttingDown = new Set(state.sessions.filter(s => isShutdownInProgress(s.shutdownPhase)).map(s => s.id));
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
        || (kill && kill.generation === s.generation && (listedStatus !== 'stopped' || isShutdownInProgress(s.shutdownPhase)))
        || isLocallyStopping(s.id, s) || isSessionInitializing(s.id));
      return {
        ...s,
        cardStoppedGeneration: stoppedCardGeneration(s.id, { ...s, status: listedStatus }, local?.cardStoppedGeneration),
        status: keepLocalStatus && local ? local.status : listedStatus,
      };
    });
    // KV LIST may temporarily omit a recently written record. The same negative-
    // evidence gate used by polling decides whether local lifecycle ownership wins.
    for (const existing of existingSessions.values()) {
      if (!listedIds.has(existing.id) && !existing.pendingDelete && !hasAcceptedDelete(existing) && shouldRetainNegativeKv(existing.id)) {
        sessionsWithStatus.push(existing);
      }
    }
    invalidateSessionStatusReads();
    acceptedCatalogRevision = getSessionCatalogRevision();
    sessionMissCounters.clear();
    setState(s => {
      // Publish the replacement and its cache together before the status batch arrives.
      let sessionMetrics = s.sessionMetrics;
      for (const { id, generation } of sessionsWithStatus) {
        const cached = sessionMetrics[id];
        if (cached && generation !== undefined && cached.generation !== generation) {
          if (sessionMetrics === s.sessionMetrics) sessionMetrics = { ...sessionMetrics };
          delete sessionMetrics[id];
        }
      }
      return { sessions: sessionsWithStatus, sessionMetrics, loading: false };
    });
    for (const [id, provisional] of provisionalRunning) {
      const current = sessionsWithStatus.find(session => session.id === id);
      if (current?.status !== 'running' || current.generation !== provisional.generation
        || current.revision === undefined || current.revision < provisional.revision) {
        provisionalRunning.delete(id);
      } else if (current.revision > provisional.revision) {
        provisionalRunning.set(id, { ...provisional, revision: current.revision });
      }
    }
    for (const session of state.sessions) {
      reconcileMemoryRetry(session.id, session);
      reconcileAcceptedDelete(session.id, session);
      if (reconcileKillGeneration(session.id) && session.generation !== undefined && session.revision !== undefined) {
        provisionalRunning.set(session.id, { generation: session.generation, revision: session.revision });
      }
    }
    // REQ-VAULT-034 AC2: sweep orphan legacy SilverBullet markers only after
    // an authoritative session-list fetch succeeds. Dashboard mount can
    // see the initial empty store before loadSessions resolves; sweeping
    // there deleted the active browser's Vault cache by mistake.
    void sweepOrphanVaultCaches(sessionsWithStatus.map((s) => s.id)).catch((err) =>
      logger.warn('vault orphan cache sweep failed', { error: err instanceof Error ? err.message : String(err) }),
    );

    const newIds = new Set(sessionsWithStatus.map(s => s.id));
    for (const session of existingSessions.values()) {
      if (!newIds.has(session.id)) removeConfirmedSession(session.id, session.pendingDelete || hasAcceptedDelete(session));
    }

    // Publish the authoritative catalog before optional status enrichment.
    const batchResponse = await batchRequest;
    if (thisGen !== loadSessionsGeneration || acceptedCatalogRevision !== getSessionCatalogRevision()) return;
    if (batchError !== null) {
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
      if (current?.cardMisses) setState('sessions', idx, 'cardMisses', undefined);
      if (batchStatus.lastActiveAt) setState('sessions', idx, 'lastActiveAt', batchStatus.lastActiveAt);
      if (batchStatus.lastStartedAt) setState('sessions', idx, 'lastStartedAt', batchStatus.lastStartedAt);
      setState('sessions', idx, 'startupStage', batchStatus.startupStage);
      if (batchStatus.editorReady !== undefined) setState('sessions', idx, 'editorReady', batchStatus.editorReady);
      setState('sessions', idx, 'editorReadyError', batchStatus.editorReadyError === true);

      if (batchStatus.metrics) {
        setState(produce(s => {
          applyMetricsUpdate(s.sessionMetrics, session.id, batchStatus.metrics!, version, batchStatus.generation);
        }));
      }

      const currentStatus = state.sessions.find((candidate) => candidate.id === session.id)?.status;
      if (isLocallyStopping(session.id, batchStatus)) continue;
      if (currentStatus === 'initializing' || isSessionInitializing(session.id)) {
        if (batchStatus.generation !== undefined && batchStatus.revision !== undefined) {
          batch(() => {
            setState('sessions', idx, { lifecycle: batchStatus.lifecycle ?? batchStatus.status,
              generation: batchStatus.generation, revision: batchStatus.revision });
            applyShutdownFields(idx, batchStatus, true);
          });
        }
        continue;
      }
      // The independent poll still sees startup protection. Only this catalog's
      // paired, strictly newer Stopped revision may supersede its provisional Running.
      const provisional = provisionalRunning.get(session.id);
      const pairedStopWins = provisional !== undefined && current !== undefined && current.generation === provisional.generation
        && current.revision === provisional.revision && batchStatus.generation === provisional.generation
        && batchStatus.revision !== undefined && batchStatus.revision > provisional.revision;
      if (batchStatus.status === 'stopped' && currentStatus !== 'stopping' && !pairedStopWins
        && (batchStatus.generation === undefined || batchStatus.revision === undefined
          || (isWithinStartupGuard(session.id) && !isShutdownInProgress(current?.shutdownPhase)
            && batchStatus.shutdownPhase !== 'memory-not-merged'))
        && shouldRetainNegativeKv(session.id)) continue;

      const wasRunning = existingStatuses.get(session.id) === 'running';
      batch(() => {
        updateSessionStatus(session.id, batchStatus.status, batchStatus.shutdownPhase);
        setState('sessions', idx, 'lifecycle', batchStatus.lifecycle ?? batchStatus.status);
        if (batchStatus.generation !== undefined) setState('sessions', idx, 'generation', batchStatus.generation);
        if (batchStatus.revision !== undefined) setState('sessions', idx, 'revision', batchStatus.revision);
        if (batchStatus.unreachableDeadlineMs !== undefined) setState('sessions', idx, 'unreachableDeadlineMs', batchStatus.unreachableDeadlineMs);
        applyShutdownFields(idx, batchStatus, true);
      });
      if (batchStatus.status === 'running') {
        if (!wasRunning && session.workspace !== 'vscode') {
          initializeTerminalsForSession(session.id);
        }
      }
    }
    // Resolve list and batch order before disposing a previously stopping
    // transport: a newer running batch must retain the surviving connection.
    if (thisGen !== loadSessionsGeneration) return;
    provisionalRunning.clear();
    for (const session of state.sessions) {
      reconcileKillGeneration(session.id);
      if (isSessionCloneTarget(session)) forgetCloneAttempt(session.id, true);
      const previous = existingStatuses.get(session.id);
      if (session.status === 'stopped' && !isShutdownInProgress(session.shutdownPhase)
        && (previous === 'running' || previous === 'stopping' || previouslyShuttingDown.has(session.id))) {
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

// One local launch, never inferred from an empty transcript or a resumed row.
const [freshChatStart, setFreshChatStart] = createSignal<{ id: string; generation: number }>();
const clearFreshChatStart = (id: string) => {
  setFreshChatStart(current => current?.id === id ? undefined : current);
};

// Create a new session that clones `repo` at container start, then route it by
// its server-selected workspace: historical/Terminal sessions keep activation,
// while VS Code sessions start without taking terminal ownership. `ref` is omitted
// so the backend clones the repo's default branch. Return the saved ID even
// when Start fails or is cancelled so a retry does not create another session.
async function createSessionWithClone(repo: string, agentType?: AgentType, surface?: 'chat'): Promise<{ sessionId: string; started: boolean } | null> {
  // Name the session after the repo (owner/name -> name). An empty name would be
  // rejected by the backend (name is min(1) when present; only OMISSION falls
  // back to "Terminal"), and the repo name is a more useful label anyway.
  const name = repo.split('/')[1] || repo;
  const launch = cloneAttempt(repo, surface);
  const session = await createSession(name, agentType, undefined, { repo }, surface);
  if (!session) return null;
  const attempt = cloneAttempt(repo, surface);
  if (attempt?.phase === 'creating') setCloneAttempt(repo, { ...attempt, sessionId: session.id }, surface);
  if (session.workspace !== 'vscode') {
    setActiveSession(session.id);
  }
  if (agentType && !surface) {
    void updateUserPreferences({ lastAgentType: agentType });
  }
  const freshChat = surface === 'chat' && launch?.phase === 'creating'
    && attempt?.phase === 'creating' && attempt.ticket === launch.ticket;
  const started = await startSession(session.id, surface, freshChat).then(result => result !== 'cancelled', () => false);
  return { sessionId: session.id, started };
}

// Retry may not take over cleanup while Stop or Kill owns confirmation.
function canRetryCloneStart(id: string): boolean {
  // A termination owner can release after the final status is published.
  terminationRevision();
  const session = state.sessions.find(session => session.id === id);
  if (!session || !isSessionCardVisible(session) || isShutdownInProgress(session.shutdownPhase) || isMemoryRetryPending(id)) return false;
  const status = sessionCardStatus(session);
  const stop = localStopAttempts.get(id);
  return (status === 'stopped' || status === 'error') && (!stop || stop.superseded) && !localKillAttempts.has(id);
}

async function retryCloneStart(id: string, surface?: 'chat'): Promise<boolean> {
  if (!canRetryCloneStart(id)) return false;
  if (surface === 'chat') setActiveSession(id);
  return startSession(id, surface).then(result => result !== 'cancelled', () => false);
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

function removeConfirmedSession(id: string, confirmedDelete = false): void {
  const session = state.sessions.find(candidate => candidate.id === id);
  // Ordinary catalog omissions hide Retry Start but do not erase saved clone recovery.
  const deleted = confirmedDelete || (session && (session.pendingDelete || hasAcceptedDelete(session)));
  if (deleted) {
    forgetCloneAttempt(id);
    startupCleanups.get(id)?.();
    startupCleanups.delete(id);
    dismissInitProgressForSession(id);
    dismissRepositoryRestore(id);
  }
  clearAcceptedDelete(id);
  releaseKillAttempt(id);
  const stop = localStopAttempts.get(id);
  if (stop) {
    stop.superseded = true;
    startupCleanups.get(id)?.();
    releaseStopAttempt(id, stop);
  }
  reconcileMemoryRetry(id);
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
}

async function deleteSession(id: string): Promise<void> {
  clearFreshChatStart(id);
  dismissRepositoryRestore(id);
  const attempted = state.sessions.find(session => session.id === id);
  const generation = attempted?.generation;
  const revision = attempted?.revision;
  try {
    const startupCleanup = startupCleanups.get(id);
    if (startupCleanup) {
      startupCleanup();
      startupCleanups.delete(id);
    }
    if (await api.deleteSession(id)) {
      const current = state.sessions.find(session => session.id === id);
      if (current && current.generation === generation) {
        noteAcceptedDelete(id, generation, revision);
        refreshAfterShutdownAccepted();
      }
      return;
    }
    invalidateSessionStatusReads();
    removeConfirmedSession(id, true);
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

function startSession(id: string, surface?: PiSurface, freshChat = false): Promise<void | 'cancelled'> {
  const session = state.sessions.find((candidate) => candidate.id === id);
  if (isMemoryRetryPending(id)) return Promise.reject(new Error('Memory consolidation is in progress.'));
  if (isShutdownInProgress(session?.shutdownPhase)) return Promise.reject(new Error('Session shutdown is in progress.'));
  dismissRepositoryRestore(id);
  const retryEditorTimeout = session?.workspace === 'vscode' && session.editorReadyError === true;

  startupCleanups.get(id)?.();
  startupCleanups.delete(id);
  // The first D1 launch advances generation zero to one. The Ready receipt
  // below must confirm that same generation before Open can use this intent.
  const launch = freshChat && surface === 'chat' && state.activeSessionId === id
    && session?.status === 'stopped' && session.generation === 0 ? { id, generation: 1 } : undefined;
  if (launch) setFreshChatStart(launch);
  else clearFreshChatStart(id);
  const abandonLaunch = () => setFreshChatStart(current => current === launch ? undefined : current);
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
      abandonLaunch();
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
      (generation, revision, claimedStart) => {
        if (!pending) return;
        pending = false;
        if (claimedStart !== true || generation !== launch?.generation || !readyProgress) abandonLaunch();
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
            const replacesGeneration = generation !== current.generation;
            setState('sessions', index, { generation, lifecycle: 'running', revision, ...(replacesGeneration && {
              shutdownPhase: undefined, pendingDelete: undefined, retryingMemory: undefined, snapshotUnavailable: undefined,
              cardMisses: undefined,
            }) });
            if (replacesGeneration) {
              clearAcceptedDelete(id);
              reconcileMemoryRetry(id, current);
            }
          }
          updateSessionStatus(id, 'running');
          if (isSessionCloneTarget(current)) forgetCloneAttempt(id, true);
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
          if (readyProgress) setState('initProgressBySession', id, { ...readyProgress, readyGeneration: generation });
        }
        resolve();
      },
      (error, code) => {
        if (!pending) return;
        pending = false;
        abandonLaunch();
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
      abandonLaunch();
      cleanup();
      // Cancellation settles the caller without publishing Ready or a startup error.
      resolve('cancelled');
    });
  });
}

async function retryMemoryConsolidation(id: string): Promise<void> {
  const session = state.sessions.find(candidate => candidate.id === id);
  if (!session || sessionCardStatus(session) !== 'stopped' || session.shutdownPhase !== 'memory-not-merged'
    || session.snapshotUnavailable || isMemoryRetryPending(id)) return;
  const token = Symbol();
  setState('memoryRetryAttempts', id, { token, generation: session.generation, revision: session.revision });
  try {
    await api.retryMemoryConsolidation(id);
    refreshAfterShutdownAccepted();
  } catch (err) {
    if (state.memoryRetryAttempts[id]?.token !== token) return;
    setState('memoryRetryAttempts', id, undefined);
    setState('error', err instanceof Error ? err.message : 'Failed to retry memory consolidation');
  }
}

async function stopSession(id: string): Promise<void> {
  clearFreshChatStart(id);
  dismissRepositoryRestore(id);
  const previous = localStopAttempts.get(id);
  if (previous && (!previous.superseded || localKillAttempts.has(id))) return;
  // A delayed Stop response can only confirm exit for its original runtime.
  const attemptedSession = state.sessions.find((session) => session.id === id);
  if (isShutdownInProgress(attemptedSession?.shutdownPhase)) return;
  const generation = attemptedSession?.generation;
  const revision = attemptedSession?.revision;
  const attempt: StopAttempt = { superseded: localKillAttempts.has(id), accepted: false, generation, revision };
  const ownsStop = () => !attempt.superseded && localStopAttempts.get(id) === attempt;
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
    const queued = await api.stopSession(id);
    // KILL takes confirmation ownership even if this HTTP caller was hung.
    if (!ownsStop()) return;
    if (queued) {
      // Durable shutdowns use ordered batch reads, not the legacy confirmation
      // deadline. Keep the local Stop intent until a newer projection takes over.
      attempt.accepted = !!attemptedSession;
      refreshAfterShutdownAccepted();
      return;
    }

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
    if (!attempt.accepted) releaseStopAttempt(id, attempt);
  }
}

function killSession(id: string): Promise<void> {
  clearFreshChatStart(id);
  dismissRepositoryRestore(id);
  reconcileKillGeneration(id);
  const pending = localKillAttempts.get(id);
  if (pending?.request) return pending.request;

  const stop = localStopAttempts.get(id);
  if (stop) {
    stop.superseded = true;
    if (stop.accepted) releaseStopAttempt(id, stop);
  }
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
  if (id !== state.activeSessionId) setFreshChatStart(undefined);
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
  clearFreshChatStart(sessionId);
  setState(
    produce((s) => {
      delete s.initializingSessionIds[sessionId];
      delete s.initProgressBySession[sessionId];
    })
  );
}

function getInitProgressForSession(sessionId: string): SessionInitProgress | null {
  return state.initProgressBySession[sessionId] || null;
}

function stopAllPolling(): void {
  setFreshChatStart(undefined);
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
  get freshChatStart() { return freshChatStart(); },
  get loading() { return state.loading; },
  get error() { return state.error; },
  get statusUnavailable() { return sessionStatusUnavailable(); },
  get completedStatusReadVersion() { return completedStatusReadVersion(); },
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
  retryMemoryConsolidation,
  isMemoryRetryPending,
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
