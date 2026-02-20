import { Component, createSignal, createMemo, createEffect, onMount, onCleanup, Show } from 'solid-js';
import Header from './Header';
import TerminalArea from './TerminalArea';
import SettingsPanel from './SettingsPanel';
import StoragePanel from './StoragePanel';
import SplashCursor from './SplashCursor';
import '../styles/layout.css';
import { sessionStore } from '../stores/session';
import { terminalStore, reconnectDroppedConnections, scheduleDisconnect, cancelScheduledDisconnect } from '../stores/terminal';
import { logger } from '../lib/logger';
import { loadSettings, applyAccentColor } from '../lib/settings';
import type { TileLayout, AgentType, TabConfig } from '../types';
import { VIEW_TRANSITION_DURATION_MS, WS_RECONNECT_TIMEOUT_MS, DASHBOARD_WS_DISCONNECT_DELAY_MS } from '../lib/constants';

type ViewState = 'dashboard' | 'expanding' | 'terminal' | 'collapsing';

interface LayoutProps {
  userName?: string;
  userRole?: 'admin' | 'user';
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
  const [terminalError, setTerminalError] = createSignal<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = createSignal(false);
  const [isStoragePanelOpen, setIsStoragePanelOpen] = createSignal(false);
  const [showTilingOverlay, setShowTilingOverlay] = createSignal(false);
  const [viewState, setViewState] = createSignal<ViewState>('dashboard');

  // Load sessions and preferences on mount
  onMount(() => {
    sessionStore.loadSessions();
    sessionStore.loadPresets();
    sessionStore.loadPreferences();
    // Apply saved accent color
    const savedSettings = loadSettings();
    applyAccentColor(savedSettings.accentColor);
  });

  // Only poll session list while on dashboard — polling during terminal view
  // replaces the sessions array, triggering reactivity that flips viewState.
  // On dashboard: schedule a full WebSocket disconnect after a grace period
  // so the Cloudflare Container can go idle.
  // On terminal: cancel scheduled disconnect and reconnect any dropped connections.
  createEffect(() => {
    if (viewState() === 'dashboard') {
      scheduleDisconnect(DASHBOARD_WS_DISCONNECT_DELAY_MS);
      sessionStore.startSessionListPolling();
    } else {
      cancelScheduledDisconnect();
      reconnectDroppedConnections();
      sessionStore.stopSessionListPolling();
    }
  });

  onCleanup(() => {
    sessionStore.stopSessionListPolling();
  });

  // viewState-derived computations
  const showTerminal = createMemo(() => viewState() === 'terminal' || viewState() === 'expanding');
  const showDashboard = createMemo(() => viewState() === 'dashboard' || viewState() === 'collapsing');

  // Sync viewState with session store
  createEffect(() => {
    const session = sessionStore.getActiveSession();
    const hasActiveTerminal = session && (session.status === 'running' || session.status === 'initializing');

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

  const handleReconnect = (sessionId: string, terminalId: string = '1') => {
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
      sessionStore.setActiveSession(sessionId);
      if (sessionStore.hasRecentContext(session)) {
        // Context may still exist — try WebSocket first (SDK auto-starts container).
        // If WebSocket fails within 5s, fall back to full startSession().
        tryWebSocketFirst(sessionId);
      } else {
        // Context expired — full restart
        void sessionStore.startSession(sessionId).catch(() => {});
      }
    }

    // Start expansion animation
    setViewState('expanding');
    setTimeout(() => {
      setViewState('terminal');
      terminalStore.triggerLayoutResize();
    }, VIEW_TRANSITION_DURATION_MS);
  };

  /**
   * Attempt WebSocket connection first for stopped sessions with recent context.
   * The SDK may auto-start the container, preserving agent context.
   * If connection fails within WS_RECONNECT_TIMEOUT_MS, fall back to startSession().
   */
  const tryWebSocketFirst = (sessionId: string) => {
    // Set status to running optimistically so the terminal view renders
    sessionStore.updateSessionStatus(sessionId, 'running');
    sessionStore.initializeTerminalsForSession(sessionId);

    const timeout = setTimeout(() => {
      // Check if WebSocket connected within the timeout
      const wsState = terminalStore.getConnectionState(sessionId, '1');
      if (wsState !== 'connected') {
        logger.info(`[Layout] WebSocket reconnect timed out for ${sessionId}, falling back to startSession()`);
        // Dispose the failed WebSocket attempt
        terminalStore.disposeSession(sessionId);
        sessionStore.cleanupTerminalsForSession(sessionId);
        // Fall back to full start
        void sessionStore.startSession(sessionId).catch(() => {});
      }
    }, WS_RECONNECT_TIMEOUT_MS);

    // If WebSocket connects successfully before timeout, clear the fallback
    const checkInterval = setInterval(() => {
      const wsState = terminalStore.getConnectionState(sessionId, '1');
      if (wsState === 'connected') {
        clearTimeout(timeout);
        clearInterval(checkInterval);
      }
    }, 500);

    // Clean up interval when timeout fires
    setTimeout(() => clearInterval(checkInterval), WS_RECONNECT_TIMEOUT_MS + 100);
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

      {/* Header - only shown when not on dashboard */}
      <Show when={!showDashboard()}>
        <Header
          userName={props.userName}
          onSettingsClick={handleSettingsClick}
          onStoragePanelToggle={handleStoragePanelToggle}
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
          onLogout={() => { window.location.href = '/cdn-cgi/access/logout'; }}
        />
      </div>

      {/* Settings Panel - slides in from right */}
      <SettingsPanel isOpen={isSettingsOpen()} onClose={handleSettingsClose} currentUserEmail={props.userName} currentUserRole={props.userRole} />

      {/* Storage Panel - slides in from right */}
      <StoragePanel isOpen={isStoragePanelOpen()} onClose={handleStoragePanelClose} />

    </div>
  );
};

export default Layout;
