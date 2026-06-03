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
import { forceResetKeyboardState, enableVirtualKeyboardOverlay, isSamsungBrowser, cleanupDebugOverlay } from '../lib/mobile';
import { logger } from '../lib/logger';
import { loadSettings, applyAccentColor } from '../lib/settings';
import type { TileLayout, AgentType, TabConfig } from '../types';
import { VIEW_TRANSITION_DURATION_MS, DASHBOARD_WS_DISCONNECT_DELAY_MS } from '../lib/constants';
import { startVaultReadinessProbe } from '../lib/vault-readiness';

type ViewState = 'dashboard' | 'expanding' | 'terminal' | 'collapsing';

interface LayoutProps {
  userName?: string;
  userRole?: 'admin' | 'user';
  userAccessTier?: import('../types').AccessTier;
  userSubscriptionTier?: import('../types').SubscriptionTier;
  onboardingActive?: boolean;
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
  const [vaultReadyBySession, setVaultReadyBySession] = createSignal<Record<string, boolean>>({});
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
      setLatch: () => setVaultReadyBySession((prev) => ({ ...prev, [sid]: true })),
      clearLatch: () => setVaultReadyBySession((prev) => {
        const next = { ...prev };
        delete next[sid];
        return next;
      }),
      initiallyReady: () => untrack(vaultReadyBySession)[sid] === true,
      warmupIntervalMs: WARMUP_INTERVAL_MS,
      steadyIntervalMs: STEADY_INTERVAL_MS,
    });
    onCleanup(cancel);
  });
  const vaultReady = createMemo(() => {
    const sid = sessionStore.activeSessionId;
    return sid ? vaultReadyBySession()[sid] === true : false;
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
      reconnectDisconnectedTerminals(untrack(() => sessionStore.activeSessionId) ?? undefined);
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
              reconnectOnVisibilityReturn(sessionId);
            }, 50);
            return;
          }
        }

        setTimeout(() => {
          if (viewState() !== 'dashboard') enableVirtualKeyboardOverlay();
        }, 300);
        reconnectOnVisibilityReturn(untrack(() => sessionStore.activeSessionId) ?? undefined);
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

    if (hasActiveTerminal && viewState() === 'dashboard') {
      setViewState('terminal');
      setTimeout(() => terminalStore.triggerLayoutResize(), 50);
    } else if (!hasActiveTerminal && viewState() === 'terminal') {
      setViewState('dashboard');
    }
  });

  // Handlers
  const handleSelectSession = (id: string) => {
    const session = sessionStore.sessions.find((s) => s.id === id);
    if (session?.status === 'running') {
      sessionStore.setActiveSession(id);
    } else if (session?.status === 'stopped') {
      sessionStore.setActiveSession(id);
      void sessionStore.startSession(id).catch(() => {});
    }
  };

  const handleStartSession = async (id: string) => {
    sessionStore.setActiveSession(id);
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
      // Update preferences with last-used agent type
      if (agentType) {
        sessionStore.updatePreferences({ lastAgentType: agentType });
      }
      await sessionStore.startSession(session.id);
    }
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
    setViewState('collapsing');
    setTimeout(() => {
      sessionStore.setActiveSession(null);
      setViewState('dashboard');
    }, VIEW_TRANSITION_DURATION_MS);
  };

  const handleDashboardSessionSelect = (sessionId: string) => {
    const session = sessionStore.sessions.find(s => s.id === sessionId);
    if (session?.status === 'running') {
      sessionStore.setActiveSession(sessionId);
    } else if (session?.status === 'stopped') {
      // Always do a full start — even if the container could auto-wake via SDK,
      // the filesystem is empty after sleep (no R2 sync). startSession() runs
      // entrypoint.sh which restores files from R2 before starting the terminal.
      sessionStore.setActiveSession(sessionId);
      void sessionStore.startSession(sessionId).catch(() => {});
    }

    // Start expansion animation
    setViewState('expanding');
    setTimeout(() => {
      setViewState('terminal');
      terminalStore.triggerLayoutResize();
    }, VIEW_TRANSITION_DURATION_MS);
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

      {/* Usage quota banners — dismissal persists per UTC month via localStorage. Implements REQ-SUB-018. */}
      <Show when={usageWarning() === '80' && getDismissedQuotaLevel() == null}>
        <div class="layout-auth-banner layout-usage-warning" data-testid="usage-warning-80">
          <span>You've used 80% of your monthly compute quota. <a href="/app/subscribe">Upgrade plan</a></span>
          <button type="button" class="layout-banner-dismiss" aria-label="Dismiss" onClick={() => setDismissedQuotaLevel('80')}>&times;</button>
        </div>
      </Show>
      <Show when={usageWarning() === '95' && getDismissedQuotaLevel() !== '95'}>
        <div class="layout-auth-banner layout-usage-critical" data-testid="usage-warning-95">
          <span>You've used 95% of your monthly compute quota. <a href="/app/subscribe">Upgrade now</a></span>
          <button type="button" class="layout-banner-dismiss" aria-label="Dismiss" onClick={() => setDismissedQuotaLevel('95')}>&times;</button>
        </div>
      </Show>
      <Show when={usageWarning() === '100'}>
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
            ? () => window.open(`/api/vault/${sessionStore.activeSessionId}/`, '_blank', 'noopener')
            : undefined}
          vaultReady={vaultReady()}
          onLogoClick={showDashboard() ? undefined : handleOpenDashboard}
          sessions={sessionStore.sessions}
          activeSessionId={sessionStore.activeSessionId}
          onSelectSession={handleSelectSession}
          onStopSession={handleStopSession}
          onDeleteSession={handleDeleteSession}
          onCreateSession={handleCreateSession}
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
        />
      </div>

      {/* Settings Panel - slides in from right */}
      <SettingsPanel isOpen={isSettingsOpen()} onClose={handleSettingsClose} currentUserEmail={props.userName} currentUserRole={props.userRole} currentUserAccessTier={props.userAccessTier} />

      {/* Storage Panel - slides in from right */}
      <StoragePanel isOpen={isStoragePanelOpen()} onClose={handleStoragePanelClose} />

    </div>
  );
};

export default Layout;
