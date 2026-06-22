import { Component, createSignal, createMemo, createEffect, onMount, onCleanup, Show, untrack } from 'solid-js';
import Header from './Header';
import TerminalArea from './TerminalArea';
import SettingsPanel from './SettingsPanel';
import StoragePanel from './StoragePanel';
import SplashCursor from './SplashCursor';
import '../styles/layout.css';
import { sessionStore, getUsageWarningLevel, getDismissedQuotaLevel, setDismissedQuotaLevel } from '../stores/session';
import { storageStore } from '../stores/storage';
import { terminalStore, reconnectDisconnectedTerminals, reconnectOnVisibilityReturn, scheduleDisconnect, cancelScheduledDisconnect } from '../stores/terminal';
import { terminalWorkspaceStore } from '../stores/terminal-workspace';
import { forceResetKeyboardState, enableVirtualKeyboardOverlay, isSamsungBrowser, cleanupDebugOverlay } from '../lib/mobile';
import { logger } from '../lib/logger';
import { loadSettings, applyAccentColor } from '../lib/settings';
import type { TileLayout, AgentType, TabConfig } from '../types';
import { VIEW_TRANSITION_DURATION_MS, DASHBOARD_WS_DISCONNECT_DELAY_MS } from '../lib/constants';
import { startVaultReadinessProbe } from '../lib/vault-readiness';
import { DEFAULT_VAULT_PREWARM_TIMEOUT_MS, startVaultPrewarm, type VaultPrewarmStatus } from '../lib/vault-prewarm';
import { checkVaultLocalReadiness, checkVaultKeyRecoverable, markVaultFullyPrewarmed, hasVaultFullyPrewarmed } from '../lib/vault-local-readiness';
import type { VaultButtonStatus } from './VaultButton';
import { requestBrowserStoragePersistence } from '../lib/browser-storage-persistence';

type ViewState = 'dashboard' | 'expanding' | 'terminal' | 'collapsing';

export function clearPrewarmingVaultStatus(
  statuses: Record<string, VaultPrewarmStatus>,
  sessionId: string,
): Record<string, VaultPrewarmStatus> {
  if (statuses[sessionId] !== 'prewarming') return statuses;
  const next = { ...statuses };
  delete next[sessionId];
  return next;
}

interface LayoutProps {
  userName?: string;
  userRole?: 'admin' | 'user';
  userAccessTier?: import('../types').AccessTier;
  userSubscriptionTier?: import('../types').SubscriptionTier;
  onboardingActive?: boolean;
  enterpriseMode?: boolean;
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
  const usageWarning = () => getUsageWarningLevel();
  const [terminalError, setTerminalError] = createSignal<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = createSignal(false);
  const [isStoragePanelOpen, setIsStoragePanelOpen] = createSignal(false);
  const [showTilingOverlay, setShowTilingOverlay] = createSignal(false);
  const [viewState, setViewState] = createSignal<ViewState>('dashboard');
  let viewTransitionTimer: ReturnType<typeof setTimeout> | undefined;

  const clearViewTransitionTimer = () => {
    if (viewTransitionTimer) {
      clearTimeout(viewTransitionTimer);
      viewTransitionTimer = undefined;
    }
  };
  onCleanup(clearViewTransitionTimer);

  // Vault readiness: ground-truth probe against the proxy. We can't trust
  // session status flags here. The SilverBullet supervisor starts late in
  // entrypoint.sh (well after ptyActive flips), so a session-level "ready"
  // signal would lie. Probing `HEAD /api/vault/:sid/` returns 200 only when
  // SB has bound 3030 and is serving the SPA shell (cheap, ~1.5KB Content-
  // Length, no body transferred with HEAD); any other response (502, 503,
  // network error) means "not yet". The `.fs/*` API path returns 405 on
  // HEAD so we probe root instead. Keyed per session so a switch resets it.
  //
  // Lifecycle: warm-up probes every WARMUP_INTERVAL_MS forever until the
  // first success (REQ-VAULT-012 AC5). After first success we switch to a
  // steady re-probe to catch SB crashing mid-session (container still
  // "running", proxy returns 502); a failed re-probe clears the latch so
  // the button disables itself and the warmup chain restarts.
  const WARMUP_INTERVAL_MS = 5000;
  const STEADY_INTERVAL_MS = 60000; // post-ready slow re-probe cadence
  const VAULT_PREWARM_RETRY_INTERVAL_MS = 10000;
  const VAULT_KEY_POLL_INTERVAL_MS = 2000; // cadence for re-checking key recoverability while preparing
  const VAULT_LOCAL_READINESS_PROBE_TIMEOUT_MS = 2000; // bound the reload skip-eligibility probe before falling back to the iframe
  const [vaultReadyBySession, setVaultReadyBySession] = createSignal<Record<string, boolean>>({});
  const [vaultPrewarmBySession, setVaultPrewarmBySession] = createSignal<Record<string, VaultPrewarmStatus>>({});
  const [vaultPrewarmRetryBySession, setVaultPrewarmRetryBySession] = createSignal<Record<string, number>>({});
  // Click-guard open intent (REQ-VAULT-018): 'preparing' = key not yet
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
  createEffect(() => {
    const sid = activeRunningSid();
    if (!sid) {
      // No active running session: drop any latch for the previously active
      // sid so a restart under the same id re-probes from scratch.
      const prevSid = untrack(() => sessionStore.activeSessionId);
      if (prevSid && untrack(vaultReadyBySession)[prevSid]) {
        setVaultReadyBySession((prev) => {
          const next = { ...prev };
          delete next[prevSid];
          return next;
        });
      }
      if (prevSid) clearVaultOpenIntent(prevSid);
      return;
    }

    // `untrack` so the latch reads do not subscribe the effect to its own
    // writes (steady() clears the latch on crash; tracking would spawn a
    // parallel warmup chain via effect re-run).
    const cancel = startVaultReadinessProbe({
      probe: async () => {
        try {
          const res = await fetch(`/api/vault/${sid}/`, {
            method: 'HEAD',
            cache: 'no-store',
            signal: AbortSignal.timeout(5000),
          });
          return res.ok;
        } catch {
          return false;
        }
      },
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
  createEffect(() => {
    const sid = activeRunningSid();
    if (!sid) {
      const prevSid = untrack(() => sessionStore.activeSessionId);
      if (prevSid && untrack(vaultPrewarmBySession)[prevSid]) {
        setVaultPrewarmBySession((prev) => {
          const next = { ...prev };
          delete next[prevSid];
          return next;
        });
        setVaultPrewarmRetryBySession((prev) => {
          if (prev[prevSid] === undefined) return prev;
          const next = { ...prev };
          delete next[prevSid];
          return next;
        });
      }
      return;
    }

    if (vaultReadyBySession()[sid] !== true) return;
    const retryNonce = vaultPrewarmRetryBySession()[sid] ?? 0;
    void retryNonce;
    const current = untrack(vaultPrewarmBySession)[sid];
    if (current === 'ready' || current === 'prewarming') return;

    setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'prewarming' }));
    if (untrack(vaultPersistenceRequestedBySession)[sid] !== true) {
      setVaultPersistenceRequestedBySession((prev) => ({ ...prev, [sid]: true }));
      void requestBrowserStoragePersistence().then((result) => {
        if (result.supported && result.granted === false) {
          logger.warn('browser denied persistent storage for Vault cache', { sid });
        }
      }).catch((err) => logger.warn('browser storage persistence check failed', {
        sid,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    let handle: ReturnType<typeof startVaultPrewarm> = null;
    let cancelled = false;
    const mountPrewarm = () => {
      handle = startVaultPrewarm({
        sessionId: sid,
        timeoutMs: DEFAULT_VAULT_PREWARM_TIMEOUT_MS,
        onReady: (proof) => {
          if (!proof.ready) {
            setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'error' }));
            return;
          }
          // Record that THIS browser completed the full prewarm proof (runtime +
          // space sync + index + file listing), so a later reload may safely skip
          // remounting the bootstrap iframe.
          markVaultFullyPrewarmed(sid);
          setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'ready' }));
        },
        onError: (status) => setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: status })),
      });
    };
    // Skip the bootstrap iframe only when this browser BOTH already completed a
    // full prewarm proof for this session AND still has the recorded stores +
    // active service worker (not evicted). The recorded-stores/SW check alone is
    // too weak — an interrupted first-init can leave them present before space
    // sync/index finished, and opening then lands on a slow indexing screen. The
    // liveness probe is raced against a short timeout so a hung local query falls
    // back to the iframe (which carries its own timeout + retry). Skipping avoids
    // re-running SW registration / space sync / indexing and the focus contention
    // with the terminal on every reload; the click path (handleVaultOpen) still
    // re-verifies local readiness + key recoverability before opening.
    const eligibleToSkip = async (): Promise<boolean> => {
      if (!hasVaultFullyPrewarmed(sid)) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          checkVaultLocalReadiness(sid).then((proof) => proof.ready === true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), VAULT_LOCAL_READINESS_PROBE_TIMEOUT_MS);
          }),
        ]);
      } catch {
        return false;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    void eligibleToSkip().then((skip) => {
      if (cancelled) return;
      if (skip) {
        setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'ready' }));
        return;
      }
      mountPrewarm();
    });
    onCleanup(() => {
      cancelled = true;
      handle?.cancel();
      setVaultPrewarmBySession((prev) => clearPrewarmingVaultStatus(prev, sid));
    });
  });

  createEffect(() => {
    const sid = activeRunningSid();
    if (!sid || vaultReadyBySession()[sid] !== true) return;
    const status = vaultPrewarmBySession()[sid];
    if (status !== 'timeout' && status !== 'error') return;

    const retryTimer = setTimeout(() => {
      setVaultPrewarmRetryBySession((prev) => ({ ...prev, [sid]: (prev[sid] ?? 0) + 1 }));
    }, VAULT_PREWARM_RETRY_INTERVAL_MS);
    onCleanup(() => clearTimeout(retryTimer));
  });

  const vaultPrewarmStatus = createMemo<VaultPrewarmStatus>(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid || vaultReadyBySession()[sid] !== true) return 'idle';
    return vaultPrewarmBySession()[sid] ?? 'prewarming';
  });

  const vaultReady = createMemo(() => {
    const sid = sessionStore.activeSessionId;
    return !!sid && vaultReadyBySession()[sid] === true && vaultPrewarmStatus() === 'ready';
  });

  // Open-intent overrides the prewarm status on the button: once a click finds
  // the key not recoverable, the button breathes accent ('preparing') then green
  // ('armed') instead of showing the underlying prewarm status.
  const vaultButtonStatus = createMemo<VaultButtonStatus>(() => {
    const sid = sessionStore.activeSessionId;
    const intent = sid ? vaultOpenIntentBySession()[sid] : undefined;
    if (intent) return intent;
    return vaultReady() ? 'ready' : vaultPrewarmStatus();
  });

  const restartVaultPrewarm = (sid: string) => {
    setVaultPrewarmBySession((prev) => ({ ...prev, [sid]: 'error' }));
    setVaultPrewarmRetryBySession((prev) => ({ ...prev, [sid]: (prev[sid] ?? 0) + 1 }));
  };

  const clearVaultOpenIntent = (sid: string) =>
    setVaultOpenIntentBySession((prev) => {
      if (prev[sid] === undefined) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });

  const openVaultTab = (sid: string) => {
    clearVaultOpenIntent(sid);
    window.open(`/api/vault/${sid}/`, '_blank', 'noopener');
  };

  const handleVaultOpen = async () => {
    const sid = sessionStore.activeSessionId;
    if (!sid) return;
    // Armed (green): the key was confirmed recoverable by the poll. Open
    // synchronously so the new tab is created inside this click gesture and is
    // never pop-up-blocked (the deferred-open case that breaks on strict
    // browsers). The new tab's own __cfRecover re-fetches the key.
    if (untrack(vaultOpenIntentBySession)[sid] === 'armed') {
      openVaultTab(sid);
      return;
    }
    const proof = await checkVaultLocalReadiness(sid);
    if (!proof.ready) {
      logger.warn('vault local readiness disappeared before open; preparing', { sid, reason: proof.reason });
      restartVaultPrewarm(sid);
      setVaultOpenIntentBySession((prev) => ({ ...prev, [sid]: 'preparing' }));
      return;
    }
    // The service worker flushes its in-memory encryption key ~5s after the
    // prewarm client disconnects, so local readiness does not prove the key is
    // present at open time. If it is recoverable now, open immediately;
    // otherwise enter 'preparing' (breathe accent) and let the poll arm it.
    if (await checkVaultKeyRecoverable(sid)) {
      openVaultTab(sid);
      return;
    }
    logger.warn('vault encryption key not recoverable before open; preparing', { sid });
    setVaultOpenIntentBySession((prev) => ({ ...prev, [sid]: 'preparing' }));
  };

  // While a session is 'preparing', poll until both local readiness and key
  // recoverability hold, then arm (button breathes green). Re-fetching
  // `/.vault-key` also wakes an idle container so the open path is live.
  createEffect(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid || vaultOpenIntentBySession()[sid] !== 'preparing') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      const proof = await checkVaultLocalReadiness(sid);
      const ready = proof.ready && (await checkVaultKeyRecoverable(sid));
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

  // Load sessions and preferences on mount
  onMount(() => {
    sessionStore.loadSessions();
    sessionStore.loadPresets();
    sessionStore.loadPreferences();
    // Apply saved accent color
    const savedSettings = loadSettings();
    applyAccentColor(savedSettings.accentColor);
  });

  // Poll session statuses (metrics, status changes) regardless of view state
  // so dashboard cards always show fresh CPU/mem/HDD when the user returns.
  // refreshSessionStatuses() updates in-place and won't trigger viewState flips.
  onMount(() => {
    sessionStore.startSessionListPolling();
    storageStore.fetchStats();
  });

  const tiledSlotCount = (layout: TileLayout) => {
    if (layout === '4-grid') return 4;
    if (layout === '3-split') return 3;
    return layout === '2-split' ? 2 : 1;
  };

  const visibleTerminalKeys = createMemo(() => {
    const activeWorkspace = terminalWorkspaceStore.getActiveWorkspace();
    const sessionId = activeWorkspace && activeWorkspace.kind === 'session' ? activeWorkspace.sessionId : null;
    const terminals = sessionId ? sessionStore.getTerminalsForSession(sessionId) : null;
    const tiling = sessionId ? sessionStore.getTilingForSession(sessionId) : null;
    if (sessionId && terminals && tiling && tiling.enabled) {
      const activeSessionId = sessionId;
      const layout = tiling.layout;
      const tabOrder = sessionStore.getTabOrder(activeSessionId) ?? [];
      const terminalIds = new Set(terminals.tabs.map((tab) => tab.id));
      return tabOrder
        .filter((tabId) => terminalIds.has(tabId))
        .slice(0, tiledSlotCount(layout))
        .map((tabId) => `${activeSessionId}:${tabId}`);
    }
    return terminalWorkspaceStore.getVisiblePanes().map((pane) => `${pane.sessionId}:${pane.terminalId}`);
  });

  // Auto-refresh sessions + storage when tab returns from background
  const handleVisibilityChange = () => {
    if (!document.hidden) {
      sessionStore.refreshSessionStatuses?.();
      storageStore.refresh?.({ silent: true });
    }
  };
  onMount(() => document.addEventListener('visibilitychange', handleVisibilityChange));

  onCleanup(() => {
    sessionStore.stopSessionListPolling();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    cleanupDebugOverlay();
  });

  // On dashboard: schedule a full WebSocket disconnect after a grace period
  // so the Cloudflare Container can go idle.
  // On terminal: cancel scheduled disconnect and reconnect any dropped connections.
  createEffect(() => {
    if (viewState() === 'dashboard') {
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
      if (document.visibilityState === 'visible' && viewState() !== 'dashboard') {
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
          if (viewState() !== 'dashboard') enableVirtualKeyboardOverlay();
        }, 300);
        reconnectOnVisibilityReturn(undefined, visibleTerminalKeys());
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    onCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));
  }

  // viewState-derived computations
  const showTerminal = createMemo(() => viewState() === 'terminal' || viewState() === 'expanding');
  const showDashboard = createMemo(() => viewState() === 'dashboard' || viewState() === 'collapsing');

  // Sync viewState with session store
  createEffect(() => {
    const session = sessionStore.getActiveSession();
    const hasActiveTerminal = session && (session.status === 'running' || session.status === 'initializing' || sessionStore.isSessionInitializing(session.id));
    const hasActiveMultiView = terminalWorkspaceStore.getActiveWorkspace().kind === 'multiview';

    if ((hasActiveTerminal || hasActiveMultiView) && viewState() === 'dashboard') {
      setViewState('terminal');
      setTimeout(() => terminalStore.triggerLayoutResize(), 50);
    } else if (!hasActiveTerminal && !hasActiveMultiView && viewState() === 'terminal') {
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

  const openSessionWorkspace = (id: string, shouldStart = false) => {
    const terminalId = shouldStart ? '1' : sessionStore.getTerminalsForSession(id)?.activeTabId || '1';
    sessionStore.setActiveSession(id);
    terminalWorkspaceStore.setSingleSessionWorkspace(id, terminalId);
    enterTerminalView();
    if (shouldStart) void sessionStore.startSession(id).catch(() => {});
  };

  const handleSelectSession = (id: string) => {
    const session = sessionStore.sessions.find((s) => s.id === id);
    if (session?.status === 'running' || session?.status === 'initializing') {
      openSessionWorkspace(id);
    } else if (session?.status === 'stopped') {
      openSessionWorkspace(id, true);
    }
  };

  const handleStartSession = async (id: string) => {
    sessionStore.setActiveSession(id);
    terminalWorkspaceStore.setSingleSessionWorkspace(id, sessionStore.getTerminalsForSession(id)?.activeTabId || '1');
    enterTerminalView();
    try {
      await sessionStore.startSession(id);
    } catch (err) {
      logger.error('Failed to start session:', err);
    }
  };

  const handleStopSession = async (id: string) => {
    await sessionStore.stopSession(id);
  };

  const handleDeleteSession = async (id: string) => {
    await sessionStore.deleteSession(id);
  };

  const handleCreateSession = async (name: string, agentType?: AgentType, tabConfig?: TabConfig[]) => {
    const session = await sessionStore.createSession(name, agentType, tabConfig);
    if (session) {
      sessionStore.setActiveSession(session.id);
      terminalWorkspaceStore.setSingleSessionWorkspace(session.id, '1');
      enterTerminalView();
      // Update preferences with last-used agent type
      if (agentType) {
        sessionStore.updatePreferences({ lastAgentType: agentType });
      }
      await sessionStore.startSession(session.id);
    }
  };

  const handleOpenMultiView = () => {
    if (!terminalWorkspaceStore.openMultiView()) return;
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

  // Handler for per-session init progress dismiss
  const handleOpenSessionById = (sessionId: string) => {
    sessionStore.dismissInitProgressForSession(sessionId);
  };

  const _handleReconnect = (sessionId: string, terminalId: string = '1') => {
    terminalStore.reconnect(sessionId, terminalId, setTerminalError);
  };

  const handleOpenDashboard = () => {
    // Keyboard cleanup is handled reactively by Terminal.tsx when props.active
    // becomes false (via onCleanup in the keyboard lifecycle effect).
    terminalWorkspaceStore.setDashboardWorkspace();
    setShowTilingOverlay(false);
    clearViewTransitionTimer();
    setViewState('collapsing');
    sessionStore.setActiveSession(null);
    viewTransitionTimer = setTimeout(() => {
      viewTransitionTimer = undefined;
      setViewState('dashboard');
    }, VIEW_TRANSITION_DURATION_MS);
  };

  const handleDashboardSessionSelect = (sessionId: string) => {
    const session = sessionStore.sessions.find(s => s.id === sessionId);
    if (session?.status === 'running' || session?.status === 'initializing') {
      openSessionWorkspace(sessionId);
    } else if (session?.status === 'stopped') {
      // Always do a full start — even if the container could auto-wake via SDK,
      // the filesystem is empty after sleep (no R2 sync). startSession() runs
      // entrypoint.sh which restores files from R2 before starting the terminal.
      openSessionWorkspace(sessionId, true);
    }
  };

  const handleSettingsClick = () => {
    setIsStoragePanelOpen(false);
    setIsSettingsOpen(true);
  };

  const handleSettingsClose = () => {
    setIsSettingsOpen(false);
  };

  const handleStoragePanelToggle = () => {
    setIsSettingsOpen(false);
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
          <span>Session expired — please re-authenticate to continue.</span>
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

      {/* Header - only shown when not on dashboard */}
      <Show when={!showDashboard()}>
        <Header
          userName={props.userName}
          onSettingsClick={handleSettingsClick}
          onStoragePanelToggle={handleStoragePanelToggle}
          onVaultOpen={sessionStore.activeSessionId && sessionStore.preferences.sessionMode === 'advanced'
            ? handleVaultOpen
            : undefined}
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
      <div class="layout-middle">
        {/* Main content */}
        <TerminalArea
          showTerminal={showTerminal() ?? false}
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

      {/* Settings Panel - slides in from right */}
      <SettingsPanel isOpen={isSettingsOpen()} onClose={handleSettingsClose} currentUserEmail={props.userName} currentUserRole={props.userRole} currentUserAccessTier={props.userAccessTier} enterpriseMode={props.enterpriseMode} />

      {/* Storage Panel - slides in from right */}
      <StoragePanel isOpen={isStoragePanelOpen()} onClose={handleStoragePanelClose} />

    </div>
  );
};

export default Layout;
