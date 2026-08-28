import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

const terminalLifecycle = vi.hoisted(() => ({
  unmounted: [] as string[],
}));

// Mock child components
vi.mock('../../components/Terminal', async () => {
  const { onCleanup } = await import('solid-js');
  return {
    default: (props: any) => {
      const key = `${props.sessionId}:${props.terminalId}`;
      onCleanup(() => terminalLifecycle.unmounted.push(key));
      return (
        <div
          data-testid={`terminal-${props.sessionId}-${props.terminalId}`}
          data-visible={String(props.visible ?? props.active)}
          data-focused={String(props.focused ?? props.active)}
          data-connect={String(props.connect ?? props.active)}
        />
      );
    },
  };
});

vi.mock('../../components/TerminalTabs', () => ({
  default: (props: any) => <div data-testid="terminal-tabs" data-session={props.sessionId} />
}));

vi.mock('../../components/TilingButton', () => ({
  default: () => <div data-testid="tiling-button" />
}));

vi.mock('../../components/TilingOverlay', () => ({
  default: () => <div data-testid="tiling-overlay" />
}));

vi.mock('../../components/TiledTerminalContainer', () => ({
  default: (props: any) => (
    <div data-testid="tiled-container">
      {(props.tabOrder || []).map((tabId: string, index: number) => props.renderTerminal?.(tabId, index))}
    </div>
  )
}));

vi.mock('../../components/FloatingTerminalButtons', () => ({
  default: () => <div data-testid="floating-buttons" />
}));

vi.mock('../../components/InitProgress', () => ({
  default: () => <div data-testid="init-progress" />
}));

vi.mock('../../components/Dashboard', () => ({
  default: (_props: any) => <div data-testid="dashboard" />
}));

vi.mock('../../lib/session-utils', () => ({
  generateSessionName: vi.fn(() => 'New Session'),
}));

let mockSessions: any[] = [];
let mockActiveSessionId: string | null = null;
let mockVisiblePanes: any[] = [];
let mockFocusedPaneId: string | null = null;
let mockWorkspaceLayout = 'tabbed';
let readWorkspaceVersion = () => 0;
let bumpWorkspaceVersion = () => {};

vi.mock('../../stores/terminal-workspace', () => ({
  terminalWorkspaceStore: {
    getVisiblePanes: vi.fn(() => { readWorkspaceVersion(); return mockVisiblePanes; }),
    getFocusedPaneId: vi.fn(() => { readWorkspaceVersion(); return mockFocusedPaneId; }),
    getLayout: vi.fn(() => { readWorkspaceVersion(); return mockWorkspaceLayout; }),
    isTerminalSession: vi.fn((session: any) => session != null && session.workspace !== 'vscode'),
    setDashboardWorkspace: vi.fn(),
    setSingleSessionWorkspace: vi.fn(),
    setFocusedPane: vi.fn(),
  },
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get sessions() { readWorkspaceVersion(); return mockSessions; },
    get activeSessionId() { readWorkspaceVersion(); return mockActiveSessionId; },
    getActiveSession: vi.fn(() => {
      readWorkspaceVersion();
      if (!mockActiveSessionId) return null;
      return mockSessions.find((s: any) => s.id === mockActiveSessionId) || null;
    }),
    isSessionInitializing: vi.fn(() => false),
    getInitProgressForSession: vi.fn(() => null),
    getTerminalsForSession: vi.fn(() => null),
    getTilingForSession: vi.fn(() => null),
    getTabOrder: vi.fn(() => []),
  },
}));

import TerminalArea from '../../components/TerminalArea';
import { terminalWorkspaceStore } from '../../stores/terminal-workspace';
import { sessionStore } from '../../stores/session';

// REQ-TERM-017: MultiView Pane Focus and Input Routing
describe('TerminalArea', () => {
  const defaultProps = {
    showTerminal: false,
    showTilingOverlay: false,
    onTilingButtonClick: vi.fn(),
    onSelectTilingLayout: vi.fn(),
    onCloseTilingOverlay: vi.fn(),
    onTileClick: vi.fn(),
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessions = [];
    mockActiveSessionId = null;
    mockVisiblePanes = [];
    mockFocusedPaneId = null;
    mockWorkspaceLayout = 'tabbed';
    terminalLifecycle.unmounted = [];
    vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
    vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue(null);
    vi.mocked(sessionStore.getTilingForSession).mockReturnValue(null);
    vi.mocked(sessionStore.getTabOrder).mockReturnValue([]);
    const [workspaceVersion, setWorkspaceVersion] = createSignal(0);
    readWorkspaceVersion = workspaceVersion;
    bumpWorkspaceVersion = () => setWorkspaceVersion((value) => value + 1);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the layout-main container', () => {
    const { container } = render(() => <TerminalArea {...defaultProps} />);

    expect(container.querySelector('.layout-main')).toBeInTheDocument();
  });

  it('shows Dashboard when showTerminal is false', () => {
    render(() => <TerminalArea {...defaultProps} showTerminal={false} />);

    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
  });

  it('hides terminal container when showTerminal is false', () => {
    const { container } = render(() => <TerminalArea {...defaultProps} showTerminal={false} />);

    const terminalContainer = container.querySelector('.layout-terminal-container');
    expect(terminalContainer).toBeInTheDocument();
    expect((terminalContainer as HTMLElement).style.display).toBe('none');
  });

  it('keeps Dashboard mounted while a VS Code session initializes', () => {
    mockSessions = [{ id: 'vscode-a', name: 'VS Code', status: 'initializing', workspace: 'vscode' }];
    vi.mocked(sessionStore.isSessionInitializing).mockImplementation((id) => id === 'vscode-a');

    render(() => <TerminalArea {...defaultProps} showTerminal={false} />);

    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
  });

  it('keeps Terminal initialization gating Dashboard unchanged', () => {
    mockSessions = [{ id: 'terminal-a', name: 'Terminal', status: 'initializing', workspace: 'terminal' }];
    vi.mocked(sessionStore.isSessionInitializing).mockImplementation((id) => id === 'terminal-a');

    render(() => <TerminalArea {...defaultProps} showTerminal={false} />);

    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
  });

  it('shows error banner when error prop is provided', () => {
    render(() => <TerminalArea {...defaultProps} error="Something went wrong" />);

    const errorDiv = document.querySelector('.layout-error');
    expect(errorDiv).toBeInTheDocument();
    expect(errorDiv?.textContent).toContain('Something went wrong');
  });

  it('renders dismiss button in error banner', () => {
    render(() => <TerminalArea {...defaultProps} error="Error" />);

    const dismissBtn = document.querySelector('.layout-error button');
    expect(dismissBtn).toBeInTheDocument();
    expect(dismissBtn?.textContent).toBe('Dismiss');
  });

  it('does not show error banner when error is null', () => {
    render(() => <TerminalArea {...defaultProps} error={null} />);

    expect(document.querySelector('.layout-error')).not.toBeInTheDocument();
  });

  it('renders FloatingTerminalButtons', () => {
    render(() => <TerminalArea {...defaultProps} />);

    expect(screen.getByTestId('floating-buttons')).toBeInTheDocument();
  });

  it('REQ-TERM-011: renders no terminal panes on Dashboard even when sessions are running', () => {
    mockSessions = [
      { id: 'session-a', name: 'A', status: 'running' },
      { id: 'session-b', name: 'B', status: 'running' },
    ];
    mockActiveSessionId = null;
    mockVisiblePanes = [];

    render(() => <TerminalArea {...defaultProps} showTerminal={false} />);

    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-session-a-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('terminal-session-b-1')).not.toBeInTheDocument();
  });

  it('REQ-TERM-011: does not mount a stale visible pane while Dashboard is showing', () => {
    mockSessions = [{ id: 'session-a', name: 'A', status: 'running' }];
    mockActiveSessionId = 'session-a';
    mockVisiblePanes = [{ id: 'session:session-a:1', sessionId: 'session-a', terminalId: '1', source: 'session' }];
    mockFocusedPaneId = 'session:session-a:1';

    render(() => <TerminalArea {...defaultProps} showTerminal={false} />);

    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-session-a-1')).not.toBeInTheDocument();
  });

  it('REQ-TERM-012: does not clear a pending MultiView workspace before the terminal transition renders it', () => {
    mockSessions = [
      { id: 'session-a', name: 'A', status: 'running' },
      { id: 'session-b', name: 'B', status: 'running' },
    ];
    mockActiveSessionId = null;
    mockVisiblePanes = [
      { id: 'multiview:session-a:1', sessionId: 'session-a', terminalId: '1', source: 'multiview' },
      { id: 'multiview:session-b:1', sessionId: 'session-b', terminalId: '1', source: 'multiview' },
    ];

    render(() => <TerminalArea {...defaultProps} showTerminal={false} />);

    expect(terminalWorkspaceStore.setDashboardWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-session-a-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('terminal-session-b-1')).not.toBeInTheDocument();
  });

  it('REQ-TERM-011: renders only the visible single-session workspace pane', () => {
    mockSessions = [
      { id: 'session-a', name: 'A', status: 'running' },
      { id: 'session-b', name: 'B', status: 'running' },
    ];
    mockActiveSessionId = 'session-a';
    mockVisiblePanes = [{ id: 'session:session-a:1', sessionId: 'session-a', terminalId: '1', source: 'session' }];
    mockFocusedPaneId = 'session:session-a:1';

    render(() => <TerminalArea {...defaultProps} showTerminal viewState="terminal" />);

    const visibleTerminal = screen.getByTestId('terminal-session-a-1');
    expect(visibleTerminal).toHaveAttribute('data-connect', 'true');
    expect(visibleTerminal).toHaveAttribute('data-focused', 'true');
    expect(screen.queryByTestId('terminal-session-b-1')).not.toBeInTheDocument();
  });

  it('REQ-TERM-012: renders one connected terminal pane for each visible MultiView member', () => {
    mockSessions = [
      { id: 'session-a', name: 'A', status: 'running' },
      { id: 'session-b', name: 'B', status: 'running' },
      { id: 'session-c', name: 'C', status: 'running' },
    ];
    mockActiveSessionId = null;
    mockVisiblePanes = [
      { id: 'multiview:session-a:1', sessionId: 'session-a', terminalId: '1', source: 'multiview' },
      { id: 'multiview:session-b:1', sessionId: 'session-b', terminalId: '1', source: 'multiview' },
    ];
    mockFocusedPaneId = 'multiview:session-b:1';
    mockWorkspaceLayout = '2-split';

    render(() => <TerminalArea {...defaultProps} showTerminal viewState="terminal" />);

    const paneA = screen.getByTestId('terminal-session-a-1');
    const paneB = screen.getByTestId('terminal-session-b-1');
    expect(paneA).toHaveAttribute('data-connect', 'true');
    expect(paneA).toHaveAttribute('data-focused', 'false');
    expect(paneB).toHaveAttribute('data-connect', 'true');
    expect(paneB).toHaveAttribute('data-focused', 'true');
    expect(screen.queryByTestId('terminal-session-c-1')).not.toBeInTheDocument();
  });

  it('renders one Herdr surface without classic tabs or tiling controls', () => {
    mockSessions = [{ id: 'herdr-a', name: 'Herdr', status: 'running', terminalMode: 'herdr' }];
    mockActiveSessionId = 'herdr-a';
    mockVisiblePanes = [{ id: 'session:herdr-a:1', sessionId: 'herdr-a', terminalId: '1', source: 'session' }];
    mockFocusedPaneId = 'session:herdr-a:1';
    vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
      tabs: [{ id: '1', createdAt: 'now' }],
      activeTabId: '1',
      tabOrder: ['1'],
      tiling: { enabled: false, layout: 'tabbed' },
    });

    render(() => <TerminalArea {...defaultProps} showTerminal={true} viewState="terminal" />);

    expect(screen.getByTestId('terminal-herdr-a-1')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-tabs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tiling-button')).not.toBeInTheDocument();
  });

  it('does not give a VS Code active session terminal workspace or WebSocket ownership', () => {
    mockSessions = [{ id: 'vscode-a', name: 'VS Code', status: 'running', workspace: 'vscode' }];
    mockActiveSessionId = 'vscode-a';
    mockVisiblePanes = [
      { id: 'session:vscode-a:1', sessionId: 'vscode-a', terminalId: '1', source: 'session' },
    ];
    vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
      activeTabId: '1',
      tabs: [{ id: '1' }],
    } as any);
    vi.mocked(sessionStore.getTilingForSession).mockReturnValue({ enabled: true, layout: '2-split' });
    vi.mocked(sessionStore.getTabOrder).mockReturnValue(['1']);

    render(() => <TerminalArea {...defaultProps} showTerminal viewState="terminal" />);

    expect(terminalWorkspaceStore.setSingleSessionWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-tabs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tiling-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tiled-container')).not.toBeInTheDocument();
    expect(screen.queryByTestId('terminal-vscode-a-1')).not.toBeInTheDocument();
    expect(document.querySelector('[data-connect="true"]')).not.toBeInTheDocument();
  });

  it('filters stale VS Code MultiView panes before Terminal connection ownership', () => {
    mockSessions = [
      { id: 'terminal-a', name: 'Terminal', status: 'running', workspace: 'terminal' },
      { id: 'vscode-a', name: 'VS Code', status: 'running', workspace: 'vscode' },
    ];
    mockVisiblePanes = [
      { id: 'multiview:terminal-a:1', sessionId: 'terminal-a', terminalId: '1', source: 'multiview' },
      { id: 'multiview:vscode-a:1', sessionId: 'vscode-a', terminalId: '1', source: 'multiview' },
    ];
    mockFocusedPaneId = 'multiview:terminal-a:1';
    mockWorkspaceLayout = '2-split';

    render(() => <TerminalArea {...defaultProps} showTerminal viewState="terminal" />);

    expect(screen.getByTestId('terminal-terminal-a-1')).toHaveAttribute('data-connect', 'true');
    expect(screen.queryByTestId('terminal-vscode-a-1')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-connect="true"]')).toHaveLength(1);
  });

  it('REQ-TERM-012: changes MultiView pane focus without remounting terminal panes / REQ-TERM-017', async () => {
    mockSessions = [
      { id: 'session-a', name: 'A', status: 'running' },
      { id: 'session-b', name: 'B', status: 'running' },
    ];
    mockActiveSessionId = null;
    mockVisiblePanes = [
      { id: 'multiview:session-a:1', sessionId: 'session-a', terminalId: '1', source: 'multiview' },
      { id: 'multiview:session-b:1', sessionId: 'session-b', terminalId: '1', source: 'multiview' },
    ];
    mockFocusedPaneId = 'multiview:session-a:1';
    mockWorkspaceLayout = '2-split';

    render(() => <TerminalArea {...defaultProps} showTerminal viewState="terminal" />);

    expect(screen.getByTestId('terminal-session-a-1')).toHaveAttribute('data-focused', 'true');
    expect(screen.getByTestId('terminal-session-b-1')).toHaveAttribute('data-focused', 'false');

    terminalLifecycle.unmounted = [];
    mockFocusedPaneId = 'multiview:session-b:1';
    bumpWorkspaceVersion();

    await waitFor(() => expect(screen.getByTestId('terminal-session-b-1')).toHaveAttribute('data-focused', 'true'));
    expect(screen.getByTestId('terminal-session-a-1')).toHaveAttribute('data-focused', 'false');
    expect(terminalLifecycle.unmounted).toEqual([]);
  });

  it('REQ-TERM-012: renders the MultiView terminal id tracked by the visible workspace', () => {
    mockSessions = [
      { id: 'session-a', name: 'A', status: 'running' },
      { id: 'session-b', name: 'B', status: 'running' },
    ];
    mockActiveSessionId = null;
    mockVisiblePanes = [
      { id: 'multiview:session-a:2', sessionId: 'session-a', terminalId: '2', source: 'multiview' },
      { id: 'multiview:session-b:1', sessionId: 'session-b', terminalId: '1', source: 'multiview' },
    ];
    mockFocusedPaneId = 'multiview:session-a:2';
    mockWorkspaceLayout = '2-split';
    vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
      activeTabId: '3',
      tabs: [
        { id: '1', label: 'One', manual: false },
        { id: '2', label: 'Two', manual: true },
        { id: '3', label: 'Three', manual: true },
      ],
    } as any);

    render(() => <TerminalArea {...defaultProps} showTerminal viewState="terminal" />);

    expect(screen.getByTestId('terminal-session-a-2')).toHaveAttribute('data-focused', 'true');
    expect(screen.queryByTestId('terminal-session-a-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('terminal-session-a-3')).not.toBeInTheDocument();
  });

  it('REQ-TERM-011: tears down the old single-session terminal when the visible pane key changes', async () => {
    mockSessions = [
      { id: 'session-a', name: 'A', status: 'running' },
      { id: 'session-b', name: 'B', status: 'running' },
    ];
    mockActiveSessionId = 'session-a';
    mockVisiblePanes = [{ id: 'session:session-a:1', sessionId: 'session-a', terminalId: '1', source: 'session' }];
    mockFocusedPaneId = 'session:session-a:1';

    render(() => <TerminalArea {...defaultProps} showTerminal viewState="terminal" />);
    expect(screen.getByTestId('terminal-session-a-1')).toHaveAttribute('data-connect', 'true');

    terminalLifecycle.unmounted = [];
    mockActiveSessionId = 'session-b';
    mockVisiblePanes = [{ id: 'session:session-b:1', sessionId: 'session-b', terminalId: '1', source: 'session' }];
    mockFocusedPaneId = 'session:session-b:1';
    bumpWorkspaceVersion();

    await waitFor(() => expect(screen.getByTestId('terminal-session-b-1')).toHaveAttribute('data-connect', 'true'));
    expect(screen.queryByTestId('terminal-session-a-1')).not.toBeInTheDocument();
    expect(terminalLifecycle.unmounted).toContain('session-a:1');
  });
});
