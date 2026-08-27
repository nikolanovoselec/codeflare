import { Component, Show, createEffect, createMemo, Setter } from 'solid-js';
import Terminal from './Terminal';
import TerminalGrid, { type TerminalGridPane } from './TerminalGrid';
import FloatingTerminalButtons from './FloatingTerminalButtons';
import Dashboard from './Dashboard';
import { sessionStore } from '../stores/session';
import { terminalWorkspaceStore } from '../stores/terminal-workspace';
import type { AgentType, TabConfig, VisibleTerminalPane } from '../types';
import { generateSessionName } from '../lib/session-utils';

interface TerminalAreaProps {
  showTerminal: boolean;
  onOpenSessionById: (sessionId: string) => void;
  onOpenMultiView?: () => void;
  onDashboardSessionSelect?: (sessionId: string) => void;
  onStartSession: (id: string) => void;
  onOpenVscodeSession: (id: string) => void;
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
  const activeSession = createMemo(() => sessionStore.getActiveSession() ?? null);
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
  const hasInitializingTerminalSession = createMemo(() =>
    sessionStore.sessions.some((session) =>
      terminalWorkspaceStore.isTerminalSession(session)
      && sessionStore.isSessionInitializing(session.id)
    )
  );
  const sessionNamesById = createMemo((previous: { key: string; names: Map<string, string> } | undefined) => {
    const entries = sessionStore.sessions.map((session) => [session.id, session.name] as const);
    const key = entries.map(([id, name]) => `${id}\u0000${name}`).join('\u0001');
    if (previous?.key === key) return previous;
    return { key, names: new Map(entries) };
  });

  createEffect(() => {
    if (!props.showTerminal || isMultiViewWorkspace()) return;
    const session = activeTerminalSession();
    if (session) terminalWorkspaceStore.setSingleSessionWorkspace(session.id, session);
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
      <Show when={props.error}>
        <div class="layout-error">
          <span>{props.error}</span>
          <button type="button" onClick={props.onDismissError}>Dismiss</button>
        </div>
      </Show>

      <div class="layout-terminal-container" style={{ display: props.showTerminal ? undefined : 'none' }}>
        <FloatingTerminalButtons showTerminal={props.showTerminal} />

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
                  terminalId="1"
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

        <Show when={props.showTerminal && !isMultiViewWorkspace() && singleSessionPane()} keyed>
          {(pane) => {
            const session = createMemo(() => sessionStore.sessions.find((candidate) => candidate.id === pane.sessionId));
            return (
              <Terminal
                sessionId={pane.sessionId}
                terminalId="1"
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
        </Show>
      </div>

      <Show when={!props.showTerminal && !hasInitializingTerminalSession()}>
        <Dashboard
          sessions={sessionStore.sessions}
          onCreateSession={(agentType, tabConfig) => props.onCreateSession(generateSessionName(agentType, sessionStore.sessions), agentType, tabConfig)}
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
