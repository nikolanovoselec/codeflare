import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import SessionCard from '../../components/SessionCard';
import type { SessionWithStatus } from '../../types';

// Mock stores
vi.mock('../../stores/session', () => ({
  sessionStore: {
    getInitProgressForSession: vi.fn(() => ({ progress: 50 })),
    getMetricsForSession: vi.fn(() => ({
      bucketName: 'codeflare-test',
      cpu: '15%',
      mem: '1.2/3.0G',
      hdd: '2.1G/10G',
    })),
    renameSession: vi.fn(),
    hasRecentContext: vi.fn(() => false),
  },
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    getConnectionState: vi.fn(() => 'connected'),
  },
  sendInputToTerminal: vi.fn(() => false),
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

describe('SessionCard', () => {
  const defaultProps = {
    index: () => 0,
    isActive: false,
    onSelect: vi.fn(),
    onStop: vi.fn(),
    onDelete: vi.fn(),
    onReconnect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock window.confirm for delete tests
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('renders session name', () => {
      const session = createSession({ name: 'My Dev Session' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.getByText('My Dev Session')).toBeInTheDocument();
    });

    it('renders status label for running sessions', () => {
      const session = createSession({ status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.getByText('Live')).toBeInTheDocument();
    });

    it('renders status label for stopped sessions', () => {
      const session = createSession({ status: 'stopped' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.getByText('Stopped')).toBeInTheDocument();
    });

    it('renders status label for initializing sessions', () => {
      const session = createSession({ status: 'initializing' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.getByText('Starting')).toBeInTheDocument();
    });

    it('renders with correct data-testid', () => {
      const session = createSession({ id: 'abc123' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.getByTestId('session-card-abc123')).toBeInTheDocument();
    });
  });

  describe('Metrics for running sessions', () => {
    it('displays CPU metric', () => {
      const session = createSession({ id: 's1', status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      const cpu = screen.getByTestId('session-card-s1-metric-cpu');
      expect(cpu).toBeInTheDocument();
      expect(cpu.querySelector('.stat-card__metric-label')?.textContent?.trim()).toContain('CPU');
    });

    it('displays MEM metric', () => {
      const session = createSession({ id: 's1', status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      const mem = screen.getByTestId('session-card-s1-metric-mem');
      expect(mem).toBeInTheDocument();
      expect(mem.querySelector('.stat-card__metric-label')?.textContent?.trim()).toContain('MEM');
    });

    it('displays HDD metric', () => {
      const session = createSession({ id: 's1', status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      const hdd = screen.getByTestId('session-card-s1-metric-hdd');
      expect(hdd).toBeInTheDocument();
      expect(hdd.querySelector('.stat-card__metric-label')?.textContent?.trim()).toContain('HDD');
    });

    it('displays R2 Bucket name', () => {
      const session = createSession({ id: 's1', status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      const bucket = screen.getByTestId('session-card-s1-metric-bucket');
      expect(bucket.querySelector('.stat-card__metric-value')?.textContent).toBe('codeflare-test');
    });

    it('displays Uptime metric', () => {
      const session = createSession({ id: 's1', status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      const uptime = screen.getByTestId('session-card-s1-metric-uptime');
      expect(uptime).toBeInTheDocument();
      expect(uptime.querySelector('.stat-card__metric-label')?.textContent?.trim()).toContain('Uptime');
    });

    it('does not display sync metric', () => {
      const session = createSession({ id: 's1', status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.queryByTestId('session-card-s1-metric-sync')).not.toBeInTheDocument();
    });

    it('does not display terminals metric', () => {
      const session = createSession({ id: 's1', status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.queryByTestId('session-card-s1-metric-terminals')).not.toBeInTheDocument();
    });

    it('shows exactly 5 metrics for running sessions', () => {
      const session = createSession({ id: 's1', status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      const metricsSection = screen.getByTestId('session-metrics');
      const metrics = metricsSection.querySelectorAll('.session-card-metric');
      expect(metrics.length).toBe(5);
    });

    it('does not display metrics for stopped sessions', () => {
      const session = createSession({ id: 's1', status: 'stopped' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.queryByTestId('session-card-s1-metric-cpu')).not.toBeInTheDocument();
      expect(screen.queryByTestId('session-metrics')).not.toBeInTheDocument();
    });
  });

  describe('Progress bar', () => {
    it('shows progress bar for initializing sessions', () => {
      const session = createSession({ id: 's1', status: 'initializing' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.getByTestId('session-card-s1-progress')).toBeInTheDocument();
    });

    it('does not show progress bar for running sessions', () => {
      const session = createSession({ id: 's1', status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.queryByTestId('session-card-s1-progress')).not.toBeInTheDocument();
    });
  });

  describe('Action buttons', () => {
    it('shows stop button for running sessions', () => {
      const session = createSession({ status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.getByTitle('Stop session')).toBeInTheDocument();
    });

    it('shows stop button for initializing sessions', () => {
      const session = createSession({ status: 'initializing' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.getByTitle('Stop session')).toBeInTheDocument();
    });

    it('does not show stop button for stopped sessions', () => {
      const session = createSession({ status: 'stopped' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.queryByTitle('Stop session')).not.toBeInTheDocument();
    });

    it('shows delete button for all statuses', () => {
      const statuses: Array<'stopped' | 'running' | 'initializing' | 'error'> = ['stopped', 'running', 'initializing', 'error'];
      statuses.forEach(status => {
        cleanup();
        const session = createSession({ status });
        render(() => <SessionCard {...defaultProps} session={session} />);
        expect(screen.getByTitle('Delete session')).toBeInTheDocument();
      });
    });
  });

  describe('Click handlers', () => {
    it('calls onSelect when card is clicked', () => {
      const onSelect = vi.fn();
      const session = createSession();
      render(() => <SessionCard {...defaultProps} session={session} onSelect={onSelect} />);

      const card = screen.getByTestId('session-card-test-1').querySelector('.session-card') as HTMLElement;
      fireEvent.click(card);

      expect(onSelect).toHaveBeenCalled();
    });

    it('calls onStop when stop button is clicked', () => {
      const onStop = vi.fn();
      const session = createSession({ status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} onStop={onStop} />);

      fireEvent.click(screen.getByTitle('Stop session'));

      expect(onStop).toHaveBeenCalled();
    });

    it('calls onDelete when delete button is clicked and confirmed', () => {
      const onDelete = vi.fn();
      const session = createSession();
      render(() => <SessionCard {...defaultProps} session={session} onDelete={onDelete} />);

      fireEvent.click(screen.getByTitle('Delete session'));

      expect(onDelete).toHaveBeenCalled();
    });

    it('does not call onDelete when confirm is cancelled', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const onDelete = vi.fn();
      const session = createSession();
      render(() => <SessionCard {...defaultProps} session={session} onDelete={onDelete} />);

      fireEvent.click(screen.getByTitle('Delete session'));

      expect(onDelete).not.toHaveBeenCalled();
    });
  });

  describe('Active and visual state', () => {
    it('applies active class when isActive is true', () => {
      const session = createSession();
      render(() => <SessionCard {...defaultProps} session={session} isActive={true} />);

      const card = screen.getByTestId('session-card-test-1').querySelector('.session-card');
      expect(card).toHaveClass('session-card--active');
    });

    it('applies glow class for active running sessions', () => {
      const session = createSession({ status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} isActive={true} />);

      const card = screen.getByTestId('session-card-test-1').querySelector('.session-card');
      expect(card).toHaveClass('session-card-glow');
    });

    it('applies shimmer class on status badge for running sessions', () => {
      const session = createSession({ status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);

      const badge = screen.getByTestId('session-card-test-1').querySelector('.session-status-badge');
      expect(badge).toHaveClass('session-badge-shimmer');
    });

    it('has status dot for running sessions', () => {
      const session = createSession({ status: 'running' });
      render(() => <SessionCard {...defaultProps} session={session} />);

      const dot = screen.getByTestId('session-card-test-1').querySelector('.session-status-dot');
      expect(dot).toBeInTheDocument();
    });
  });

  describe('Stopping status', () => {
    it('renders "Syncing" label when status is stopping', () => {
      const session = createSession({ status: 'stopping' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      const badge = screen.getByTestId('session-status-badge');
      expect(badge).toHaveTextContent('Syncing');
    });

    it('shows pulsing indicator for stopping status', () => {
      const session = createSession({ status: 'stopping' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      const badge = screen.getByTestId('session-status-badge');
      expect(badge.classList.contains('animate-pulse')).toBe(true);
    });

    it('hides stop button when status is stopping', () => {
      const session = createSession({ status: 'stopping' });
      render(() => <SessionCard {...defaultProps} session={session} />);
      expect(screen.queryByTitle('Stop session')).not.toBeInTheDocument();
    });
  });

  describe('Actions overlay structure', () => {
    it('renders actions overlay as sibling of card', () => {
      const session = createSession();
      render(() => <SessionCard {...defaultProps} session={session} />);

      const wrapper = screen.getByTestId('session-card-test-1');
      const card = wrapper.querySelector('.session-card');
      const overlay = wrapper.querySelector('.session-card-actions-overlay');

      expect(card).toBeInTheDocument();
      expect(overlay).toBeInTheDocument();
      // Overlay is sibling, not child of card
      expect(card?.contains(overlay)).toBe(false);
    });
  });
});
