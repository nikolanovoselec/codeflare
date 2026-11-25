import { Component, For, Show, createEffect, createMemo, createRenderEffect, Setter, type JSX } from 'solid-js';
import type { PiWorkspaceModeBinding } from './PiWorkspaceMode';
import Terminal from './Terminal';
import TerminalTabs from './TerminalTabs';
import TilingButton from './TilingButton';
import TilingOverlay from './TilingOverlay';
import TiledTerminalContainer from './TiledTerminalContainer';
import TerminalGrid, { type TerminalGridPane } from './TerminalGrid';
import FloatingTerminalButtons from './FloatingTerminalButtons';
import InitProgress from './InitProgress';
import Dashboard from './Dashboard';
import type { MigrationRetry } from './MigrationRetryNotice';
import { sessionStore } from '../stores/session';
import { terminalWorkspaceStore } from '../stores/terminal-workspace';
import { resolveTerminalMode, type TileLayout, type AgentType, type TabConfig, type PiSurface, type VisibleTerminalPane } from '../types';
import { generateSessionName } from '../lib/session-utils';

interface TerminalAreaProps {
  workspaceMode?: PiWorkspaceModeBinding;
  migrationRetry: MigrationRetry;
  repositoryRestoreNotices?: JSX.Element;
  showTerminal: boolean;
  showPiWebPanel?: boolean;
  retainPiWebPanel?: boolean;
  parkedTerminalPane?: VisibleTerminalPane;
  piWebPanel?: JSX.Element;
  piWebOpenReady?: boolean;
  piWebShowDuringStartup?: boolean;
  piWebTerminalStatus?: JSX.Element;
  showTilingOverlay: boolean;
  onTilingButtonClick: () => void;
  onSelectTilingLayout: (layout: TileLayout) => void;
  onCloseTilingOverlay: () => void;
  onTileClick: (tabId: string) => void;
  onOpenSessionById: (sessionId: string) => void;
  onOpenMultiView?: () => void;
  onDashboardSessionSelect?: (sessionId: string, surface?: PiSurface) => void;
  onStartSession: (id: string, surface?: PiSurface) => void;
  onOpenVscodeSession: (id: string) => void;
  onStopSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onCreateSession: (name: string, agentType?: AgentType, tabConfig?: TabConfig[], surface?: PiSurface) => void;
  onTerminalError: Setter<string | null>;
  error: string | null;
  onDismissError: () => void;
  viewState: 'dashboard' | 'expanding' | 'terminal' | 'collapsing';
  userName?: string;
  onSettingsClick?: () => void;
  enterpriseMode?: boolean;
}

const TerminalArea: Component<TerminalAreaProps> = (props) => {
  const showNativeTerminal = () => props.showTerminal && !props.showPiWebPanel;

  // Derive session state from store directly (avoids prop drilling from Layout)
  const activeSession = createMemo(() => sessionStore.getActiveSession() ?? null);
  const activeSessionId = () => sessionStore.activeSessionId;
  const isHerdrSession = () => resolveTerminalMode(activeSession()?.terminalMode) === 'herdr';
  const activeTerminalSession = createMemo(() => {
    const session = activeSession();
    return terminalWorkspaceStore.isTerminalSession(session) ? session : null;
  });
  const terminalSessionsById = createMemo(() => new Map(
    sessionStore.sessions
      .filter((session) => terminalWorkspaceStore.isTerminalSession(session))
      .map((session) => [session.id, session] as const),
  ));

  const visiblePanes = createMemo(() => terminalWorkspaceStore.getVisiblePanes()
    .filter((pane) => terminalSessionsById().has(pane.sessionId)));
  const focusedPaneId = createMemo(() => terminalWorkspaceStore.getFocusedPaneId());
  const isMultiViewWorkspace = createMemo(() =>
    visiblePanes().some((pane) => pane.source === 'multiview')
  );
  const singleSessionPane = createMemo(() => {
    const session = activeTerminalSession();
    if (!session) return null;
    return visiblePanes().find((pane) => pane.source === 'session' && pane.sessionId === session.id) ?? null;
  });

  const isActiveSessionInitializing = createMemo(() => {
    const id = activeSessionId();
    return id ? sessionStore.isSessionInitializing(id) : false;
  });

  const chatStartupOverlay = () => props.showTerminal && isActiveSessionInitializing() && !props.piWebShowDuringStartup;
  const chatVisible = () => props.showTerminal && !chatStartupOverlay();

  const activeTiling = createMemo(() => {
    const session = activeTerminalSession();
    if (!session) return null;
    return sessionStore.getTilingForSession(session.id);
  });

  const activeTabOrder = createMemo(() => {
    const session = activeTerminalSession();
    if (!session) return null;
    return sessionStore.getTabOrder(session.id);
  });

  const activeTerminals = createMemo(() => {
    const session = activeTerminalSession();
    if (!session) return null;
    return sessionStore.getTerminalsForSession(session.id);
  });

  const resolveTerminalIdForSession = (sessionId: string) => {
    const session = sessionStore.sessions.find((candidate) => candidate.id === sessionId);
    return resolveTerminalMode(session?.terminalMode) === 'herdr'
      ? '1'
      : sessionStore.getTerminalsForSession(sessionId)?.activeTabId || '1';
  };

  const sessionNamesById = createMemo((previous: { key: string; names: Map<string, string> } | undefined) => {
    const entries = sessionStore.sessions.map((session) => [session.id, session.name] as const);
    const key = entries.map(([id, name]) => `${id}\u0000${name}`).join('\u0001');
    if (previous?.key === key) return previous;
    return { key, names: new Map(entries) };
  });

  createEffect(() => {
    if (!showNativeTerminal()) return;
    if (isMultiViewWorkspace()) return;

    const session = activeTerminalSession();
    if (!session) return;
    terminalWorkspaceStore.setSingleSessionWorkspace(
      session.id,
      resolveTerminalIdForSession(session.id),
      session,
    );
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

  const standardPane = () => showNativeTerminal() && !isMultiViewWorkspace() && (isHerdrSession() || !activeTiling()?.enabled)
    ? singleSessionPane() : props.parkedTerminalPane;
  const standardPaneKeys = () => {
    const pane = standardPane();
    return pane ? [`${pane.sessionId}:${pane.terminalId}:${terminalSessionsById().get(pane.sessionId)?.generation ?? ''}`] : [];
  };

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

      <Show when={showNativeTerminal()}>{props.piWebTerminalStatus}</Show>

      {/* Terminal tabs - show when active session is running/initializing */}
      <Show when={showNativeTerminal() && activeTerminalSession() && !isMultiViewWorkspace() && !isHerdrSession()}>
        <TerminalTabs sessionId={activeTerminalSession()!.id} />
      </Show>

      <div class="repository-restore-anchor">{props.repositoryRestoreNotices}</div>

      <Show when={(props.showTerminal && props.showPiWebPanel) || props.retainPiWebPanel}>
        <Show when={chatStartupOverlay()}>
          <div class="terminal-init-overlay">
            <InitProgress
              sessionName={activeSession()?.name || 'Terminal'}
              progress={sessionStore.getInitProgressForSession(activeSessionId()!)}
              openReady={props.piWebOpenReady === true}
              onOpen={() => { if (props.piWebOpenReady) props.onOpenSessionById(activeSessionId()!); }}
            />
          </div>
        </Show>
        <div class="pi-web-chat" style={{
          display: props.showTerminal ? undefined : 'none',
          visibility: chatVisible() ? undefined : 'hidden',
        }}
          ref={el => createRenderEffect(() => el.toggleAttribute('inert', !chatVisible()))}>
          {props.piWebPanel}
        </div>
      </Show>

      {/* Terminal container: render only visible workspace panes.
          Hidden (display:none) when on dashboard to prevent bleed-through and
          floating buttons from appearing during session creation. */}
      <div class="layout-terminal-container" style={{ display: showNativeTerminal() ? undefined : 'none' }}
        ref={el => createRenderEffect(() => el.toggleAttribute('inert', !showNativeTerminal()))}>
        {/* Tiling button - only show when active session is running with 2+ tabs */}
        <Show when={showNativeTerminal() && !isMultiViewWorkspace() && !isHerdrSession() && activeTerminalSession() && activeTerminals()}>
          <div class="layout-tiling-button-wrapper">
            <TilingButton
              sessionId={activeTerminalSession()!.id}
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
        <FloatingTerminalButtons showTerminal={showNativeTerminal()} />

        {/* Tiled terminal view - when tiling is enabled */}
        <Show when={showNativeTerminal() && !isMultiViewWorkspace() && !isHerdrSession() && activeTiling()?.enabled && activeTerminalSession() && activeTerminals()}>
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
            sessionId={activeTerminalSession()!.id}
            terminals={activeTerminals()!.tabs}
            tabOrder={activeTabOrder() || []}
            layout={activeTiling()!.layout}
            activeTabId={activeTerminals()!.activeTabId}
            onTileClick={props.onTileClick}
            renderTerminal={(tabId, _slotIndex) => {
              const session = activeTerminalSession();
              if (!session) return null;
              return (
                <Terminal
                  sessionId={session.id}
                  terminalId={tabId}
                  sessionName={session.name}
                  terminalMode={resolveTerminalMode(session.terminalMode)}
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
        <Show when={showNativeTerminal() && isMultiViewWorkspace()}>
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
                  terminalMode={resolveTerminalMode(terminalSessionsById().get(pane.data.sessionId)?.terminalMode)}
                  active={true}
                  visible={true}
                  focused={pane.active}
                  connect={true}
                  alwaysObserveResize={true}
                  hideInitProgress={true}
                  onActivate={() => terminalWorkspaceStore.setFocusedPane(pane.id)}
                  onError={props.onTerminalError}
                  onInitComplete={() => props.onOpenSessionById(pane.data.sessionId)}
                />
              );
            }}
          />
        </Show>

        {/* Reuse one tabbed instance by identity instead of remounting it when the pane store clears on Dashboard. */}
        <For each={standardPaneKeys()}>{() => {
          const pane = standardPane()!;
          const session = () => terminalSessionsById().get(pane.sessionId);
          return (
            <Terminal sessionId={pane.sessionId} terminalId={pane.terminalId}
              sessionName={session()?.name || 'Terminal'} terminalMode={resolveTerminalMode(session()?.terminalMode)}
              active={showNativeTerminal()} visible={showNativeTerminal()}
              focused={showNativeTerminal() && pane.id === focusedPaneId()} connect={true}
              onError={props.onTerminalError} onInitComplete={() => props.onOpenSessionById(pane.sessionId)} />
          );
        }}</For>
      </div>

      {/* Dashboard: shown when no active terminal */}
      <Show when={!props.showTerminal}>
        <Dashboard
          workspaceMode={props.workspaceMode}
          migrationRetry={props.migrationRetry}
          sessions={sessionStore.sessions}
          onCreateSession={(agentType, tabConfig, surface) => {
            const name = generateSessionName(agentType, sessionStore.sessions);
            if (surface) props.onCreateSession(name, agentType, tabConfig, surface);
            else props.onCreateSession(name, agentType, tabConfig);
          }}
          onStartSession={props.onStartSession}
          onOpenVscodeSession={props.onOpenVscodeSession}
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
