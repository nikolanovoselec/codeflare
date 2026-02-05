import { Component, Show, For, createMemo, Setter } from 'solid-js';
import Terminal from './Terminal';
import TerminalTabs from './TerminalTabs';
import TilingButton from './TilingButton';
import TilingOverlay from './TilingOverlay';
import TiledTerminalContainer from './TiledTerminalContainer';
import FloatingTerminalButtons from './FloatingTerminalButtons';
import InitProgress from './InitProgress';
import Dashboard from './Dashboard';
import { sessionStore } from '../stores/session';
import type { TileLayout, AgentType, TabConfig } from '../types';
import { generateSessionName } from '../lib/session-utils';

interface TerminalAreaProps {
  showTerminal: boolean;
  showTilingOverlay: boolean;
  onTilingButtonClick: () => void;
  onSelectTilingLayout: (layout: TileLayout) => void;
  onCloseTilingOverlay: () => void;
  onTileClick: (tabId: string) => void;
  onOpenSessionById: (sessionId: string) => void;
  onDashboardSessionSelect?: (sessionId: string) => void;
  onStartSession: (id: string) => void;
  onStopSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onCreateSession: (name: string, agentType?: AgentType, tabConfig?: TabConfig[]) => void;
  onTerminalError: Setter<string | null>;
  error: string | null;
  onDismissError: () => void;
  viewState: 'dashboard' | 'expanding' | 'terminal' | 'collapsing';
  userName?: string;
  onSettingsClick?: () => void;
  onLogout?: () => void;
}

const TerminalArea: Component<TerminalAreaProps> = (props) => {
  // Derive session state from store directly (avoids prop drilling from Layout)
  const activeSession = createMemo(() => sessionStore.getActiveSession() ?? null);
  const activeSessionId = () => sessionStore.activeSessionId;

  const runningSessions = createMemo(() =>
    sessionStore.sessions.filter((s) => s.status === 'running' || s.status === 'initializing')
  );

  const hasInitializingSession = createMemo(() =>
    sessionStore.sessions.some((s) => sessionStore.isSessionInitializing(s.id))
  );

  const isActiveSessionInitializing = createMemo(() => {
    const id = activeSessionId();
    return id ? sessionStore.isSessionInitializing(id) : false;
  });

  const activeTiling = createMemo(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid) return null;
    return sessionStore.getTilingForSession(sid);
  });

  const activeTabOrder = createMemo(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid) return null;
    return sessionStore.getTabOrder(sid);
  });

  const activeTerminals = createMemo(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid) return null;
    return sessionStore.getTerminalsForSession(sid);
  });

  const getTerminalsForSession = (sessionId: string) =>
    sessionStore.getTerminalsForSession(sessionId);

  return (
    <main class="layout-main">
      {/* Error display */}
      <Show when={props.error}>
        <div class="layout-error">
          <span>{props.error}</span>
          <button type="button" onClick={props.onDismissError}>
            Dismiss
          </button>
        </div>
      </Show>

      {/* Terminal tabs - show when active session is running/initializing */}
      <Show when={props.showTerminal && activeSessionId()}>
        <TerminalTabs sessionId={activeSessionId()!} />
      </Show>

      {/* Terminal container - keep all terminals mounted for instant switching.
          Hidden (display:none) when on dashboard to prevent bleed-through and
          floating buttons from appearing during session creation. */}
      <div class="layout-terminal-container" style={{ display: props.showTerminal ? undefined : 'none' }}>
        {/* Tiling button - only show when active session is running with 2+ tabs */}
        <Show when={props.showTerminal && activeSessionId() && activeTerminals()}>
          <div class="layout-tiling-button-wrapper">
            <TilingButton
              sessionId={activeSessionId()!}
              tabCount={activeTerminals()?.tabs.length || 0}
              isActive={activeTiling()?.enabled || false}
              onClick={props.onTilingButtonClick}
            />
            {/* Tiling overlay - positioned relative to button wrapper */}
            <Show when={props.showTilingOverlay}>
              <TilingOverlay
                tabCount={activeTerminals()?.tabs.length || 0}
                currentLayout={activeTiling()?.layout || 'tabbed'}
                onSelectLayout={props.onSelectTilingLayout}
                onClose={props.onCloseTilingOverlay}
              />
            </Show>
          </div>
        </Show>

        {/* Floating ESC/TAB buttons for mobile - only in terminal view */}
        <FloatingTerminalButtons showTerminal={props.showTerminal} />

        {/* Tiled terminal view - when tiling is enabled */}
        <Show when={props.showTerminal && activeTiling()?.enabled && activeSessionId() && activeTerminals()}>
          {/* Single InitProgress overlay for tiled mode (instead of per-terminal) */}
          <Show when={isActiveSessionInitializing()}>
            <div class="terminal-init-overlay">
              <InitProgress
                sessionName={activeSession()?.name || 'Terminal'}
                progress={sessionStore.getInitProgressForSession(activeSessionId()!)}
                onOpen={() => props.onOpenSessionById(activeSessionId()!)}
              />
            </div>
          </Show>
          <TiledTerminalContainer
            sessionId={activeSessionId()!}
            terminals={activeTerminals()!.tabs}
            tabOrder={activeTabOrder() || []}
            layout={activeTiling()!.layout}
            activeTabId={activeTerminals()!.activeTabId}
            onTileClick={props.onTileClick}
            renderTerminal={(tabId, slotIndex) => {
              const session = activeSession();
              if (!session) return null;
              return (
                <Terminal
                  sessionId={session.id}
                  terminalId={tabId}
                  sessionName={session.name}
                  active={true}
                  alwaysObserveResize={true}
                  hideInitProgress={true}
                  onError={props.onTerminalError}
                  onInitComplete={() => props.onOpenSessionById(session.id)}
                />
              );
            }}
          />
        </Show>

        {/* Standard tabbed view - when tiling is disabled */}
        <Show when={!activeTiling()?.enabled}>
          <For each={runningSessions()}>
            {(session) => {
              // Get terminals for this session
              const terminals = createMemo(() => getTerminalsForSession(session.id));

              return (
                <For each={terminals()?.tabs || [{ id: '1', createdAt: '' }]}>
                  {(tab) => {
                    // Terminal is active if: session is active AND this tab is the active tab
                    // During initialization, sessionTerminals is null - use fallback logic
                    const isActive = createMemo(() => {
                      const isActiveSession = session.id === activeSessionId();
                      const sessionTerminals = getTerminalsForSession(session.id);
                      // If no terminals yet (initializing), fallback tab '1' is active
                      const isActiveTab = sessionTerminals
                        ? sessionTerminals.activeTabId === tab.id
                        : tab.id === '1';  // Fallback tab is always '1'
                      return isActiveSession && isActiveTab;
                    });

                    return (
                      <Terminal
                        sessionId={session.id}
                        terminalId={tab.id}
                        sessionName={session.name}
                        active={isActive()}
                        onError={props.onTerminalError}
                        onInitComplete={() => props.onOpenSessionById(session.id)}
                      />
                    );
                  }}
                </For>
              );
            }}
          </For>
        </Show>
      </div>

      {/* Dashboard: shown when no active terminal */}
      <Show when={!props.showTerminal && !hasInitializingSession()}>
        <Dashboard
          sessions={sessionStore.sessions}
          onCreateSession={(agentType, tabConfig) => props.onCreateSession(generateSessionName(agentType, sessionStore.sessions), agentType, tabConfig)}
          onStartSession={props.onStartSession}
          onStopSession={props.onStopSession}
          onDeleteSession={props.onDeleteSession}
          onOpenSessionById={props.onDashboardSessionSelect || props.onOpenSessionById}
          viewState={props.viewState === 'terminal' ? 'dashboard' : props.viewState as 'dashboard' | 'expanding' | 'collapsing'}
          userName={props.userName}
          onSettingsClick={props.onSettingsClick}
          onLogout={props.onLogout}
        />
      </Show>
    </main>
  );
};

export default TerminalArea;
