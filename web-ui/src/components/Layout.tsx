import { Component, batch, createSignal, createMemo, createEffect, createRoot, onMount, onCleanup, For, Show, untrack } from 'solid-js';
import Header from './Header';
import TerminalArea from './TerminalArea';
import PiWebChat, { type ChatPanelSize } from './PiWebChat';
import PiWebSwitchControls from './PiWebSwitchControls';
import { createPiWebSurface, isPiWebSwitchPending } from '../hooks/usePiWebSurface';
import type { PiWebStatus } from '../api/pi-web';
import { canChoosePiSurface, isPiWebSession } from '../lib/pi-web-session';
import { createMigrationRetry, MigrationRetryNotice } from './MigrationRetryNotice';
import SettingsPanel from './SettingsPanel';
import StoragePanel from './StoragePanel';
import SplashCursor from './SplashCursor';
import '../styles/layout.css';
import { sessionStore, getUsageWarningLevel, getDismissedQuotaLevel, setDismissedQuotaLevel } from '../stores/session';
import { isStartingChatClone } from '../stores/clone-attempts';
import { storageStore } from '../stores/storage';
import { terminalStore, reconnectDisconnectedTerminals, reconnectOnVisibilityReturn, scheduleDisconnect, cancelScheduledDisconnect } from '../stores/terminal';
import { terminalWorkspaceStore } from '../stores/terminal-workspace';
import { forceResetKeyboardState, enableVirtualKeyboardOverlay, isSamsungBrowser, cleanupDebugOverlay } from '../lib/mobile';
import { logger } from '../lib/logger';
import { loadSettings, applyAccentColor } from '../lib/settings';
import { resolveTerminalMode, type TileLayout, type AgentType, type TabConfig, type SessionWithStatus, type PiSurface, type VisibleTerminalPane } from '../types';
import { VIEW_TRANSITION_DURATION_MS, DASHBOARD_WS_DISCONNECT_DELAY_MS, SESSION_ID_RE } from '../lib/constants';
import { startVaultReadinessProbe, probeVaultReady } from '../lib/vault-readiness';
import { DEFAULT_VAULT_PREWARM_TIMEOUT_MS, startVaultPrewarm, type VaultPrewarmStatus } from '../lib/vault-prewarm';
import { checkVaultKeyRecoverable } from '../lib/vault-local-readiness';
import type { VaultButtonStatus } from './VaultButton';
import { requestBrowserStoragePersistence } from '../lib/browser-storage-persistence';
import { dashboardPath, parseSessionPath, sessionPath } from '../lib/session-path';
import { createBrowserIdeWindowOpener } from '../lib/browser-ide-window';
import { isMountedLifecycle } from '../lib/session-presentation';
import { parseCloudflareReturn, type CloudflareReturnOutcome } from '../lib/cloudflare-oauth-return';

type ViewState = 'dashboard' | 'expanding' | 'terminal' | 'collapsing';

const BROWSER_IDE_POPUP_BLOCKED_ERROR = 'Browser blocked the Browser IDE window. Allow pop-ups and try again.';
const BROWSER_IDE_INVALID_SESSION_ERROR = 'Browser IDE could not open because the session ID is invalid.';

export function clearPrewarmingVaultStatus(
  statuses: Record<string, VaultPrewarmStatus>,
  sessionId: string,
): Record<string, VaultPrewarmStatus> {
  if (statuses[sessionId] !== 'prewarming') return statuses;
  const next = { ...statuses };
  delete next[sessionId];
  return next;
}

function pruneNonRunningSessionState<T>(
  state: Record<string, T>,
  runningSessionIds: ReadonlySet<string>,
): Record<string, T> {
  const stoppedSessionIds = Object.keys(state).filter((sessionId) => !runningSessionIds.has(sessionId));
  if (stoppedSessionIds.length === 0) return state;
  const next = { ...state };
  for (const sessionId of stoppedSessionIds) delete next[sessionId];
  return next;
}

interface LayoutProps {
  userName?: string;
  userRole?: 'admin' | 'user';
  userSubscriptionTier?: import('../types').SubscriptionTier;
  onboardingActive?: boolean;
  enterpriseMode?: boolean;
  usageOpen?: boolean;
  mcpReturnOutcome?: import('../lib/mcp-portal-recovery').McpReturnOutcome;
}

/**
 * Main Layout component
 *
 * Structure:
 * +------------------------------------------------------------------+
 * | HEADER (48px)                                                     |
 * +------------------------------------------------------------------+
 * | MAIN CONTENT                                                      |
 * |                                                                   |
 * +------------------------------------------------------------------+
 */
const Layout: Component<LayoutProps> = (props) => {
  const openBrowserIdeWindow = createBrowserIdeWindowOpener();
  const usageWarning = () => getUsageWarningLevel();
  const [terminalError, setTerminalError] = createSignal<string | null>(null);
  const migrationRetry = createMigrationRetry();
  const [isSettingsOpen, setIsSettingsOpen] = createSignal(false);
  const [cloudflareReturn, setCloudflareReturn] = createSignal<CloudflareReturnOutcome>();
  const [isStoragePanelOpen, setIsStoragePanelOpen] = createSignal(false);
  const [showTilingOverlay, setShowTilingOverlay] = createSignal(false);
  const [viewState, setViewState] = createSignal<ViewState>('dashboard');
  const [startupSurface, setStartupSurface] = createSignal<{ id: string; surface: PiSurface; stoppedGeneration?: number }>();
  const selectStartupSurface = (session: SessionWithStatus, requestedSurface?: PiSurface) => {
    // Picker visibility limits choices, not the Host default for an existing Classic Pi workspace.
    const surface = requestedSurface ?? (isPiWebSession(session) && (sessionStore.allowedAgents?.includes('pi') ?? true) ? 'terminal' : undefined);
    const selection = surface ? { id: session.id, surface, stoppedGeneration: session.status === 'stopped' ? session.generation : undefined } : undefined;
    setStartupSurface(selection);
    return () => setStartupSurface(current => current === selection ? undefined : current);
  };
  type ChatFrame = { scope: ReturnType<typeof createPiWebSurface>; id: string; generation: number; url: string; requestId?: string };
  type RetainedChat = { frame: ChatFrame; status: PiWebStatus };
  const [retainedChats, setRetainedChats] = createSignal<RetainedChat[]>([]);
  const interruptedChat = new Map<string, { generation: number; requestId: string; before?: PiWebStatus; submitting?: ChatFrame['scope'] }>();
  const matchesInterruptedChat = (id: string, generation: number, status: PiWebStatus) => {
    const interrupted = interruptedChat.get(id);
    return interrupted?.generation === generation && interrupted.requestId === status.requestId
      && status.target === 'chat' && (isPiWebSwitchPending(status) || status.phase === 'complete');
  };
  const forgetChat = (id: string) => {
    interruptedChat.delete(id);
    setRetainedChats(entries => entries.filter(entry => entry.frame.id !== id));
  };
  const [retainedTerminal, setRetainedTerminal] = createSignal<{ pane: VisibleTerminalPane; generation: number }>();
  const clearRetainedTerminal = () => {
    const pane = retainedTerminal()?.pane;
    if (!pane) return;
    terminalStore.setParked(pane.sessionId, pane.terminalId, false);
    setRetainedTerminal(undefined);
  };
  // A logout navigation can place this document in the browser's back/forward cache.
  // Do not carry parked surfaces into that cached document.
  const discardParkedSurfaces = () => batch(() => {
    interruptedChat.clear();
    setRetainedChats([]);
    clearRetainedTerminal();
  });
  onMount(() => {
    window.addEventListener('pagehide', discardParkedSurfaces);
    onCleanup(() => window.removeEventListener('pagehide', discardParkedSurfaces));
  });
  onCleanup(clearRetainedTerminal);
  const [preferredOpen, setPreferredOpen] = createSignal<{ id: string; generation: number; target: PiSurface }>();
  const showTerminal = createMemo(() => viewState() === 'terminal' || viewState() === 'expanding');
  const showDashboard = createMemo(() => viewState() === 'dashboard' || viewState() === 'collapsing');

  const piWebSession = () => {
    if (!showTerminal()) {
      const terminal = retainedTerminal();
      const entries = retainedChats();
      const retained = terminal ? { id: terminal.pane.sessionId, generation: terminal.generation } : entries[entries.length - 1]?.frame;
      return retained && sessionStore.sessions.find(session => session.id === retained.id && session.generation === retained.generation
        && session.status === 'running' && session.lifecycle !== 'stopping' && isPiWebSession(session));
    }
    const session = sessionStore.getActiveSession();
    const startup = startupSurface();
    if (startup?.id === session?.id && startup?.stoppedGeneration !== undefined
      && (session?.generation ?? 0) <= startup.stoppedGeneration) return undefined;
    if (terminalWorkspaceStore.getActiveWorkspace().kind !== 'multiview'
      && session && SESSION_ID_RE.test(session.id) && isPiWebSession(session) && session.lifecycle !== 'stopping'
      && (session.status === 'running' || session.status === 'unreachable' || session.status === 'starting'
        || (session.status === 'initializing' && session.lifecycle !== 'stopped'))) return session;
    return undefined;
  };
  // Track identity independently of metrics, PTY readiness and D1 revision churn.
  const piWebSid = createMemo(() => piWebSession()?.id);
  const piWebGeneration = createMemo(() => piWebSession()?.generation);
  // A parked Chat keeps its read-only status observer until evicted. Retaining
  // the observer avoids reapplying the Dashboard's default surface on return.
  const observers = new Map<ChatFrame['scope'], () => void>();
  const activePi = createMemo((previous?: { id: string; generation: number; scope: ChatFrame['scope'] }) => {
    const id = piWebSid();
    const generation = piWebGeneration();
    if (!id || generation === undefined || generation < 1) return;
    if (previous && previous.id === id && previous.generation === generation) return previous;
    const parked = retainedChats().find(entry => entry.frame.id === id && entry.frame.generation === generation);
    const scope = parked?.frame.scope ?? createRoot(dispose => {
      const observer = createPiWebSurface(id, generation);
      observers.set(observer, dispose);
      return observer;
    });
    return { id, generation, scope };
  });
  const piWeb = () => activePi()?.scope;
  const piWebStatus = () => piWeb()?.status();
  createEffect(() => {
    const entries = retainedChats();
    const sessions = sessionStore.sessions;
    for (const [id, { generation }] of interruptedChat) {
      if (!sessions.some(session => session.id === id && session.generation === generation
        && session.status === 'running' && session.lifecycle !== 'stopping')) interruptedChat.delete(id);
    }
    const active = showTerminal() ? sessionStore.getActiveSession() : undefined;
    const valid = entries.filter(({ frame }) => {
      const status = frame.scope.status();
      return status?.surface === 'chat' && status.chatUrl === frame.url
        && (!status.requestId || status.target !== 'chat' || status.requestId === frame.requestId)
        && sessions.some(session => session.id === frame.id && session.generation === frame.generation
          && session.status === 'running' && session.lifecycle !== 'stopping' && isPiWebSession(session));
    });
    const keep = active && !valid.some(({ frame }) => frame.id === active.id && frame.generation === active.generation)
      ? valid.slice(-1) : valid;
    if (keep.length !== entries.length) setRetainedChats(keep);
  });
  createEffect(() => {
    const keep = new Set(retainedChats().map(entry => entry.frame.scope));
    const active = piWeb();
    if (active) keep.add(active);
    for (const [id, entry] of interruptedChat) {
      const submitting = entry.submitting;
      if (!submitting) continue;
      // Keep only the outstanding network command alive across navigation.
      // Once settled, only the request identity is needed for late publication.
      if (submitting.rejectedSwitchId() === entry.requestId) interruptedChat.delete(id);
      else if (submitting.mutation() === 'switch') keep.add(submitting);
      else entry.submitting = undefined;
    }
    for (const [scope, dispose] of observers) {
      if (!keep.has(scope)) { dispose(); observers.delete(scope); }
    }
  });
  onCleanup(() => { for (const dispose of observers.values()) dispose(); observers.clear(); });
  const rememberOpenChat = () => {
    const session = piWebSession();
    if (!showTerminal() || session?.status !== 'running' || !session.generation) return;
    const reported = piWebStatus();
    const displayed = displayedPi().surface;
    if (displayed === 'terminal') {
      const scope = piWeb();
      const submitted = scope?.submittedSwitch();
      const requestId = submitted?.target === 'chat' ? submitted.requestId
        : reported?.target === 'chat' && (isPiWebSwitchPending(reported) || reported.phase === 'complete')
          ? reported.requestId : undefined;
      if (requestId) interruptedChat.set(session.id, {
        generation: session.generation, requestId,
        submitting: submitted?.requestId === requestId ? scope : undefined,
        before: submitted?.requestId === requestId && reported?.surface === 'terminal' && reported.requestId !== requestId
          ? reported : undefined,
      });
    }
    const { frame, status } = shownChatStatus();
    if (displayed === 'chat' && frame && status?.surface === 'chat' && reported?.surface === 'chat'
      && !sessionStore.isSessionInitializing(session.id) && !chatStartupFailed()) {
      setRetainedChats(entries => [...entries.filter(entry => entry.frame.id !== frame.id), { frame, status }].slice(-2));
    }
  };
  const parkedTerminalPane = createMemo(() => {
    const retained = retainedTerminal();
    if (!retained) return;
    const session = sessionStore.sessions.find(row => row.id === retained.pane.sessionId);
    if (!session || session.generation !== retained.generation || session.status !== 'running' || session.lifecycle === 'stopping'
      || (isPiWebSession(session) && piWebStatus()?.surface !== 'terminal')) return;
    return retained.pane;
  });
  createEffect(() => {
    if (!showTerminal() && retainedTerminal() && !parkedTerminalPane()) clearRetainedTerminal();
  });
  const rememberOpenTerminal = () => {
    const session = sessionStore.getActiveSession();
    const workspace = terminalWorkspaceStore.getActiveWorkspace();
    if (!showTerminal() || workspace.kind !== 'session' || !session?.generation || session.status !== 'running'
      || session.lifecycle === 'stopping' || sessionStore.isSessionInitializing(session.id)
      || (isPiWebSession(session) && piWebStatus()?.surface !== 'terminal')
      || (resolveTerminalMode(session.terminalMode) !== 'herdr' && sessionStore.getTilingForSession(session.id)?.enabled)) return;
    const pane = terminalWorkspaceStore.getVisiblePanes().find(row => row.source === 'session' && row.sessionId === session.id);
    if (!pane || terminalStore.getConnectionState(pane.sessionId, pane.terminalId) !== 'connected') return;
    terminalStore.setParked(pane.sessionId, pane.terminalId, true);
    setRetainedTerminal({ pane, generation: session.generation });
  };
  const piWebSwitchingTarget = () => piWeb()?.switchingTarget();
  const modeAvailable = () => canChoosePiSurface(sessionStore.preferences, sessionStore.allowedAgents);
  createEffect(() => {
    const intent = preferredOpen();
    if (!intent) return;
    const handoff = piWeb();
    if (intent.id !== piWebSid() || intent.generation !== piWebGeneration() || handoff?.unavailable() || !modeAvailable()) {
      setPreferredOpen(undefined);
      return;
    }
    const status = handoff?.status();
    if (!status) return;
    const interrupted = interruptedChat.get(intent.id);
    const before = interrupted?.generation === intent.generation ? interrupted.before : undefined;
    setPreferredOpen(undefined);
    // The Host can still report the outgoing writer before publishing the POST.
    // An unchanged status is not evidence that another request superseded ours.
    if (before && status.surface === before.surface && status.phase === before.phase
      && status.requestId === before.requestId && status.target === before.target) return;
    if (matchesInterruptedChat(intent.id, intent.generation, status)) return;
    interruptedChat.delete(intent.id);
    // Don't restart an existing writer, interrupt another handoff, or replay a failed one.
    if ((status.phase === 'active' || status.phase === 'complete') && status.surface && status.surface !== intent.target) {
      handoff?.select(intent.target);
    }
  });
  const selectedStartupSurface = () => {
    const selection = startupSurface();
    return selection?.id === sessionStore.activeSessionId ? selection?.surface : undefined;
  };
  const awaitingChatStart = () => selectedStartupSurface() === 'chat';
  const terminalIdForSession = (session: Pick<SessionWithStatus, 'id' | 'terminalMode'>) =>
    resolveTerminalMode(session.terminalMode) === 'herdr'
      ? '1'
      : sessionStore.getTerminalsForSession(session.id)?.activeTabId || '1';

  const tiledSlotCount = (layout: TileLayout) => {
    if (layout === '4-grid') return 4;
    if (layout === '3-split') return 3;
    return layout === '2-split' ? 2 : 1;
  };

  const renderedClassicTabIds = (session: Pick<SessionWithStatus, 'id' | 'terminalMode'>) => {
    if (resolveTerminalMode(session.terminalMode) !== 'classic') return;
    const terminals = sessionStore.getTerminalsForSession(session.id);
    const tiling = sessionStore.getTilingForSession(session.id);
    if (!terminals || !tiling?.enabled) return;
    const ids = new Set(terminals.tabs.map(tab => tab.id));
    return (sessionStore.getTabOrder(session.id) ?? []).filter(id => ids.has(id)).slice(0, tiledSlotCount(tiling.layout));
  };

  const [chatLoad, setChatLoad] = createSignal<{ frame: ChatFrame; state: 'ready' | 'failed' }>();
  const chatLoadFor = (state: 'ready' | 'failed', requestId?: string) => {
    const load = chatLoad();
    return load?.frame.scope === piWeb() && load?.state === state
      && (requestId === undefined || load.frame.requestId === requestId);
  };
  const codeAttachment = createMemo((previous?: { scope: ReturnType<typeof piWeb>; requestId: string; terminalId: string }) => {
    const scope = piWeb();
    const session = piWebSession();
    const status = scope?.status();
    if (!session || status?.phase !== 'complete' || status.target !== 'terminal' || status.surface !== 'terminal' || !status.requestId) return;
    const selected = terminalIdForSession(session);
    const rendered = renderedClassicTabIds(session);
    const terminalId = rendered ? (rendered.includes(selected) ? selected : rendered[0]) : selected;
    if (!terminalId) return;
    return previous?.scope === scope && previous?.requestId === status.requestId && previous.terminalId === terminalId
      ? previous : { scope, requestId: status.requestId, terminalId };
  });
  const [attachedCode, setAttachedCode] = createSignal<NonNullable<ReturnType<typeof codeAttachment>>>();
  const preserveModeFocusOnAttach = () => {
    const attached = attachedCode();
    // The terminal autofocus effect can run more than once for this handoff.
    return !!attached && attached.scope === piWeb() && attached.requestId === piWebStatus()?.requestId
      && !!document.activeElement?.closest('[data-workspace-mode-focus]');
  };
  const prepareCodeAttachment = createMemo(() => {
    const attempt = codeAttachment();
    return attempt && {
      terminalId: attempt.terminalId,
      onAttached: () => {
        if (codeAttachment() !== attempt) return;
        batch(() => {
          const session = piWebSession();
          if (session && terminalIdForSession(session) !== attempt.terminalId) handleTileClick(attempt.terminalId);
          setAttachedCode(attempt);
        });
      },
    };
  });
  // Rendering and writer admission are separate: keep the previous view until
  // the confirmed destination has finished preparing its browser attachment.
  const displayedPi = createMemo((previous?: { scope: ReturnType<typeof piWeb>; surface?: PiSurface }) => {
    const scope = piWeb();
    const status = scope?.status();
    const active = activePi();
    const resumePreparingChat = active && status && matchesInterruptedChat(active.id, active.generation, status);
    const last = (previous?.scope === scope ? previous?.surface : undefined)
      ?? (resumePreparingChat ? 'terminal' : undefined);
    if (!scope || !status) return { scope, surface: last };
    if (isPiWebSwitchPending(status) && last) return { scope, surface: last };
    if (status.phase === 'complete' && status.requestId && last && status.surface && last !== status.surface) {
      const ready = status.surface === 'chat'
        ? chatLoadFor('ready', status.requestId)
        : attachedCode() !== undefined && attachedCode() === codeAttachment();
      if (!ready) return { scope, surface: last };
    }
    return { scope, surface: status.surface ?? undefined };
  });
  const handoffTarget = () => {
    const status = piWebStatus();
    const shown = displayedPi().surface;
    if (!shown || status?.phase === 'failed' || status?.phase === 'uncertain') return undefined;
    return piWebSwitchingTarget() ?? (isPiWebSwitchPending(status) ? status?.target :
      status?.phase === 'complete' && status.surface !== shown ? status.surface ?? undefined : undefined);
  };
  const prepareNativeTerminal = () => (handoffTarget() === 'terminal' && piWebStatus()?.surface === 'terminal')
    || (handoffTarget() === 'chat' && displayedPi().surface === 'terminal' && !!(piWebStatus()?.startupQuestion || chatStartupFailed()));
  const preparePiWebPanel = () => handoffTarget() === 'chat';
  const shownChatStatus = createMemo((previous?: { frame?: ChatFrame; status?: NonNullable<ReturnType<typeof piWebStatus>> }) => {
    const active = activePi();
    const scope = active?.scope;
    const status = piWebStatus();
    if (active && scope && status?.chatUrl && (status.surface === 'chat' || status.target === 'chat' && status.phase === 'opening')) {
      const requestId = status.target === 'chat' && (status.phase === 'opening' || status.phase === 'complete')
        ? status.requestId : undefined;
      const old = previous?.frame?.scope === scope ? previous.frame
        : retainedChats().find(entry => entry.frame.scope === scope)?.frame;
      const frame = old?.scope === scope && old.url === status.chatUrl && (!requestId || requestId === old.requestId)
        ? old : { scope, id: active.id, generation: active.generation, url: status.chatUrl, requestId };
      return { frame, status };
    }
    if (previous?.frame?.scope === scope && displayedPi().surface === 'chat' && handoffTarget() === 'terminal') {
      return { frame: previous?.frame, status: previous?.status };
    }
    return {};
  });
  const chatFrames = createMemo(() => {
    const active = shownChatStatus().frame;
    const parked = retainedChats().map(entry => entry.frame).filter(frame => frame.scope !== active?.scope);
    // Retain insertion-independent DOM order so changing selection never moves an iframe.
    return (active ? [...parked.slice(-1), active] : parked).sort((a, b) => a.id.localeCompare(b.id) || a.generation - b.generation);
  });
  const reportChatLoad = (frame: ChatFrame, state: 'ready' | 'failed', value: boolean) => {
    if (shownChatStatus().frame !== frame) return;
    if (value && state === 'ready' && interruptedChat.get(frame.id)?.requestId === frame.requestId) interruptedChat.delete(frame.id);
    setChatLoad(previous => value ? { frame, state } : previous?.frame === frame && previous.state === state ? undefined : previous);
  };
  const chatStartupReady = () => chatLoad()?.frame === shownChatStatus().frame && chatLoad()?.state === 'ready';
  const chatStartupFailed = () => chatLoad()?.frame === shownChatStatus().frame && chatLoad()?.state === 'failed';
  const showPiWebPanel = createMemo(() => {
    const status = piWebStatus();
    const displayed = displayedPi().surface;
    if (displayed) return displayed === 'chat' || !!status?.startupQuestion || (preparePiWebPanel() && chatStartupFailed());
    if (status) return status.surface !== 'terminal' && !(status.phase === 'failed' && status.target === 'terminal' && status.surface === null);
    if (selectedStartupSurface() === 'terminal') return false;
    return awaitingChatStart() || (!!piWeb() && piWebSession()?.status === 'running'
      && (!piWeb()?.unavailable() || !!piWeb()?.mutation() || !!piWeb()?.canRetry()));
  });
  createEffect(() => {
    if (selectedStartupSurface() && piWebStatus()?.surface) setStartupSurface(undefined);
  });
  const [chatPanelSizes, setChatPanelSizes] = createSignal(new Map<ChatFrame, ChatPanelSize>());
  const activeChatPanelSize = () => {
    const frame = shownChatStatus().frame;
    return frame && chatPanelSizes().get(frame);
  };
  const reportChatPanelSize = (frame: ChatFrame, size?: ChatPanelSize) => setChatPanelSizes(current => {
    if (!size && !current.has(frame)) return current;
    const next = new Map(current);
    if (size) next.set(frame, size);
    else next.delete(frame);
    return next;
  });
  const showOpenChatPanel = createMemo(() => {
    const id = piWebSid();
    return !!id && showTerminal() && showPiWebPanel() && displayedPi().surface === 'chat'
      && !!shownChatStatus().frame && !sessionStore.isSessionInitializing(id);
  });
  const piWebProblem = () => piWeb()?.mutationError()
    ?? (piWeb()?.unavailable() && (piWebStatus() || awaitingChatStart()) ? 'Could not read the current Pi surface.' : undefined);
  const canCancelPiWeb = () => !!piWebStatus()?.requestId && piWeb()?.mutation() !== 'cancel';
  const retryPiWeb = () => {
    const handoff = piWeb();
    if (!modeAvailable() || !handoff?.canRetry()) return undefined;
    return () => { if (modeAvailable() && piWeb() === handoff) handoff.retry(); };
  };
  const cancelPiWeb = () => piWeb()?.cancel();
  const saveMode = (target: PiSurface) => {
    if (modeAvailable()) void sessionStore.updatePreferences({ defaultPiSurface: target });
  };
  const canSwitchMode = () => {
    const session = piWebSession();
    if (session?.status !== 'running' || !piWebStatus()?.surface) return false;
    const interrupted = interruptedChat.get(session.id);
    const submitting = interrupted && interrupted.generation === session.generation && interrupted.submitting?.mutation() === 'switch';
    return !submitting && !handoffTarget() && !isPiWebSwitchPending(piWebStatus()) && !piWeb()?.mutation() && !retryPiWeb();
  };
  const dashboardWorkspaceMode = () => modeAvailable()
    ? { value: sessionStore.preferences.defaultPiSurface ?? 'terminal' as const, onSelect: saveMode }
    : undefined;
  const sessionWorkspaceMode = () => modeAvailable() && piWebSession()
    ? { value: displayedPi().surface ?? sessionStore.preferences.defaultPiSurface ?? 'terminal' as const,
      pendingTarget: handoffTarget(),
      disabled: !canSwitchMode(), onSelect: (target: PiSurface) => {
        if (!modeAvailable() || !canSwitchMode()) return;
        piWeb()?.select(target);
        saveMode(target);
      } }
    : undefined;

  let viewTransitionTimer: ReturnType<typeof setTimeout> | undefined;

  const clearViewTransitionTimer = () => {
    if (viewTransitionTimer) {
      clearTimeout(viewTransitionTimer);
      viewTransitionTimer = undefined;
    }
  };
  onCleanup(clearViewTransitionTimer);

  // Vault readiness: ground-truth probe via the server. We can't trust
  // session status flags here — the SilverBullet supervisor starts late in
  // entrypoint.sh (well after ptyActive flips), so a session-level "ready"
  // signal would lie. probeVaultReady() polls `GET /api/vault/:sid/status`,
  // which runs the SB-reachability check server-side and returns 200 +
  // { vaultReady }; it reports ready only when SB is actually serving, with
  // none of the 502 / timeout-abort console noise the old HEAD-the-proxy
  // probe produced while SB warmed up. Keyed per session so a switch resets it.
  //
  // Lifecycle: warm-up probes every WARMUP_INTERVAL_MS forever until the
  // first success (REQ-VAULT-018 AC2). After first success we switch to a
  // steady re-probe to catch SB crashing mid-session (container still
  // "running", proxy returns 502); a failed re-probe clears the latch so
  // the button disables itself and the warmup chain restarts.
  const WARMUP_INTERVAL_MS = 5000;
  const STEADY_INTERVAL_MS = 60000; // post-ready slow re-probe cadence
  const VAULT_KEY_POLL_INTERVAL_MS = 2000; // cadence for re-checking key recoverability while preparing
  const [vaultReadyBySession, setVaultReadyBySession] = createSignal<Record<string, boolean>>({});
  const [vaultPrewarmBySession, setVaultPrewarmBySession] = createSignal<Record<string, VaultPrewarmStatus>>({});
  const [vaultPrewarmRetryBySession, setVaultPrewarmRetryBySession] = createSignal<Record<string, number>>({});
  // Click-guard open intent (REQ-VAULT-018 / REQ-VAULT-022): 'preparing' = key not yet
  // recoverable (button breathes accent), 'armed' = key recoverable (button
  // breathes green, next click opens). Absent = no pending open.
  const [vaultOpenIntentBySession, setVaultOpenIntentBySession] = createSignal<Record<string, 'preparing' | 'armed'>>({});
  const [vaultPersistenceRequestedBySession, setVaultPersistenceRequestedBySession] = createSignal<Record<string, boolean>>({});
  // Memoize the running-flag so the effect only re-runs when running-ness
  // actually flips, not on every metrics/ptyActive churn from session
  // polling. Without this the probe chain restarts on every status tick.
  const activeRunningSid = createMemo<string | null>(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid) return null;
    const s = sessionStore.sessions.find((x) => x.id === sid);
    // Vault only exists in advanced session mode (matches the vault-button gate
    // below). In standard mode SilverBullet does not run, so probing
    // HEAD /api/vault/:sid/ would 502 on a loop - gate the probe on the mode.
    if (sessionStore.preferences.sessionMode !== 'advanced') return null;
    return s && s.status === 'running' ? sid : null;
  });
  // In-memory Vault state belongs to the running session, not to whichever view
  // happens to be active. Dashboard navigation and mobile visibility recovery can
  // temporarily clear activeSessionId while the container keeps running; preserve
  // those latches so returning opens immediately. Session status is authoritative:
  // once a session is absent or no longer running, discard all transient Vault state
  // so a later restart under the same id derives readiness from scratch.
  createEffect(() => {
    const runningSessionIds = new Set(
      sessionStore.sessions
        .filter((session) => session.status === 'running')
        .map((session) => session.id),
    );
    setVaultReadyBySession((prev) => pruneNonRunningSessionState(prev, runningSessionIds));
    setVaultPrewarmBySession((prev) => pruneNonRunningSessionState(prev, runningSessionIds));
    setVaultPrewarmRetryBySession((prev) => pruneNonRunningSessionState(prev, runningSessionIds));
    setVaultOpenIntentBySession((prev) => pruneNonRunningSessionState(prev, runningSessionIds));
    setVaultPersistenceRequestedBySession((prev) => pruneNonRunningSessionState(prev, runningSessionIds));
  });

  createEffect(() => {
    const sid = activeRunningSid();
    if (!sid) return;

    // `untrack` so the latch reads do not subscribe the effect to its own
    // writes (steady() clears the latch on crash; tracking would spawn a
    // parallel warmup chain via effect re-run).
    const cancel = startVaultReadinessProbe({
      probe: () => probeVaultReady(sid),
      setLatch: () => setVaultReadyBySession((prev) => {
        if (prev[sid] === true) return prev;
        return { ...prev, [sid]: true };
      }),
      clearLatch: () => {
        setVaultReadyBySession((prev) => {
          if (prev[sid] !== true) return prev;
          const next = { ...prev };
          delete next[sid];
          return next;
        });
        setVaultPrewarmBySession((prev) => {
          if (!prev[sid]) return prev;
          const next = { ...prev };
          delete next[sid];
          return next;
        });
        setVaultPrewarmRetryBySession((prev) => {
          if (prev[sid] === undefined) return prev;
          const next = { ...prev };
          delete next[sid];
          return next;
        });
        clearVaultOpenIntent(sid);
      },
      initiallyReady: () => untrack(vaultReadyBySession)[sid] === true,
      warmupIntervalMs: WARMUP_INTERVAL_MS,
      steadyIntervalMs: STEADY_INTERVAL_MS,
    });
    onCleanup(cancel);
  });
  // Best-effort, once per session: ask the browser to keep the Vault cache from
  // being evicted. Triggered on the first prewarm (click 1), not on idle mount.
  const requestVaultStoragePersistenceOnce = (sid: string) => {
    if (untrack(vaultPersistenceRequestedBySession)[sid] === true) return;
    setVaultPersistenceRequestedBySession((prev) => ({ ...prev, [sid]: true }));
    void requestBrowserStoragePersistence().then((result) => {
      if (result.supported && result.granted === false) {
        logger.warn('browser denied persistent storage for Vault cache', { sid });
      }
    }).catch((err) => logger.warn('browser storage persistence check failed', {
      sid,
      error: err instanceof Error ? err.message : String(err),
    }));
  };

  // On-demand prewarm (REQ-VAULT-018 / REQ-VAULT-020): the bootstrap iframe is
  // mounted ONLY after the user requests the vault (click 1 -> open-intent
  // 'preparing'). We never prewarm automatically — that left the user staring at
  // an empty vault for up to two minutes and forced a manual reload. Re-runs on a
  // retry-nonce bump (timeout/error) and tears the iframe down once the cycle ends.
  createEffect(() => {
    const sid = activeRunningSid();
    if (!sid || vaultReadyBySession()[sid] !== true) return;
    if (vaultOpenIntentBySession()[sid] !== 'preparing') return; // wait for click 1
    const retryNonce = vaultPrewarmRetryBySession()[sid] ?? 0;
    void retryNonce;
    const current = untrack(vaultPrewarmBySession)[sid];
    if (current === 'ready' || current === 'prewarming') return;

    setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'prewarming' }));
    requestVaultStoragePersistenceOnce(sid);

    let handle: ReturnType<typeof startVaultPrewarm> = null;
    const mountPrewarm = () => {
      handle = startVaultPrewarm({
        sessionId: sid,
        timeoutMs: DEFAULT_VAULT_PREWARM_TIMEOUT_MS,
        onReady: () => setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'ready' })),
        onError: (status) => setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: status })),
      });
    };
    mountPrewarm();
    onCleanup(() => {
      handle?.cancel();
      setVaultPrewarmBySession((prev) => clearPrewarmingVaultStatus(prev, sid));
    });
  });

  // Button lifecycle: idle (SB server not ready) -> available (neutral; server
  // ready, click 1 to prepare) -> preparing (accent breathe, indexing on demand)
  // -> armed (GREEN). Once the vault is ready the button is green and STAYS green
  // for the rest of the session; a warm/returning session shows green immediately
  // and opens on a single click. Green is deliberately NOT gated on any open/settle
  // latch: the mobile standalone PWA reloads on return from the vault tab, so any
  // settle-on-return state diverged per-platform and caused the green-forever
  // (mobile) vs never-green (desktop) bugs. "Ready = green, always" has no
  // reload-dependent state, so mobile / tablet / desktop behave identically.
  const vaultButtonStatus = createMemo<VaultButtonStatus>(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid || vaultReadyBySession()[sid] !== true) return 'idle';
    const intent = vaultOpenIntentBySession()[sid];
    if (intent === 'armed') return 'armed';
    const pw = vaultPrewarmBySession()[sid];
    if (intent === 'preparing') {
      if (pw === 'error') return 'error';
      if (pw === 'timeout') return 'timeout';
      return 'preparing';
    }
    // No open-intent: green (and openable on a single click) once the vault is
    // ready in this dashboard lifetime, including return from the Vault tab.
    if (pw === 'ready') return 'armed';
    return 'available';
  });

  const vaultReady = createMemo(() => vaultButtonStatus() === 'armed');

  const clearVaultOpenIntent = (sid: string) =>
    setVaultOpenIntentBySession((prev) => {
      if (prev[sid] === undefined) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });

  const openVaultTab = (sid: string) => {
    // Clear the open-intent so the button falls back to the steady green "ready"
    // state (pw === 'ready') after opening, rather than any transient armed-intent.
    clearVaultOpenIntent(sid);
    // Open via the bootstrap-hop, NOT the bare shell: the hop posts the AES key to
    // the SW and waits for activation before redirecting to the editor, so the
    // first open never races the SW's single-shot __cfRecover. The bare-shell open
    // carried the bootstrap cookie, skipped the hop, and (when the key had been
    // flushed after prewarm) lost that race -> auth-error -> top-level /.auth 403 (#3).
    window.open(`/api/vault/${sid}/.codeflare-bootstrap`, '_blank', 'noopener');
  };

  // Keep browser opening synchronous and isolated behind one explicit gesture
  // seam. Startup, selection, readiness, and routing never call this.
  const openVscodeSession = (sessionId: string) => {
    const result = openBrowserIdeWindow(sessionId);
    if (result === 'blocked') {
      setTerminalError(BROWSER_IDE_POPUP_BLOCKED_ERROR);
    } else if (result === 'invalid-session') {
      setTerminalError(BROWSER_IDE_INVALID_SESSION_ERROR);
    } else {
      setTerminalError((error) => (
        error === BROWSER_IDE_POPUP_BLOCKED_ERROR || error === BROWSER_IDE_INVALID_SESSION_ERROR
          ? null
          : error
      ));
    }
  };

  const handleVaultOpen = () => {
    const sid = sessionStore.activeSessionId;
    if (!sid || untrack(vaultReadyBySession)[sid] !== true) return;
    const intent = untrack(vaultOpenIntentBySession)[sid];
    // Mid-prepare clicks are no-ops while work is active. A visible timeout or
    // error retries only on the user's next click; there is no hidden retry loop.
    if (intent === 'preparing') {
      const status = untrack(vaultPrewarmBySession)[sid];
      if (status === 'timeout' || status === 'error') {
        setVaultPrewarmRetryBySession((prev) => ({ ...prev, [sid]: (prev[sid] ?? 0) + 1 }));
      }
      return;
    }
    // Green == ready == open. Both the cold-path armed intent (click 2 after a fresh
    // prewarm) and a steady pw==='ready' after returning from the Vault tab in this
    // dashboard lifetime open immediately via the bootstrap-hop. The hop
    // re-posts the AES key to the service worker and waits for activation before
    // redirecting to the editor, and the worker no longer flushes the key mid-transition
    // (REQ-VAULT-024 AC4), so opening directly never races a wiped key into a `.auth`
    // bounce. Opening synchronously inside the click gesture also avoids the pop-up
    // blocker. (Previously the pw==='ready' branch re-verified local readiness + key
    // recoverability and, on a false-negative, dropped into a full ~10s on-demand
    // re-prewarm — making every in-session reopen of the green button "re-index" before
    // opening even though the persisted store was healthy: REQ-VAULT-022 AC1.)
    if (intent === 'armed' || untrack(vaultPrewarmBySession)[sid] === 'ready') {
      openVaultTab(sid);
      return;
    }
    // Click 1 (available): start the on-demand prewarm; the button breathes accent
    // and shows the focus-loss warning until indexing completes.
    setVaultOpenIntentBySession((prev) => ({ ...prev, [sid]: 'preparing' }));
  };

  // While 'preparing', poll until the prewarm proof is ready AND the encryption key
  // is recoverable, then arm (button breathes green, next click opens). The key fetch
  // short-circuits behind the prewarm proof, so once the proof lands re-fetching
  // `/.vault-key` each tick also keeps an idle container warm until the open.
  createEffect(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid || vaultOpenIntentBySession()[sid] !== 'preparing') return;
    // Tracked read: re-run (and re-tick immediately) when the prewarm flips to ready,
    // so arming does not wait for the next poll interval.
    const prewarmReady = vaultPrewarmBySession()[sid] === 'ready';
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      const ready = prewarmReady && (await checkVaultKeyRecoverable(sid));
      if (cancelled) return;
      if (ready) {
        setVaultOpenIntentBySession((prev) => (prev[sid] === 'preparing' ? { ...prev, [sid]: 'armed' } : prev));
        return;
      }
      timer = setTimeout(() => void tick(), VAULT_KEY_POLL_INTERVAL_MS);
    };
    void tick();
    onCleanup(() => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    });
  });

  // Load the authenticated user's sessions before resolving a deep link. The
  // store is the ownership boundary: a syntactically valid ID is not selectable
  // until it appears in this loaded list.
  onMount(() => {
    if (window.location.pathname === dashboardPath()) {
      const query = new URLSearchParams(window.location.search);
      const outcome = parseCloudflareReturn(query.get('cloudflare'));
      if (outcome) {
        query.delete('cloudflare');
        const rest = query.toString();
        window.history.replaceState(window.history.state, '', `${dashboardPath()}${rest ? `?${rest}` : ''}${window.location.hash}`);
        setCloudflareReturn(outcome);
        setIsSettingsOpen(true);
      }
    }

    let disposed = false;
    let routeReady = false;
    const handlePopState = () => {
      if (routeReady) reconcileLocation(true);
    };
    window.addEventListener('popstate', handlePopState);

    void Promise.resolve(sessionStore.loadSessions()).then(() => {
      if (disposed) return;
      routeReady = true;
      reconcileLocation(false);
    });
    sessionStore.loadPreferences();
    // Apply saved accent color
    const savedSettings = loadSettings();
    applyAccentColor(savedSettings.accentColor);

    onCleanup(() => {
      disposed = true;
      window.removeEventListener('popstate', handlePopState);
    });
  });

  // Poll session statuses (metrics, status changes) regardless of view state
  // so dashboard cards always show fresh CPU/mem/HDD when the user returns.
  // refreshSessionStatuses() updates in-place and won't trigger viewState flips.
  onMount(() => {
    sessionStore.startSessionListPolling();
    storageStore.fetchStats();
  });

  const visibleTerminalKeys = createMemo(() => {
    const activeWorkspace = terminalWorkspaceStore.getActiveWorkspace();
    const sessionId = activeWorkspace && activeWorkspace.kind === 'session' ? activeWorkspace.sessionId : null;
    const session = sessionId ? sessionStore.sessions.find((candidate) => candidate.id === sessionId) : null;
    const rendered = session && renderedClassicTabIds(session);
    if (rendered) return rendered.map(id => `${sessionId}:${id}`);
    return terminalWorkspaceStore.getVisiblePanes().map((pane) => `${pane.sessionId}:${pane.terminalId}`);
  });

  // Auto-refresh sessions + storage when tab returns from background
  const handleVisibilityChange = () => {
    if (!document.hidden) {
      sessionStore.refreshSessionStatuses?.();
      void storageStore.refreshListingOnReturn?.();
    }
  };
  onMount(() => document.addEventListener('visibilitychange', handleVisibilityChange));

  onCleanup(() => {
    sessionStore.stopSessionListPolling();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    cleanupDebugOverlay();
  });

  // On Dashboard the one parked socket is exempt from the disconnect timer.
  // On foreground return, lift that guard before reconnecting any dropped socket.
  createEffect(() => {
    const foreground = showTerminal();
    if (foreground) untrack(clearRetainedTerminal);
    if (foreground && prepareCodeAttachment() && prepareNativeTerminal()) {
      cancelScheduledDisconnect();
    } else if (!foreground || showPiWebPanel()) {
      scheduleDisconnect(DASHBOARD_WS_DISCONNECT_DELAY_MS);
    } else {
      cancelScheduledDisconnect();
      reconnectDisconnectedTerminals(undefined, visibleTerminalKeys());
    }
  });

  // Reconnect stale WebSockets when the browser tab regains focus.
  // Without this, returning after ~5 min finds exhausted retry loops and
  // a stuck "Reconnecting..." overlay that only clears on full page refresh.
  {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !showTerminal()) return;
      const preparing = prepareNativeTerminal() && codeAttachment();
      if (preparing && showPiWebPanel()) {
        reconnectOnVisibilityReturn(undefined, [`${piWebSid()}:${preparing.terminalId}`]);
        return;
      }
      if (!showPiWebPanel()) {
        forceResetKeyboardState();

        if (isSamsungBrowser) {
          // Samsung: bounce through dashboard to fully reset keyboard state.
          // Samsung's VirtualKeyboard API returns stale cached values on resume
          // and no combination of signal resets fixes it reliably. The only path
          // that always works is deactivate→reactivate, which triggers the full
          // Terminal keyboard lifecycle cleanup and re-init.
          const sessionId = untrack(() => sessionStore.activeSessionId);
          if (sessionId) {
            sessionStore.setActiveSession(null);
            setViewState('dashboard');
            setTimeout(() => {
              sessionStore.setActiveSession(sessionId);
              setViewState('terminal');
              setTimeout(() => terminalStore.triggerLayoutResize(), 50);
              reconnectOnVisibilityReturn(undefined, visibleTerminalKeys());
            }, 50);
            return;
          }
        }

        setTimeout(() => {
          if (viewState() !== 'dashboard' && !showPiWebPanel()) enableVirtualKeyboardOverlay();
        }, 300);
        reconnectOnVisibilityReturn(undefined, visibleTerminalKeys());
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    onCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));
  }

  let chatCloneRoute: string | undefined;

  // Sync viewState with terminal-owned session state. Missing workspace fields
  // are historical Terminal sessions; only explicit `vscode` stays dashboard-owned.
  createEffect(() => {
    const session = sessionStore.getActiveSession();
    const hasActiveTerminal = session
      && session.workspace !== 'vscode'
      && (session.status === 'initializing' || sessionStore.isSessionInitializing(session.id)
        || (session.status !== 'error' && isMountedLifecycle(session.status as 'stopped' | 'starting' | 'running' | 'unreachable' | 'stopping')));
    const hasActiveMultiView = terminalWorkspaceStore.getActiveWorkspace().kind === 'multiview';
    if (chatCloneRoute && (session?.id !== chatCloneRoute || session.status === 'running')) chatCloneRoute = undefined;

    if ((hasActiveTerminal || hasActiveMultiView) && viewState() === 'dashboard') {
      if (session && hasActiveTerminal && !hasActiveMultiView && isStartingChatClone(session.id)) {
        untrack(() => openSessionWorkspace(session.id));
        return;
      }
      setViewState('terminal');
      setTimeout(() => terminalStore.triggerLayoutResize(), 50);
    } else if (!hasActiveTerminal && !hasActiveMultiView && viewState() === 'terminal') {
      if (chatCloneRoute && parseSessionPath(window.location.pathname) === chatCloneRoute) {
        writeHistoryPath(dashboardPath(), 'replace');
        setStartupSurface(undefined);
      }
      chatCloneRoute = undefined;
      terminalWorkspaceStore.setDashboardWorkspace();
      setViewState('dashboard');
    }
  });

  // Handlers
  const enterTerminalView = () => {
    clearViewTransitionTimer();
    setViewState('expanding');
    viewTransitionTimer = setTimeout(() => {
      viewTransitionTimer = undefined;
      setViewState('terminal');
      terminalStore.triggerLayoutResize();
    }, VIEW_TRANSITION_DURATION_MS);
  };

  const writeHistoryPath = (pathname: string, mode: 'push' | 'replace') => {
    if (window.location.pathname === pathname && !window.location.search && !window.location.hash) return;
    if (mode === 'replace') {
      window.history.replaceState(null, '', pathname);
    } else {
      window.history.pushState(null, '', pathname);
    }
  };

  const writeSessionHistoryPath = (id: string, mode: 'push' | 'replace') => {
    try {
      writeHistoryPath(sessionPath(id), mode);
    } catch {
      // A malformed store entry can remain usable through existing workspace
      // controls, but it must never become a canonical deep link.
    }
  };

  const keepDashboardOwnership = (historyMode?: 'push' | 'replace') => {
    batch(() => {
      rememberOpenChat();
      rememberOpenTerminal();
      setViewState('dashboard');
      terminalWorkspaceStore.setDashboardWorkspace();
      setShowTilingOverlay(false);
      clearViewTransitionTimer();
      sessionStore.setActiveSession(null);
    });
    if (historyMode) writeHistoryPath(dashboardPath(), historyMode);
  };

  createEffect(() => {
    if (props.usageOpen) untrack(keepDashboardOwnership);
  });

  const openSessionWorkspace = (
    id: string,
    options: { shouldStart?: boolean; updateHistory?: boolean; explicitVscodeOpen?: boolean; surface?: PiSurface } = {},
  ) => {
    const session = sessionStore.sessions.find((candidate) => candidate.id === id);
    if (!session) return;
    const { shouldStart = false, updateHistory = true, explicitVscodeOpen = false } = options;
    setPreferredOpen(undefined);
    if (!explicitVscodeOpen && session.workspace !== 'vscode') {
      rememberOpenChat();
      if (shouldStart) forgetChat(id);
    }
    if (id !== retainedTerminal()?.pane.sessionId || shouldStart || explicitVscodeOpen) clearRetainedTerminal();

    if (explicitVscodeOpen) {
      openVscodeSession(id);
      return;
    }

    if (session.workspace === 'vscode') {
      keepDashboardOwnership(updateHistory ? 'push' : undefined);
      if (shouldStart) void sessionStore.startSession(id).catch(() => {});
      return;
    }

    const eligible = modeAvailable() && isPiWebSession(session);
    const preferredSurface = eligible ? sessionStore.preferences.defaultPiSurface : undefined;
    const surface = eligible ? options.surface ?? (shouldStart ? preferredSurface : undefined) : undefined;
    if (!shouldStart && isStartingChatClone(id)) {
      if (session.status !== 'running') chatCloneRoute = id;
      selectStartupSurface(session, 'chat');
    } else if (!shouldStart && startupSurface()?.id !== id) {
      setStartupSurface(undefined);
    }
    const clearStartup = shouldStart ? selectStartupSurface(session, surface) : undefined;
    const parkedPane = parkedTerminalPane();
    const warmReturn = parkedPane?.sessionId === id
      || retainedChats().some(entry => entry.frame.id === id && entry.frame.generation === session.generation);
    const terminalId = shouldStart ? '1' : parkedPane?.terminalId ?? terminalIdForSession(session);
    batch(() => {
      sessionStore.setActiveSession(id);
      terminalWorkspaceStore.setSingleSessionWorkspace(id, terminalId, session);
      enterTerminalView();
    });
    if (updateHistory) writeSessionHistoryPath(id, 'push');
    if (shouldStart) {
      void (surface ? sessionStore.startSession(id, surface) : sessionStore.startSession(id))
        .then(outcome => { if (outcome === 'cancelled') clearStartup?.(); }, () => clearStartup?.());
    } else if (surface && session.status === 'running') {
      const handoff = piWeb();
      if (handoff) handoff.select(surface);
      else setTerminalError('Could not read the current session generation.');
    } else if (!warmReturn && !options.surface && updateHistory && preferredSurface
      && session.status === 'running' && session.generation) {
      setPreferredOpen({ id, generation: session.generation, target: preferredSurface });
    }
  };

  const handleVscodeOpen = () => {
    const session = sessionStore.getActiveSession();
    if (!session) return;
    openSessionWorkspace(session.id, { explicitVscodeOpen: true, updateHistory: false });
  };

  const handleSelectSession = (id: string) => {
    const session = sessionStore.sessions.find((s) => s.id === id);
    if (session && (session.status === 'initializing'
      || (session.status !== 'error' && isMountedLifecycle(session.status as 'stopped' | 'starting' | 'running' | 'unreachable' | 'stopping')))) {
      openSessionWorkspace(id);
    } else if (session?.status === 'stopped') {
      openSessionWorkspace(id, { shouldStart: true });
    }
  };

  const handleStartSession = async (id: string, selectedSurface?: PiSurface) => {
    const session = sessionStore.sessions.find((candidate) => candidate.id === id);
    if (!session) return;
    const eligible = modeAvailable() && isPiWebSession(session);
    const surface = eligible ? selectedSurface ?? sessionStore.preferences.defaultPiSurface : undefined;
    const clearStartup = selectStartupSurface(session, surface);

    if (session.workspace === 'vscode') {
      keepDashboardOwnership('push');
    } else {
      sessionStore.setActiveSession(id);
      terminalWorkspaceStore.setSingleSessionWorkspace(id, terminalIdForSession(session), session);
      enterTerminalView();
      writeSessionHistoryPath(id, 'push');
    }
    try {
      const outcome = await (surface ? sessionStore.startSession(id, surface) : sessionStore.startSession(id));
      if (outcome === 'cancelled') clearStartup();
    } catch (err) {
      clearStartup();
      logger.error('Failed to start session:', err);
    }
  };

  const handleStopSession = async (id: string) => {
    forgetChat(id);
    if (retainedTerminal()?.pane.sessionId === id) clearRetainedTerminal();
    await batch(() => {
      const stop = sessionStore.stopSession(id);
      setStartupSurface(current => current?.id === id ? undefined : current);
      return stop;
    });
  };

  const handleDeleteSession = async (id: string) => {
    forgetChat(id);
    if (retainedTerminal()?.pane.sessionId === id) clearRetainedTerminal();
    await sessionStore.deleteSession(id);
  };

  const [launchingVibe, setLaunchingVibe] = createSignal(false);
  const createAndStartSession = async (name: string, agentType?: AgentType, tabConfig?: TabConfig[], selectedSurface?: PiSurface, implicitAgent = false, repo?: string) => {
    const surface = modeAvailable() ? selectedSurface : undefined;
    if (repo && surface !== 'chat') return;
    const session = surface
      ? await sessionStore.createSession(name, agentType, tabConfig, repo ? { repo } : undefined, surface)
      : await sessionStore.createSession(name, agentType, tabConfig);
    if (!session) return;
    const eligible = modeAvailable() && isPiWebSession(session);
    const initialSurface = eligible ? surface ?? sessionStore.preferences.defaultPiSurface : undefined;
    const clearStartup = selectStartupSurface(session, initialSurface);

    if (session.workspace === 'vscode') {
      keepDashboardOwnership('push');
    } else {
      sessionStore.setActiveSession(session.id);
      terminalWorkspaceStore.setSingleSessionWorkspace(session.id, terminalIdForSession(session), session);
      enterTerminalView();
      writeSessionHistoryPath(session.id, 'push');
    }
    // Update preferences with last-used agent type
    if (agentType && !implicitAgent) {
      sessionStore.updatePreferences({ lastAgentType: agentType });
    }
    try {
      const outcome = await (initialSurface ? sessionStore.startSession(session.id, initialSurface) : sessionStore.startSession(session.id));
      if (outcome === 'cancelled') clearStartup();
    } catch (error) {
      clearStartup();
      throw error;
    }
  };

  const handleCreateSession: typeof createAndStartSession = async (name, agent, tabs, surface, implicitAgent, repo) => {
    if (implicitAgent && launchingVibe()) return;
    if (implicitAgent) setLaunchingVibe(true);
    try { await createAndStartSession(name, agent, tabs, surface, implicitAgent, repo); }
    finally { if (implicitAgent) setLaunchingVibe(false); }
  };

  const handleOpenMultiView = () => {
    if (!terminalWorkspaceStore.openMultiView(
      sessionStore.sessions,
      (sessionId) => sessionStore.getTerminalsForSession(sessionId)?.activeTabId || '1',
    )) return;
    setShowTilingOverlay(false);
    sessionStore.setActiveSession(null);
    enterTerminalView();
  };

  const handleCloseMultiView = () => {
    terminalWorkspaceStore.closeMultiView();
    setShowTilingOverlay(false);
    clearViewTransitionTimer();
    sessionStore.setActiveSession(null);
    setViewState('dashboard');
  };

  // OPEN releases the display and focus gate without replacing the attachment.
  const handleOpenSessionById = (sessionId: string) => {
    sessionStore.dismissInitProgressForSession(sessionId);
  };

  const _handleReconnect = (sessionId: string, terminalId: string = '1') => {
    terminalStore.reconnect(sessionId, terminalId, setTerminalError);
  };

  const setDashboardWorkspaceFromLocation = () => {
    keepDashboardOwnership();
  };

  const reconcileLocation = (fromHistory: boolean) => {
    const path = window.location.pathname;
    if (path === '/app/usage' || path === '/app/usage/') return;
    const hasExactUrl = !window.location.search && !window.location.hash;
    if (hasExactUrl && window.location.pathname === dashboardPath()) {
      if (fromHistory) setDashboardWorkspaceFromLocation();
      return;
    }

    const requestedSessionId = hasExactUrl
      ? parseSessionPath(window.location.pathname)
      : undefined;
    const requestedSession = requestedSessionId
      ? sessionStore.sessions.find((session) => session.id === requestedSessionId)
      : undefined;

    if (requestedSessionId && requestedSession) {
      if (requestedSession.workspace === 'vscode') {
        keepDashboardOwnership();
        writeHistoryPath(dashboardPath(), 'replace');
      } else if (requestedSession.status === 'initializing'
        || (requestedSession.status !== 'error' && isMountedLifecycle(requestedSession.status as 'stopped' | 'starting' | 'running' | 'unreachable' | 'stopping'))) {
        openSessionWorkspace(requestedSessionId, { updateHistory: false });
      } else {
        // A canonical link may identify a session that stopped after the
        // notification was sent. Keep the trusted selection without waking it.
        clearViewTransitionTimer();
        sessionStore.setActiveSession(requestedSessionId);
        terminalWorkspaceStore.setSingleSessionWorkspace(
          requestedSessionId,
          terminalIdForSession(requestedSession),
          requestedSession,
        );
        setViewState('dashboard');
      }
      return;
    }

    setDashboardWorkspaceFromLocation();
    writeHistoryPath(dashboardPath(), 'replace');
  };

  const handleOpenDashboard = () => {
    batch(() => {
      rememberOpenChat();
      rememberOpenTerminal();
      setViewState('collapsing');
      terminalWorkspaceStore.setDashboardWorkspace();
      setShowTilingOverlay(false);
      clearViewTransitionTimer();
      sessionStore.setActiveSession(null);
    });
    writeHistoryPath(dashboardPath(), 'push');
    viewTransitionTimer = setTimeout(() => {
      viewTransitionTimer = undefined;
      setViewState('dashboard');
    }, VIEW_TRANSITION_DURATION_MS);
  };

  const handleDashboardSessionSelect = (sessionId: string, surface?: PiSurface) => {
    const session = sessionStore.sessions.find(s => s.id === sessionId);
    if (session && (session.status === 'initializing'
      || (session.status !== 'error' && isMountedLifecycle(session.status as 'stopped' | 'starting' | 'running' | 'unreachable' | 'stopping')))) {
      openSessionWorkspace(sessionId, { surface });
    } else if (session?.status === 'stopped') {
      // Always do a full start — even if the container could auto-wake via SDK,
      // the filesystem is empty after sleep (no R2 sync). startSession() runs
      // entrypoint.sh, restoring files before the selected workspace becomes ready.
      openSessionWorkspace(sessionId, { shouldStart: true, surface });
    }
  };

  const handleSettingsClick = () => {
    setIsStoragePanelOpen(false);
    setIsSettingsOpen(true);
  };

  const handleSettingsClose = () => {
    setIsSettingsOpen(false);
    setCloudflareReturn(undefined);
  };

  const handleStoragePanelToggle = () => {
    handleSettingsClose();
    setIsStoragePanelOpen(!isStoragePanelOpen());
  };

  const handleStoragePanelClose = () => {
    setIsStoragePanelOpen(false);
  };

  // Tiling handlers
  const handleTilingButtonClick = () => {
    setShowTilingOverlay(!showTilingOverlay());
  };

  const handleSelectTilingLayout = (layout: TileLayout) => {
    const sessionId = sessionStore.activeSessionId;
    if (sessionId) {
      sessionStore.setTilingLayout(sessionId, layout);
    }
    setShowTilingOverlay(false);
  };

  const handleCloseTilingOverlay = () => {
    setShowTilingOverlay(false);
  };

  const handleTileClick = (tabId: string) => {
    const sessionId = sessionStore.activeSessionId;
    if (sessionId) {
      sessionStore.setActiveTerminalTab(sessionId, tabId);
    }
  };

  const handleDismissError = () => {
    sessionStore.clearError();
    setTerminalError(null);
  };

  return (
    <div class="layout">
      {/* SplashCursor - layout-level so it covers header + content */}
      <SplashCursor />

      {/* Auth expiry banner — shown when background polling detects expired session */}
      <Show when={sessionStore.authExpired}>
        <div class="layout-auth-banner" data-testid="auth-expired-banner">
          <span>Session expired. Please re-authenticate to continue.</span>
          <button type="button" onClick={() => window.location.reload()}>
            Refresh
          </button>
        </div>
      </Show>

      {/* Usage quota banners — dismissal persists per UTC month via localStorage. Implements REQ-SUB-018.
          REQ-ENTERPRISE-008 AC4: monthly compute quotas + the "Upgrade" CTA are a SaaS-billing concept,
          so the banners render only in SaaS mode — hidden in enterprise, onboarding, and default alike. */}
      <Show when={sessionStore.saasMode && usageWarning() === '80' && getDismissedQuotaLevel() == null}>
        <div class="layout-auth-banner layout-usage-warning" data-testid="usage-warning-80">
          <span>You've used 80% of your monthly compute quota. <a href="/app/subscribe">Upgrade plan</a></span>
          <button type="button" class="layout-banner-dismiss" aria-label="Dismiss" onClick={() => setDismissedQuotaLevel('80')}>&times;</button>
        </div>
      </Show>
      <Show when={sessionStore.saasMode && usageWarning() === '95' && getDismissedQuotaLevel() !== '95'}>
        <div class="layout-auth-banner layout-usage-critical" data-testid="usage-warning-95">
          <span>You've used 95% of your monthly compute quota. <a href="/app/subscribe">Upgrade now</a></span>
          <button type="button" class="layout-banner-dismiss" aria-label="Dismiss" onClick={() => setDismissedQuotaLevel('95')}>&times;</button>
        </div>
      </Show>
      <Show when={sessionStore.saasMode && usageWarning() === '100'}>
        <div class="layout-auth-banner layout-usage-exceeded" data-testid="usage-warning-100">
          <span>Monthly compute quota exceeded. Sessions cannot start until quota resets. <a href="/app/subscribe">Upgrade plan</a></span>
        </div>
      </Show>

      <div class="layout-workspace" classList={{ 'layout-workspace--chat': showOpenChatPanel() }}
        role={showOpenChatPanel() ? 'group' : undefined} aria-label={showOpenChatPanel() ? 'Vibe Chat' : undefined}>
        {/* Header - only shown when not on dashboard */}
        <Show when={!showDashboard()}>
          <Header
            userName={props.userName}
            onSettingsClick={handleSettingsClick}
            onStoragePanelToggle={handleStoragePanelToggle}
            onVaultOpen={sessionStore.activeSessionId && sessionStore.preferences.sessionMode === 'advanced'
              ? handleVaultOpen
              : undefined}
            onVscodeOpen={sessionStore.activeSessionId
              && sessionStore.preferences.sessionMode === 'advanced'
              && sessionStore.getActiveSession()?.status === 'running'
              ? handleVscodeOpen
              : undefined}
            workspaceMode={sessionWorkspaceMode()}
            vaultReady={vaultReady()}
            vaultStatus={vaultButtonStatus()}
            onLogoClick={showDashboard() ? undefined : handleOpenDashboard}
            sessions={sessionStore.sessions}
            activeSessionId={sessionStore.activeSessionId}
            onSelectSession={handleSelectSession}
            onStopSession={handleStopSession}
            onDeleteSession={handleDeleteSession}
            onCreateSession={handleCreateSession}
            onOpenMultiView={handleOpenMultiView}
            onCloseMultiView={handleCloseMultiView}
          />
        </Show>

        {/* Middle section - main content */}
        <div class="layout-middle" classList={{ 'layout-middle--chat-expanding': !!activeChatPanelSize()?.expanding }}
          style={{ '--chat-compact-height': activeChatPanelSize()?.compactHeight === undefined
            ? undefined : `${activeChatPanelSize()?.compactHeight}px` }}>
          {/* Main content */}
          <TerminalArea
            workspaceMode={dashboardWorkspaceMode()}
            launchingVibe={launchingVibe()}
            migrationRetry={migrationRetry}
            repositoryRestoreNotices={
              <section class="repository-restore-notices" aria-label="Activity notifications">
                <MigrationRetryNotice retry={migrationRetry} />
                <For each={Object.keys(sessionStore.repositoryRestoreNotices ?? {})}>{id => {
                  const notice = () => sessionStore.repositoryRestoreNotices[id];
                  const status = () => notice()?.status;
                  const name = () => sessionStore.sessions.find(session => session.id === id)?.name;
                  return (
                    <Show when={status() && name()}>
                      <div class="repository-restore-notice">
                        <div role="status" aria-atomic="true">
                          <strong>{notice()?.repo
                            ? status() === 'restoring' ? 'Cloning repository…'
                              : notice()?.outcome === 'exists' ? 'Repository folder already exists'
                              : notice()?.outcome === 'tracking-unconfirmed' ? 'Repository cloned; automatic restore not confirmed'
                              : status() === 'complete' ? 'Repository cloned' : 'Repository clone failed'
                            : status() === 'restoring' ? 'Restoring repositories…'
                              : status() === 'complete' ? 'Repositories restored' : 'Some repositories weren’t restored'}</strong>
                          <Show when={!notice()?.repo && notice()?.repos?.length} fallback={<div class="repository-restore-notice__session">{name()}</div>}>
                            <ul class="repository-restore-notice__repos repository-restore-notice__session" role="list" aria-label="Repositories" tabIndex={0}>
                              <For each={notice()?.repos}>{repo => <li>{repo}</li>}</For>
                            </ul>
                          </Show>
                          <Show when={notice()?.repo}>{repo => <div class="repository-restore-notice__session">{repo()}</div>}</Show>
                        </div>
                        <button type="button" aria-label={notice()?.repo ? 'Dismiss repository clone notification' : 'Dismiss repository restore notification'}
                          onClick={() => sessionStore.dismissRepositoryRestore(id)}>
                          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="m6 6 12 12M18 6 6 18" />
                          </svg>
                        </button>
                      </div>
                    </Show>
                  );
                }}</For>
              </section>
            }
            showTerminal={showTerminal()}
            showPiWebPanel={showPiWebPanel()}
            preparePiWebPanel={preparePiWebPanel()}
            prepareNativeTerminal={prepareNativeTerminal()}
            codeAttachment={prepareNativeTerminal() ? prepareCodeAttachment() : undefined}
            preserveDomFocus={preserveModeFocusOnAttach}
            handoffPending={!!handoffTarget()}
            piWebTerminalConnect={handoffTarget() ? piWebStatus()?.surface === 'terminal' : undefined}
            piWebOpenReady={chatStartupReady() && piWebStatus()?.surface === 'chat' && !piWebStatus()?.startupQuestion}
            piWebShowDuringStartup={chatStartupFailed() || !!piWebStatus()?.startupQuestion
              || piWebStatus()?.phase === 'failed' || piWebStatus()?.phase === 'uncertain'}
            retainPiWebPanel={retainedChats().length > 0}
            parkedTerminalPane={!showTerminal() ? parkedTerminalPane() : undefined}
            piWebTerminalStatus={
              <PiWebSwitchControls progressInMenu={modeAvailable()} phase={piWebStatus()?.phase} target={piWebSwitchingTarget() ?? piWebStatus()?.target}
                switching={!!piWebSwitchingTarget()} problem={piWebProblem()} canCancel={canCancelPiWeb()}
                onCancel={cancelPiWeb} onRetry={retryPiWeb()} />
            }
            piWebPanel={
              <>
              <Show when={!shownChatStatus().frame && showTerminal() && (showPiWebPanel() || preparePiWebPanel())}>
                <div class="pi-web-chat">
                  <PiWebSwitchControls progressInMenu={modeAvailable()} phase={piWebStatus()?.phase} target={piWebSwitchingTarget() ?? piWebStatus()?.target}
                    switching={!!piWebSwitchingTarget()} problem={piWebProblem()} canCancel={canCancelPiWeb()}
                    onCancel={cancelPiWeb} onRetry={retryPiWeb()} />
                  <Show when={!piWebStatus() && !piWebProblem()}>
                    <div class="pi-web-chat__space"><p role="status">{awaitingChatStart() ? 'Preparing Chat…' : 'Checking Pi surface…'}</p></div>
                  </Show>
                </div>
              </Show>
              <For each={chatFrames()}>{frame => {
                const selected = () => shownChatStatus().frame === frame;
                const parked = untrack(() => retainedChats().find(entry => entry.frame === frame)?.status ?? shownChatStatus().status!);
                return <div class="pi-web-chat" style={{ display: selected() ? undefined : 'none' }}>
                  <PiWebChat sessionId={frame.id} generation={frame.generation} status={selected() ? shownChatStatus().status! : parked}
                    progressInMenu={modeAvailable()} onCancel={cancelPiWeb} onRetry={selected() ? retryPiWeb() : undefined}
                    onPanelSize={size => reportChatPanelSize(frame, size)}
                    onStartupReady={ready => reportChatLoad(frame, 'ready', ready)}
                    onStartupFailure={failed => reportChatLoad(frame, 'failed', failed)}
                    problem={selected() ? piWebProblem() : undefined} canCancel={selected() && canCancelPiWeb()}
                    switchingTarget={selected() ? piWebSwitchingTarget() : undefined} />
                </div>;
              }}</For>
              </>
            }
            showTilingOverlay={showTilingOverlay()}
            onTilingButtonClick={handleTilingButtonClick}
            onSelectTilingLayout={handleSelectTilingLayout}
            onCloseTilingOverlay={handleCloseTilingOverlay}
            onTileClick={handleTileClick}
            onOpenSessionById={handleOpenSessionById}
            onOpenMultiView={handleOpenMultiView}
            onDashboardSessionSelect={handleDashboardSessionSelect}
            onCreateSession={handleCreateSession}
            onStartSession={handleStartSession}
            onOpenVscodeSession={openVscodeSession}
            onStopSession={handleStopSession}
            onDeleteSession={handleDeleteSession}
            onTerminalError={setTerminalError}
            error={sessionStore.error || terminalError()}
            onDismissError={handleDismissError}
            viewState={viewState()}
            userName={props.userName}
            onSettingsClick={handleSettingsClick}
            enterpriseMode={props.enterpriseMode}
          />
        </div>
      </div>

      {/* Settings Panel - slides in from right */}
      <SettingsPanel isOpen={isSettingsOpen()} onClose={handleSettingsClose} currentUserEmail={props.userName} currentUserRole={props.userRole} enterpriseMode={props.enterpriseMode} mcpReturnOutcome={props.mcpReturnOutcome} cloudflareReturn={cloudflareReturn()} />

      {/* Storage Panel - slides in from right */}
      <StoragePanel isOpen={isStoragePanelOpen()} onClose={handleStoragePanelClose} />

    </div>
  );
};

export default Layout;
