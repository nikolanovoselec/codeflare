import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import SessionSwitcher from '../../components/SessionSwitcher';
import type { SessionWithStatus } from '../../types';

// Mock isMobile
const isMobileMock = vi.hoisted(() => ({ value: false }));
vi.mock('../../lib/mobile', () => ({
  isMobile: () => isMobileMock.value,
}));

// Mock SessionDropdown
vi.mock('../../components/SessionDropdown', () => ({
  default: (props: any) => (
    <div data-testid="session-dropdown" data-open={String(props.isOpen)} />
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

describe('SessionSwitcher', () => {
  const defaultProps = {
    sessions: [createSession({ id: 's1', name: 'My Session', status: 'running' })],
    activeSessionId: 's1' as string | null,
    onSelectSession: vi.fn(),
    onStopSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onCreateSession: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    isMobileMock.value = false;
  });
  afterEach(() => cleanup());

  describe('Desktop rendering', () => {
    it('shows active session name and status dot', () => {
      render(() => <SessionSwitcher {...defaultProps} />);
      expect(screen.getByTestId('session-switcher')).toBeInTheDocument();
      expect(screen.getByTestId('session-switcher-name')).toHaveTextContent('My Session');
    });

    it('shows status dot with correct variant for running session', () => {
      render(() => <SessionSwitcher {...defaultProps} />);
      const dot = screen.getByTestId('session-switcher').querySelector('.session-switcher__dot--success');
      expect(dot).toBeInTheDocument();
    });

    it('shows "No session" when no active session', () => {
      render(() => <SessionSwitcher {...defaultProps} activeSessionId={null} />);
      expect(screen.getByTestId('session-switcher-name')).toHaveTextContent('No session');
    });
  });

  describe('Mobile rendering', () => {
    it('shows layers icon instead of session name on mobile', () => {
      isMobileMock.value = true;
      render(() => <SessionSwitcher {...defaultProps} />);
      expect(screen.getByTestId('session-switcher-mobile-icon')).toBeInTheDocument();
      expect(screen.queryByTestId('session-switcher-name')).not.toBeInTheDocument();
    });
  });

  describe('Dropdown toggle', () => {
    it('opens dropdown on click', () => {
      render(() => <SessionSwitcher {...defaultProps} />);
      fireEvent.click(screen.getByTestId('session-switcher'));
      const dropdown = screen.getByTestId('session-dropdown');
      expect(dropdown).toHaveAttribute('data-open', 'true');
    });

    it('closes dropdown on second click', () => {
      render(() => <SessionSwitcher {...defaultProps} />);
      fireEvent.click(screen.getByTestId('session-switcher'));
      fireEvent.click(screen.getByTestId('session-switcher'));
      const dropdown = screen.getByTestId('session-dropdown');
      expect(dropdown).toHaveAttribute('data-open', 'false');
    });
  });
});
