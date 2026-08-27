import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@solidjs/testing-library';

vi.mock('../../components/Terminal', () => ({
  default: (props: any) => <div data-testid={`terminal-${props.sessionId}-${props.terminalId}`} />,
}));
vi.mock('../../components/TerminalGrid', () => ({
  default: (props: any) => <div>{props.panes.map((pane: any) => props.renderPane(pane))}</div>,
}));
vi.mock('../../components/FloatingTerminalButtons', () => ({ default: () => null }));
vi.mock('../../components/Dashboard', () => ({ default: () => <div data-testid="dashboard" /> }));
vi.mock('../../lib/session-utils', () => ({ generateSessionName: () => 'Session' }));

let sessions: any[] = [];
let activeSessionId: string | null = null;
let panes: any[] = [];

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get sessions() { return sessions; },
    get activeSessionId() { return activeSessionId; },
    getActiveSession: () => sessions.find((session) => session.id === activeSessionId) ?? null,
    isSessionInitializing: () => false,
  },
}));
vi.mock('../../stores/terminal-workspace', () => ({
  terminalWorkspaceStore: {
    getVisiblePanes: () => panes,
    getFocusedPaneId: () => panes[0]?.id ?? null,
    getLayout: () => panes.length > 2 ? '3-split' : '2-split',
    isTerminalSession: (session: any) => session != null && session.workspace !== 'vscode',
    setSingleSessionWorkspace: vi.fn(),
    setFocusedPane: vi.fn(),
  },
}));

import TerminalArea from '../../components/TerminalArea';

const props = {
  showTerminal: false,
  onOpenSessionById: vi.fn(),
  onStartSession: vi.fn(),
  onOpenVscodeSession: vi.fn(),
  onStopSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onCreateSession: vi.fn(),
  onTerminalError: vi.fn(),
  error: null,
  onDismissError: vi.fn(),
  viewState: 'dashboard' as const,
};

describe('TerminalArea existing surface ownership contract', () => {
  beforeEach(() => {
    sessions = [];
    activeSessionId = null;
    panes = [];
  });
  afterEach(cleanup);

  it('mounts no terminal on Dashboard or for a VS Code workspace', () => {
    const view = render(() => <TerminalArea {...props} />);
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId(/^terminal-/)).toBeNull();

    view.unmount();
    sessions = [{ id: 'editor-a', name: 'Editor', status: 'running', workspace: 'vscode' }];
    activeSessionId = 'editor-a';
    render(() => <TerminalArea {...props} showTerminal={true} viewState="terminal" />);
    expect(screen.queryByTestId(/^terminal-/)).toBeNull();
  });

  it('mounts one internal terminal 1 per visible backend session', () => {
    sessions = [
      { id: 'session-a', name: 'A', status: 'running' },
      { id: 'session-b', name: 'B', status: 'running' },
    ];
    panes = sessions.map((session) => ({
      id: `multiview:${session.id}:1`, sessionId: session.id, terminalId: '1', source: 'multiview',
    }));
    render(() => <TerminalArea {...props} showTerminal={true} viewState="terminal" />);
    expect(screen.getAllByTestId(/^terminal-/)).toHaveLength(2);
    expect(screen.getByTestId('terminal-session-a-1')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-session-b-1')).toBeInTheDocument();
  });
});
