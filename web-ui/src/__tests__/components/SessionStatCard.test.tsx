import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import SessionStatCard from '../../components/SessionStatCard';
import { sessionStore } from '../../stores/session';
import type { SessionWithStatus } from '../../types';
import { terminalStore } from '../../stores/terminal';

// Mock stores
vi.mock('../../stores/session', () => {
  let _preseedUpgrading = false;
  return {
    sessionStore: {
      getMetricsForSession: vi.fn(() => ({
        bucketName: 'codeflare-test',
        cpu: '15%',
        mem: '1.2/3.0G',
        hdd: '2.1G/10G',
      })),
      getInitProgressForSession: vi.fn(() => ({ progress: 50 })),
      preferences: { sleepAfter: '30m' },
      get preseedUpgrading() { return _preseedUpgrading; },
      _setPreseedUpgrading: (v: boolean) => { _preseedUpgrading = v; },
    },
  };
});

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

  // REQ-TERM-011: the session status dot reflects WS connection health — green when
  // running and connected, yellow when running but the WebSocket is disconnected.
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

    it('shows yellow warning dot when running but WS disconnected', () => {
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('disconnected');
      render(() => <SessionStatCard {...defaultProps} session={createSession({ status: 'running' })} />);
      const dot = screen.getByTestId('session-stat-card-test-1').querySelector('.session-stat-card__dot--warning');
      expect(dot).toBeInTheDocument();
    });

    it('shows green dot when running and WS connected', () => {
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('connected');
      render(() => <SessionStatCard {...defaultProps} session={createSession({ status: 'running' })} />);
      const dot = screen.getByTestId('session-stat-card-test-1').querySelector('.session-stat-card__dot--success');
      expect(dot).toBeInTheDocument();
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

    it('displays last-known metrics for stopped sessions when data exists', () => {
      render(() => <SessionStatCard {...defaultProps} session={createSession({ id: 's1', status: 'stopped' })} />);
      expect(screen.getByTestId('session-stat-card-s1-metric-cpu')).toBeInTheDocument();
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

  describe('Sleep timer icon', () => {
    it('shows warning timer when remaining < 10 min', () => {
      const session = createSession({
        status: 'running',
        lastActiveAt: new Date(Date.now() - 22 * 60_000).toISOString(),
      });
      render(() => <SessionStatCard {...defaultProps} session={session} />);
      expect(screen.getByTestId('session-stat-card-test-1-timer')).toBeInTheDocument();
      expect(screen.getByTestId('session-stat-card-test-1-timer')).toHaveClass('session-stat-card__timer--warning');
    });

    it('shows critical timer when remaining < 5 min', () => {
      const session = createSession({
        status: 'running',
        lastActiveAt: new Date(Date.now() - 27 * 60_000).toISOString(),
      });
      render(() => <SessionStatCard {...defaultProps} session={session} />);
      expect(screen.getByTestId('session-stat-card-test-1-timer')).toHaveClass('session-stat-card__timer--critical');
    });

    it('hides timer when remaining >= 10 min', () => {
      const session = createSession({
        status: 'running',
        lastActiveAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
      render(() => <SessionStatCard {...defaultProps} session={session} />);
      expect(screen.queryByTestId('session-stat-card-test-1-timer')).not.toBeInTheDocument();
    });

    it('hides timer for stopped sessions', () => {
      const session = createSession({
        status: 'stopped',
        lastActiveAt: new Date(Date.now() - 28 * 60_000).toISOString(),
      });
      render(() => <SessionStatCard {...defaultProps} session={session} />);
      expect(screen.queryByTestId('session-stat-card-test-1-timer')).not.toBeInTheDocument();
    });

    it('shows tooltip on click', () => {
      const session = createSession({
        status: 'running',
        lastActiveAt: new Date(Date.now() - 26 * 60_000).toISOString(),
      });
      render(() => <SessionStatCard {...defaultProps} session={session} />);
      fireEvent.click(screen.getByTestId('session-stat-card-test-1-timer'));
      expect(screen.getByText(/remaining.*idle timeout/i)).toBeInTheDocument();
    });

    it('does not trigger onSelect when timer icon is clicked', () => {
      const onSelect = vi.fn();
      const session = createSession({
        status: 'running',
        lastActiveAt: new Date(Date.now() - 26 * 60_000).toISOString(),
      });
      render(() => <SessionStatCard {...defaultProps} session={session} onSelect={onSelect} />);
      fireEvent.click(screen.getByTestId('session-stat-card-test-1-timer'));
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe('REQ-AGENT-049 AC6: stopped card dimmed during preseed upgrade', () => {
    afterEach(() => {
      (sessionStore as any)._setPreseedUpgrading(false);
    });

    it('applies reduced opacity and blocks clicks on stopped card during upgrade', () => {
      (sessionStore as any)._setPreseedUpgrading(true);
      const onSelect = vi.fn();
      render(() => <SessionStatCard {...defaultProps} session={createSession({ status: 'stopped' })} onSelect={onSelect} />);
      const card = screen.getByTestId('session-stat-card-test-1');
      expect(card.style.opacity).toBe('0.6');
      expect(card.style.pointerEvents).toBe('none');
      fireEvent.click(card);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not dim running card during upgrade', () => {
      (sessionStore as any)._setPreseedUpgrading(true);
      render(() => <SessionStatCard {...defaultProps} session={createSession({ status: 'running' })} />);
      const card = screen.getByTestId('session-stat-card-test-1');
      expect(card.style.opacity).not.toBe('0.6');
    });

    it('does not dim stopped card when upgrade is not running', () => {
      (sessionStore as any)._setPreseedUpgrading(false);
      render(() => <SessionStatCard {...defaultProps} session={createSession({ status: 'stopped' })} />);
      const card = screen.getByTestId('session-stat-card-test-1');
      expect(card.style.opacity).not.toBe('0.6');
    });
  });
});
