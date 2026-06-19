import { Component, For, Show, createEffect, createMemo, Setter } from 'solid-js';
import Terminal from './Terminal';
import TerminalTabs from './TerminalTabs';
import TilingButton from './TilingButton';
import TilingOverlay from './TilingOverlay';
import TiledTerminalContainer from './TiledTerminalContainer';
import TerminalGrid, { type TerminalGridPane } from './TerminalGrid';
import FloatingTerminalButtons from './FloatingTerminalButtons';
import InitProgress from './InitProgress';
import Dashboard from './Dashboard';
import { sessionStore } from '../stores/session';
import { terminalWorkspaceStore } from '../stores/terminal-workspace';
import type { TileLayout, AgentType, TabConfig, VisibleTerminalPane } from '../types';
import { generateSessionName } from '../lib/session-utils';

interface TerminalAreaProps {
  showTerminal: boolean;
  showTilingOverlay: boolean;
  onTilingButtonClick: () => void;
  onSelectTilingLayout: (layout: TileLayout) => void;
  onCloseTilingOverlay: () => void;
  onTileClick: (tabId: string) => void;
  onOpenSessionById: (sessionId: string) => void;
  onOpenMultiView?: () => void;
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
  enterpriseMode?: boolean;
}

const TerminalArea: Component<TerminalAreaProps> = (props) => {
  // Derive session state from store directly (avoids prop drilling from Layout)
  const activeSession = createMemo(() => sessionStore.getActiveSession() ?? null);
  const activeSessionId = () => sessionStore.activeSessionId;

  const visiblePanes = createMemo(() => terminalWorkspaceStore.getVisiblePanes());
  const focusedPaneId = createMemo(() => terminalWorkspaceStore.getFocusedPaneId());
  const isMultiViewWorkspace = createMemo(() =>
    visiblePanes().some((pane) => pane.source === 'multiview')
  );
  const singleSessionPane = createMemo(() =>
    visiblePanes().find((pane) => pane.source === 'session') ?? null
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

  const resolveTerminalIdForSession = (sessionId: string) =>
    sessionStore.getTerminalsForSession(sessionId)?.activeTabId || '1';

  const sessionNamesById = createMemo((previous: { key: string; names: Map<string, string> } | undefined) => {
    const entries = sessionStore.sessions.map((session) => [session.id, session.name] as const);
    const key = entries.map(([id, name]) => `${id}\u0000${name}`).join('\u0001');
    if (previous?.key === key) return previous;
    return { key, names: new Map(entries) };
  });

  createEffect(() => {
    if (!props.showTerminal) return;
    if (isMultiViewWorkspace()) return;

    const sessionId = activeSessionId();
    if (!sessionId) return;
    terminalWorkspaceStore.setSingleSessionWorkspace(sessionId, resolveTerminalIdForSession(sessionId));
  });

  const multiViewGridPanes = createMemo<TerminalGridPane<VisibleTerminalPane>[]>((previous) => {
    const panes = visiblePanes().filter((pane) => pane.source === 'multiview');
    const previousIds = previous?.map((pane) => pane.id).join('\u0000');
    const nextIds = panes.map((pane) => pane.id).join('\u0000');
    if (previous && previousIds === nextIds) return previous;

    return panes.map((pane) => ({
      id: pane.id,
      data: pane,
      get active() { return pane.id === focusedPaneId(); },
    }));
  });

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
      <Show when={props.showTerminal && activeSessionId() && !isMultiViewWorkspace()}>
        <TerminalTabs sessionId={activeSessionId()!} />
      </Show>

      {/* Terminal container: render only visible workspace panes.
          Hidden (display:none) when on dashboard to prevent bleed-through and
          floating buttons from appearing during session creation. */}
      <div class="layout-terminal-container" style={{ display: props.showTerminal ? undefined : 'none' }}>
        {/* Tiling button - only show when active session is running with 2+ tabs */}
        <Show when={props.showTerminal && !isMultiViewWorkspace() && activeSessionId() && activeTerminals()}>
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
        <Show when={props.showTerminal && !isMultiViewWorkspace() && activeTiling()?.enabled && activeSessionId() && activeTerminals()}>
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
            renderTerminal={(tabId, _slotIndex) => {
              const session = activeSession();
              if (!session) return null;
              return (
                <Terminal
                  sessionId={session.id}
                  terminalId={tabId}
                  sessionName={session.name}
                  active={true}
                  visible={true}
                  focused={tabId === activeTerminals()!.activeTabId}
                  connect={true}
                  alwaysObserveResize={true}
                  hideInitProgress={true}
                  onError={props.onTerminalError}
                  onInitComplete={() => props.onOpenSessionById(session.id)}
                />
              );
            }}
          />
        </Show>

        {/* MultiView session grid - each pane is one existing session, not a nested tab set. */}
        <Show when={props.showTerminal && isMultiViewWorkspace()}>
          <TerminalGrid
            layout={terminalWorkspaceStore.getLayout()}
            panes={multiViewGridPanes()}
            onPaneClick={(paneId) => terminalWorkspaceStore.setFocusedPane(paneId)}
            renderPane={(pane) => {
              const sessionName = createMemo(() => sessionNamesById().names.get(pane.data.sessionId) || 'Terminal');
              return (
                <Terminal
                  sessionId={pane.data.sessionId}
                  terminalId={pane.data.terminalId}
                  sessionName={sessionName()}
                  active={true}
                  visible={true}
                  focused={pane.active}
                  connect={true}
                  alwaysObserveResize={true}
                  hideInitProgress={true}
                  onError={props.onTerminalError}
                  onInitComplete={() => props.onOpenSessionById(pane.data.sessionId)}
                />
              );
            }}
          />
        </Show>

        {/* Standard tabbed view - only the visible workspace pane mounts/connects. */}
        <Show when={props.showTerminal && !isMultiViewWorkspace() && !activeTiling()?.enabled}>
          <For each={singleSessionPane() ? [singleSessionPane()!] : []}>
            {(pane) => {
              const session = createMemo(() => sessionStore.sessions.find((candidate) => candidate.id === pane.sessionId));
              return (
                <Terminal
                  sessionId={pane.sessionId}
                  terminalId={pane.terminalId}
                  sessionName={session()?.name || 'Terminal'}
                  active={true}
                  visible={true}
                  focused={pane.id === focusedPaneId()}
                  connect={true}
                  onError={props.onTerminalError}
                  onInitComplete={() => props.onOpenSessionById(pane.sessionId)}
                />
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
          onOpenMultiView={props.onOpenMultiView}
          viewState={props.viewState === 'terminal' ? 'dashboard' : props.viewState as 'dashboard' | 'expanding' | 'collapsing'}
          userName={props.userName}
          onSettingsClick={props.onSettingsClick}
          enterpriseMode={props.enterpriseMode}
        />
      </Show>
    </main>
  );
};

export default TerminalArea;
