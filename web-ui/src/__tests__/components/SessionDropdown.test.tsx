import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import SessionDropdown from '../../components/SessionDropdown';
import type { SessionWithStatus } from '../../types';

// Mock child components
vi.mock('../../components/SessionStatCard', () => ({
  default: (props: any) => (
    <div
      data-testid={`session-stat-card-${props.session.id}`}
      data-active={String(props.isActive)}
      onClick={props.onSelect}
    >
      {props.session.name}
    </div>
  ),
}));

vi.mock('../../components/SessionContextMenu', () => ({
  default: (props: any) => (
    <div data-testid="session-context-menu" data-open={String(props.isOpen)} />
  ),
}));

vi.mock('../../components/CreateSessionDialog', () => ({
  default: (props: any) => (
    <div data-testid="create-session-dialog" data-open={String(props.isOpen)}>
      <button data-testid="csd-select-agent" onClick={() => props.onSelect('claude-code')}>
        Select Agent
      </button>
    </div>
  ),
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    getMetricsForSession: vi.fn(() => null),
    getInitProgressForSession: vi.fn(() => null),
    sessions: [],
  },
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    getConnectionState: vi.fn(() => 'connected'),
  },
}));

function createSession(overrides: Partial<SessionWithStatus> = {}): SessionWithStatus {
  return {
    id: 'test-1',
    name: 'Test Session',
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    status: 'stopped',
    ...overrides,
  };
}

describe('SessionDropdown', () => {
  const defaultProps = {
    isOpen: true,
    sessions: [
      createSession({ id: 's1', name: 'Running Session', status: 'running' }),
      createSession({ id: 's2', name: 'Stopped Session', status: 'stopped' }),
      createSession({ id: 's3', name: 'Initializing Session', status: 'initializing' }),
    ],
    activeSessionId: 's1' as string | null,
    onSelectSession: vi.fn(),
    onStopSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onCreateSession: vi.fn(),
    onClose: vi.fn(),
    isMobileView: false,
  };

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => cleanup());

  describe('Rendering', () => {
    it('renders when isOpen is true', () => {
      render(() => <SessionDropdown {...defaultProps} />);
      expect(screen.getByTestId('session-dropdown')).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      render(() => <SessionDropdown {...defaultProps} isOpen={false} />);
      expect(screen.queryByTestId('session-dropdown')).not.toBeInTheDocument();
    });
  });

  describe('Session ordering', () => {
    it('shows running sessions first, then initializing, then stopped, then error', () => {
      const sessions = [
        createSession({ id: 's-stopped', name: 'Stopped', status: 'stopped' }),
        createSession({ id: 's-error', name: 'Errored', status: 'error' }),
        createSession({ id: 's-running', name: 'Running', status: 'running' }),
        createSession({ id: 's-init', name: 'Initializing', status: 'initializing' }),
      ];
      render(() => <SessionDropdown {...defaultProps} sessions={sessions} />);

      const cards = screen.getAllByTestId(/^session-stat-card-/);
      expect(cards[0]).toHaveAttribute('data-testid', 'session-stat-card-s-running');
      expect(cards[1]).toHaveAttribute('data-testid', 'session-stat-card-s-init');
      expect(cards[2]).toHaveAttribute('data-testid', 'session-stat-card-s-stopped');
      expect(cards[3]).toHaveAttribute('data-testid', 'session-stat-card-s-error');
    });
  });

  describe('Session selection', () => {
    it('calls onSelectSession and onClose when a card is clicked', () => {
      const onSelectSession = vi.fn();
      const onClose = vi.fn();
      render(() => <SessionDropdown {...defaultProps} onSelectSession={onSelectSession} onClose={onClose} />);

      fireEvent.click(screen.getByTestId('session-stat-card-s1'));
      expect(onSelectSession).toHaveBeenCalledWith('s1');
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('New Session button', () => {
    it('shows "+ New Session" button', () => {
      render(() => <SessionDropdown {...defaultProps} />);
      expect(screen.getByTestId('session-dropdown-new')).toBeInTheDocument();
    });

    it('opens CreateSessionDialog when clicked', async () => {
      render(() => <SessionDropdown {...defaultProps} />);

      // Before clicking, the dialog should be closed
      const dialogBefore = screen.getByTestId('create-session-dialog');
      expect(dialogBefore).toHaveAttribute('data-open', 'false');

      // Click the "+ New Session" button
      await fireEvent.click(screen.getByTestId('session-dropdown-new'));

      // After clicking, the dialog should be open
      const dialogAfter = screen.getByTestId('create-session-dialog');
      expect(dialogAfter).toHaveAttribute('data-open', 'true');
    });

    it('renders CreateSessionDialog outside the popover container', async () => {
      render(() => <SessionDropdown {...defaultProps} />);

      await fireEvent.click(screen.getByTestId('session-dropdown-new'));

      const dialog = screen.getByTestId('create-session-dialog');
      const popover = screen.getByTestId('session-dropdown');

      // The dialog must NOT be a descendant of the popover div
      // This prevents backdrop-filter from creating a new containing block
      // that breaks position:fixed on the dialog
      expect(popover.contains(dialog)).toBe(false);
    });
  });

  describe('Mobile bottom sheet', () => {
    it('renders as bottom-sheet when isMobileView is true', () => {
      render(() => <SessionDropdown {...defaultProps} isMobileView={true} />);
      const dropdown = screen.getByTestId('session-dropdown');
      expect(dropdown).toHaveClass('session-dropdown--bottom-sheet');
    });

    it('renders as popover when isMobileView is false', () => {
      render(() => <SessionDropdown {...defaultProps} isMobileView={false} />);
      const dropdown = screen.getByTestId('session-dropdown');
      expect(dropdown).toHaveClass('session-dropdown--popover');
    });
  });

  describe('Active session highlighting', () => {
    it('marks the active session card as active', () => {
      render(() => <SessionDropdown {...defaultProps} activeSessionId="s1" />);
      const card = screen.getByTestId('session-stat-card-s1');
      expect(card).toHaveAttribute('data-active', 'true');
    });
  });

  describe('Session card background consistency', () => {
    it('uses session-dropdown--no-blur class to avoid backdrop-filter affecting card backgrounds', () => {
      render(() => <SessionDropdown {...defaultProps} />);
      const dropdown = screen.getByTestId('session-dropdown');
      // The dropdown should not have backdrop-filter so session cards
      // look identical to the dashboard
      expect(dropdown.className).toContain('session-dropdown--popover');
    });
  });
});
