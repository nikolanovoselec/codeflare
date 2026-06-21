import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import SessionSwitcher from '../../components/SessionSwitcher';
import type { SessionWithStatus } from '../../types';
import { terminalWorkspaceStore } from '../../stores/terminal-workspace';

// Mock responsive viewport state
const viewportMock = vi.hoisted(() => ({
  isMobile: false,
  setViewport: undefined as undefined | ((viewport: 'mobile' | 'tablet' | 'desktop') => void),
}));
vi.mock('../../lib/mobile', async () => {
  const { createSignal } = await vi.importActual<typeof import('solid-js')>('solid-js');
  const [viewport, setViewport] = createSignal<'mobile' | 'tablet' | 'desktop'>('desktop');
  viewportMock.setViewport = (next) => {
    viewportMock.isMobile = next === 'mobile';
    setViewport(next);
  };
  return {
    isMobile: () => viewportMock.isMobile,
    getTerminalViewportClass: viewport,
    createTerminalViewportClass: () => viewport,
  };
});

const dropdownProps = vi.hoisted(() => ({ latest: null as any }));

// Mock SessionDropdown
vi.mock('../../components/SessionDropdown', () => ({
  default: (props: any) => {
    dropdownProps.latest = props;
    return <div data-testid="session-dropdown" data-open={String(props.isOpen)} />;
  },
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

vi.mock('../../stores/terminal-workspace', () => ({
  terminalWorkspaceStore: {
    getActiveWorkspace: vi.fn(() => ({ kind: 'dashboard' })),
    reconcileMultiView: vi.fn(() => null),
    getMultiView: vi.fn(() => null),
    getMultiViewCapacity: vi.fn((viewport: string) => viewport === 'mobile' ? 0 : 4),
    createOrUpdateMultiView: vi.fn(() => false),
    openMultiView: vi.fn(() => false),
    closeMultiView: vi.fn(),
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

// REQ-TERM-018: MultiView Reopen and Close
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
    viewportMock.setViewport?.('desktop');
    dropdownProps.latest = null;
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
      viewportMock.setViewport?.('mobile');
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

  describe('MultiView launch', () => {
    it('REQ-TERM-013: creates MultiView from selected session ids and delegates opening to Layout', () => {
      const onOpenMultiView = vi.fn();
      vi.mocked(terminalWorkspaceStore.createOrUpdateMultiView).mockReturnValue(true);
      vi.mocked(terminalWorkspaceStore.openMultiView).mockReturnValue(true);

      render(() => (
        <SessionSwitcher
          {...defaultProps}
          sessions={[
            createSession({ id: 's1', status: 'running' }),
            createSession({ id: 's2', status: 'running' }),
          ]}
          onOpenMultiView={onOpenMultiView}
        />
      ));

      dropdownProps.latest.multiView.onLaunch(['s1', 's2']);

      expect(terminalWorkspaceStore.createOrUpdateMultiView).toHaveBeenCalledWith(['s1', 's2'], expect.any(Array), 'desktop');
      expect(terminalWorkspaceStore.openMultiView).not.toHaveBeenCalled();
      expect(onOpenMultiView).toHaveBeenCalled();
    });

    it('REQ-TERM-013: delegates existing MultiView open and close to Layout callbacks', () => {
      const onOpenMultiView = vi.fn();
      const onCloseMultiView = vi.fn();
      vi.mocked(terminalWorkspaceStore.reconcileMultiView).mockReturnValue({
        id: 'multiview:1',
        name: 'MultiView #1',
        memberSessionIds: ['s1', 's2'],
        focusedSessionId: 's1',
        layout: '2-split',
      } as any);

      render(() => (
        <SessionSwitcher
          {...defaultProps}
          sessions={[
            createSession({ id: 's1', status: 'running' }),
            createSession({ id: 's2', status: 'running' }),
          ]}
          onOpenMultiView={onOpenMultiView}
          onCloseMultiView={onCloseMultiView}
        />
      ));

      dropdownProps.latest.multiView.onOpen();
      dropdownProps.latest.multiView.onClose();

      expect(terminalWorkspaceStore.openMultiView).not.toHaveBeenCalled();
      expect(onOpenMultiView).toHaveBeenCalledTimes(1);
      expect(onCloseMultiView).toHaveBeenCalledTimes(1);
    });

    it('REQ-TERM-013: updates MultiView capacity and reconciliation when viewport changes', async () => {
      render(() => (
        <SessionSwitcher
          {...defaultProps}
          sessions={[
            createSession({ id: 's1', status: 'running' }),
            createSession({ id: 's2', status: 'running' }),
          ]}
        />
      ));

      vi.mocked(terminalWorkspaceStore.reconcileMultiView).mockClear();
      vi.mocked(terminalWorkspaceStore.getMultiViewCapacity).mockClear();

      viewportMock.setViewport?.('mobile');

      await waitFor(() => {
        expect(terminalWorkspaceStore.reconcileMultiView).toHaveBeenCalledWith(expect.any(Array), 'mobile');
        expect(terminalWorkspaceStore.getMultiViewCapacity).toHaveBeenCalledWith('mobile');
        expect(dropdownProps.latest.multiView.capacity).toBe(0);
      });
    });
  });
});
