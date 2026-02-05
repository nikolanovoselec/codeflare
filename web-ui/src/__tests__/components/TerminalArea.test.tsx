import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@solidjs/testing-library';

// Mock child components
vi.mock('../../components/Terminal', () => ({
  default: (props: any) => <div data-testid={`terminal-${props.sessionId}-${props.terminalId}`} />
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
  default: () => <div data-testid="tiled-container" />
}));

vi.mock('../../components/FloatingTerminalButtons', () => ({
  default: () => <div data-testid="floating-buttons" />
}));

vi.mock('../../components/InitProgress', () => ({
  default: () => <div data-testid="init-progress" />
}));

vi.mock('../../components/Dashboard', () => ({
  default: (props: any) => <div data-testid="dashboard" />
}));

vi.mock('../../lib/session-utils', () => ({
  generateSessionName: vi.fn(() => 'New Session'),
}));

let mockSessions: any[] = [];
let mockActiveSessionId: string | null = null;

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
});
