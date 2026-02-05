import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import SessionStatCard from '../../components/SessionStatCard';
import type { SessionWithStatus } from '../../types';

// Mock stores
vi.mock('../../stores/session', () => ({
  sessionStore: {
    getMetricsForSession: vi.fn(() => ({
      bucketName: 'codeflare-test',
      cpu: '15%',
      mem: '1.2/3.0G',
      hdd: '2.1G/10G',
    })),
    getInitProgressForSession: vi.fn(() => ({ progress: 50 })),
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
    agentType: 'claude-code',
    ...overrides,
  };
}

describe('SessionStatCard', () => {
  const defaultProps = {
    session: createSession(),
    isActive: false,
    onSelect: vi.fn(),
    onStop: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => cleanup());

  describe('Rendering', () => {
    it('renders session name', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ name: 'My Dev Session' })} />);
      expect(screen.getByText('My Dev Session')).toBeInTheDocument();
    });

    it('renders agent icon', () => {
      render(() => <SessionStatCard {...defaultProps} />);
      const card = screen.getByTestId('session-stat-card-test-1');
      expect(card.querySelector('.stat-card__icon')).toBeInTheDocument();
    });

    it('renders with correct data-testid', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ id: 'abc123' })} />);
      expect(screen.getByTestId('session-stat-card-abc123')).toBeInTheDocument();
    });
  });

  describe('Status indicators', () => {
    it('shows green pulsing dot for running sessions', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ status: 'running' })} />);
      const dot = screen.getByTestId('session-stat-card-test-1').querySelector('.session-stat-card__dot--success');
      expect(dot).toBeInTheDocument();
      expect(dot).toHaveClass('session-stat-card__dot--pulse');
    });

    it('shows grey static dot for stopped sessions', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ status: 'stopped' })} />);
      const dot = screen.getByTestId('session-stat-card-test-1').querySelector('.session-stat-card__dot--default');
      expect(dot).toBeInTheDocument();
      expect(dot).not.toHaveClass('session-stat-card__dot--pulse');
    });

    it('shows amber animated dot for initializing sessions', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ status: 'initializing' })} />);
      const dot = screen.getByTestId('session-stat-card-test-1').querySelector('.session-stat-card__dot--warning');
      expect(dot).toBeInTheDocument();
      expect(dot).toHaveClass('session-stat-card__dot--pulse');
    });

    it('shows red static dot for error sessions', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ status: 'error' })} />);
      const dot = screen.getByTestId('session-stat-card-test-1').querySelector('.session-stat-card__dot--error');
      expect(dot).toBeInTheDocument();
    });

    it('has left accent line colored by status', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ status: 'running' })} />);
      const card = screen.getByTestId('session-stat-card-test-1');
      expect(card).toHaveAttribute('data-status', 'running');
    });
  });

  describe('Metrics for running sessions', () => {
    it('displays CPU metric', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ id: 's1', status: 'running' })} />);
      expect(screen.getByTestId('session-stat-card-s1-metric-cpu')).toBeInTheDocument();
    });

    it('displays MEM metric', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ id: 's1', status: 'running' })} />);
      expect(screen.getByTestId('session-stat-card-s1-metric-mem')).toBeInTheDocument();
    });

    it('displays HDD metric', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ id: 's1', status: 'running' })} />);
      expect(screen.getByTestId('session-stat-card-s1-metric-hdd')).toBeInTheDocument();
    });

    it('does not display metrics for stopped sessions', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ id: 's1', status: 'stopped' })} />);
      expect(screen.queryByTestId('session-stat-card-s1-metric-cpu')).not.toBeInTheDocument();
    });
  });

  describe('Init progress for initializing sessions', () => {
    it('shows progress bar for initializing sessions', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ id: 's1', status: 'initializing' })} />);
      expect(screen.getByTestId('session-stat-card-s1-progress')).toBeInTheDocument();
    });

    it('does not show progress bar for running sessions', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ id: 's1', status: 'running' })} />);
      expect(screen.queryByTestId('session-stat-card-s1-progress')).not.toBeInTheDocument();
    });
  });

  describe('Active state', () => {
    it('applies active class when isActive is true', () => {
      render(() => <SessionStatCard {...defaultProps} isActive={true} />);
      const card = screen.getByTestId('session-stat-card-test-1');
      expect(card).toHaveClass('session-stat-card--active');
    });
  });

  describe('Click behavior', () => {
    it('calls onSelect when card is clicked', () => {
      const onSelect = vi.fn();
      render(() => <SessionStatCard {...defaultProps} onSelect={onSelect} />);
      fireEvent.click(screen.getByTestId('session-stat-card-test-1'));
      expect(onSelect).toHaveBeenCalled();
    });
  });

  describe('Kebab menu trigger', () => {
    it('calls onMenuClick with event and session when kebab button is clicked', () => {
      const onMenuClick = vi.fn();
      render(() => <SessionStatCard {...defaultProps} onMenuClick={onMenuClick} />);
      const menuBtn = screen.getByTitle('Session actions');
      fireEvent.click(menuBtn);
      expect(onMenuClick).toHaveBeenCalledWith(expect.any(MouseEvent), defaultProps.session);
    });

    it('does not call onSelect when kebab button is clicked (stopPropagation)', () => {
      const onSelect = vi.fn();
      const onMenuClick = vi.fn();
      render(() => <SessionStatCard {...defaultProps} onSelect={onSelect} onMenuClick={onMenuClick} />);
      const menuBtn = screen.getByTitle('Session actions');
      fireEvent.click(menuBtn);
      expect(onMenuClick).toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});
