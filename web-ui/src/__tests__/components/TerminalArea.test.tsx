import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@solidjs/testing-library';

// Mock child components
vi.mock('../../components/Terminal', () => ({
  default: (props: any) => (
    <div
      data-testid={`terminal-${props.sessionId}-${props.terminalId}`}
      data-visible={String(props.visible ?? props.active)}
      data-focused={String(props.focused ?? props.active)}
      data-connect={String(props.connect ?? props.active)}
    />
  )
}));

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

vi.mock('../../stores/terminal-workspace', () => ({
  terminalWorkspaceStore: {
    getVisiblePanes: vi.fn(() => mockVisiblePanes),
    getFocusedPaneId: vi.fn(() => mockFocusedPaneId),
    getLayout: vi.fn(() => mockWorkspaceLayout),
    setDashboardWorkspace: vi.fn(),
    setSingleSessionWorkspace: vi.fn(),
    setFocusedPane: vi.fn(),
  },
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get sessions() { return mockSessions; },
    get activeSessionId() { return mockActiveSessionId; },
    getActiveSession: vi.fn(() => {
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
});
