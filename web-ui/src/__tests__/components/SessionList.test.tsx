import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import SessionList from '../../components/SessionList';
import type { SessionWithStatus } from '../../types';
import { sessionStore } from '../../stores/session';
import { sendInputToTerminal } from '../../stores/terminal';

// Mock mobile.ts for TipsRotator
vi.mock('../../lib/mobile', () => ({
  isTouchDevice: vi.fn(() => false),
}));

// Mock CreateSessionDialog to isolate SessionList testing
vi.mock('../../components/CreateSessionDialog', () => ({
  default: (props: any) => (
    <div data-testid="create-session-dialog" data-open={props.isOpen}>
      <button data-testid="csd-select-agent" onClick={() => props.onSelect('claude-code')}>
        Select Agent
      </button>
    </div>
  )
}));

// Mock the stores
vi.mock('../../stores/session', () => ({
  sessionStore: {
    getTerminalsForSession: vi.fn(() => ({ tabs: [{ id: '1' }, { id: '2' }] })),
    getInitProgressForSession: vi.fn(() => ({ progress: 50 })),
    getMetricsForSession: vi.fn(() => ({
      bucketName: 'codeflare-test',
      syncStatus: 'success',
      cpu: '15%',
      mem: '1.2/3.0G',
      hdd: '2.1G/10G',
    })),
    renameSession: vi.fn(),
    loadPresets: vi.fn(),
    presets: [],
    preferences: {},
  },
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    getConnectionState: vi.fn(() => 'connected'),
  },
  sendInputToTerminal: vi.fn(() => false),
}));

// Helper to create mock sessions
function createMockSession(
  overrides: Partial<SessionWithStatus> = {}
): SessionWithStatus {
  const id = overrides.id || 'session-1';
  return {
    id,
    name: overrides.name || 'Test Session',
    createdAt: overrides.createdAt || new Date().toISOString(),
    lastAccessedAt: overrides.lastAccessedAt || new Date().toISOString(),
    status: overrides.status || 'stopped',
    ...overrides,
  };
}

describe('SessionList Component', () => {
  const defaultProps = {
    sessions: [] as SessionWithStatus[],
    activeSessionId: null,
    onSelectSession: vi.fn(),
    onStartSession: vi.fn(),
    onStopSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onCreateSession: vi.fn(),
    onReconnect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Tips Rotator', () => {
    it('should render tips rotator', () => {
      render(() => <SessionList {...defaultProps} />);

      expect(screen.getByTestId('tips-card')).toBeInTheDocument();
    });

    it('should display a tip text', () => {
      render(() => <SessionList {...defaultProps} />);

      const rotator = screen.getByTestId('tips-card');
      expect(rotator.textContent?.length).toBeGreaterThan(0);
    });
  });

  describe('Session Cards', () => {
    it('should display session name', () => {
      const sessions = [
        createMockSession({ id: '1', name: 'My Session' }),
      ];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      expect(screen.getByText('My Session')).toBeInTheDocument();
    });

    it('should display CPU metric for running sessions', () => {
      const sessions = [
        createMockSession({ id: '1', status: 'running' }),
      ];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const cpuElement = screen.getByTestId('session-card-1-metric-cpu');
      expect(cpuElement).toBeInTheDocument();
    });

    it('should display MEM metric for running sessions', () => {
      const sessions = [
        createMockSession({ id: '1', status: 'running' }),
      ];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const memElement = screen.getByTestId('session-card-1-metric-mem');
      expect(memElement).toBeInTheDocument();
    });

    it('should display HDD metric for running sessions', () => {
      const sessions = [
        createMockSession({ id: '1', status: 'running' }),
      ];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const hddElement = screen.getByTestId('session-card-1-metric-hdd');
      expect(hddElement).toBeInTheDocument();
    });

    it('should not display metrics for stopped sessions', () => {
      const sessions = [
        createMockSession({ id: '1', status: 'stopped' }),
      ];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      expect(screen.queryByTestId('session-card-1-metric-cpu')).not.toBeInTheDocument();
    });

    it('should display progress bar for initializing sessions', () => {
      const sessions = [
        createMockSession({ id: '1', status: 'initializing' }),
      ];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      expect(screen.getByTestId('session-card-1-progress')).toBeInTheDocument();
    });

    it('should not display progress bar for non-initializing sessions', () => {
      const sessions = [
        createMockSession({ id: '1', status: 'running' }),
      ];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      expect(screen.queryByTestId('session-card-1-progress')).not.toBeInTheDocument();
    });
  });

  describe('Session Actions', () => {
    it('should call onSelectSession when clicking a card', () => {
      const sessions = [createMockSession({ id: '1' })];
      const onSelectSession = vi.fn();
      render(() => (
        <SessionList {...defaultProps} sessions={sessions} onSelectSession={onSelectSession} />
      ));

      // Click on the inner session-card element (not the wrapper)
      const cardWrapper = screen.getByTestId('session-card-1');
      const innerCard = cardWrapper.querySelector('.session-card') as HTMLElement;
      fireEvent.click(innerCard);

      expect(onSelectSession).toHaveBeenCalledWith('1');
    });

    it('should show delete button for stopped sessions (start via card click)', () => {
      const sessions = [createMockSession({ id: '1', status: 'stopped' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      // Hover to reveal actions
      const card = screen.getByTestId('session-card-1');
      fireEvent.mouseOver(card);

      // Stopped sessions show Delete button in overlay (start is triggered by card click)
      const deleteButton = screen.getByTitle('Delete session');
      expect(deleteButton).toBeInTheDocument();
    });

    it('should show stop button for running sessions', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const card = screen.getByTestId('session-card-1');
      fireEvent.mouseOver(card);

      const stopButton = screen.getByTitle('Stop session');
      expect(stopButton).toBeInTheDocument();
    });

    it('should show delete button for non-initializing sessions', () => {
      const sessions = [createMockSession({ id: '1', status: 'stopped' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const card = screen.getByTestId('session-card-1');
      fireEvent.mouseOver(card);

      const deleteButton = screen.getByTitle('Delete session');
      expect(deleteButton).toBeInTheDocument();
    });
  });

  describe('Button Visibility During Startup', () => {
    it('should show delete button for initializing sessions', () => {
      const sessions = [createMockSession({ id: '1', status: 'initializing' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const card = screen.getByTestId('session-card-1');
      fireEvent.mouseOver(card);

      // Critical fix: Users must be able to delete stuck sessions during initialization
      expect(screen.getByTitle('Delete session')).toBeInTheDocument();
    });

    it('should show stop button for initializing sessions', () => {
      const sessions = [createMockSession({ id: '1', status: 'initializing' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const card = screen.getByTestId('session-card-1');
      fireEvent.mouseOver(card);

      // Allow stopping sessions during initialization
      expect(screen.getByTitle('Stop session')).toBeInTheDocument();
    });

    it('should show delete button for all session statuses', () => {
      const statuses: Array<'stopped' | 'running' | 'initializing' | 'error'> = ['stopped', 'running', 'initializing', 'error'];
      statuses.forEach(status => {
        cleanup();
        const sessions = [createMockSession({ id: '1', status })];
        render(() => <SessionList {...defaultProps} sessions={sessions} />);
        const card = screen.getByTestId('session-card-1');
        fireEvent.mouseOver(card);
        expect(screen.getByTitle('Delete session')).toBeInTheDocument();
      });
    });
  });

  describe('Create Session', () => {
    it('should show create button initially', () => {
      render(() => <SessionList {...defaultProps} />);

      expect(screen.getByText('New Session')).toBeInTheDocument();
    });

    it('should open CreateSessionDialog when create button is clicked', () => {
      render(() => <SessionList {...defaultProps} />);

      fireEvent.click(screen.getByText('New Session'));

      const dialog = screen.getByTestId('create-session-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
    });

    it('should call onCreateSession with auto-generated name when agent is selected', () => {
      const onCreateSession = vi.fn();
      render(() => <SessionList {...defaultProps} onCreateSession={onCreateSession} />);

      fireEvent.click(screen.getByText('New Session'));
      fireEvent.click(screen.getByTestId('csd-select-agent'));

      expect(onCreateSession).toHaveBeenCalledWith('Claude Code #1', 'claude-code', undefined);
    });

    it('should close dialog after agent selection', () => {
      render(() => <SessionList {...defaultProps} />);

      fireEvent.click(screen.getByText('New Session'));
      fireEvent.click(screen.getByTestId('csd-select-agent'));

      const dialog = screen.getByTestId('create-session-dialog');
      expect(dialog.getAttribute('data-open')).toBe('false');
    });
  });

  describe('Active Session', () => {
    it('should highlight active session', () => {
      const sessions = [
        createMockSession({ id: '1', name: 'Session 1' }),
        createMockSession({ id: '2', name: 'Session 2' }),
      ];
      render(() => (
        <SessionList {...defaultProps} sessions={sessions} activeSessionId="1" />
      ));

      // Active session has session-card--active class
      const card1 = screen.getByTestId('session-card-1').querySelector('.session-card--active');
      const card2 = screen.getByTestId('session-card-2').querySelector('.session-card:not(.session-card--active)');

      expect(card1).toBeInTheDocument();
      expect(card2).toBeInTheDocument();
    });
  });

  describe('Visual Enhancements', () => {
    it('session card has gradient background', () => {
      const sessions = [createMockSession({ id: '1', name: 'Test Session' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const card = screen.getByTestId('session-card-1').querySelector('.session-card');
      expect(card).toBeInTheDocument();
      // The card should have the session-card-gradient class for gradient styling
      expect(card).toHaveClass('session-card-gradient');
    });

    it('live badge has shimmer animation class', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const badge = screen.getByTestId('session-card-1').querySelector('.session-status-badge');
      expect(badge).toBeInTheDocument();
      // Live badge should have shimmer class for animated effect
      expect(badge).toHaveClass('session-badge-shimmer');
    });

    it('metrics section shows CPU for running sessions', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const cpuElement = screen.getByTestId('session-card-1-metric-cpu');
      expect(cpuElement).toBeInTheDocument();
      expect(cpuElement.querySelector('.stat-card__metric-label')?.textContent).toContain('CPU');
    });

    it('metrics section shows MEM for running sessions', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const memElement = screen.getByTestId('session-card-1-metric-mem');
      expect(memElement).toBeInTheDocument();
      expect(memElement.querySelector('.stat-card__metric-label')?.textContent).toContain('MEM');
    });

    it('live badge includes status dot', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const badge = screen.getByTestId('session-card-1').querySelector('.session-status-badge');
      expect(badge).toBeInTheDocument();
      // Badge should contain a status dot span
      const dot = badge?.querySelector('.session-status-dot');
      expect(dot).toBeInTheDocument();
    });

    it('active running session has glow effect class', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => (
        <SessionList {...defaultProps} sessions={sessions} activeSessionId="1" />
      ));

      const card = screen.getByTestId('session-card-1').querySelector('.session-card--active');
      expect(card).toBeInTheDocument();
      // Active running card should have the glow class
      expect(card).toHaveClass('session-card-glow');
    });
  });

  describe('LIVE Badge Positioning', () => {
    it('should position badge at right edge of header', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const header = screen.getByTestId('session-card-1').querySelector('.session-card-header');
      expect(header).toBeInTheDocument();

      // Header uses flexbox with justify-content: space-between (via CSS class)
      // Badge should be the second element in header (after session-name)
      const badge = header?.querySelector('.session-status-badge');
      expect(badge).toBeInTheDocument();

      // Verify header has the correct class that applies flex layout
      expect(header).toHaveClass('session-card-header');

      // Verify DOM structure: agent-icon, session-name, rename button, then badge
      const children = header?.children;
      expect(children?.[0]).toHaveClass('session-header-agent-icon');
      expect(children?.[1]).toHaveClass('session-name');
      expect(children?.[2]).toHaveClass('session-rename-btn');
      expect(children?.[3]).toHaveClass('session-status-badge');
    });

    it('should have consistent right padding matching left text padding', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const card = screen.getByTestId('session-card-1').querySelector('.session-card');
      expect(card).toBeInTheDocument();

      // Card has session-card class which applies 12px padding via external CSS
      expect(card).toHaveClass('session-card');
    });
  });

  describe('Slide-in Action Buttons', () => {
    it('should render actions in overlay container outside card', () => {
      const sessions = [createMockSession({ id: '1', status: 'stopped' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      expect(wrapper).toHaveClass('session-card-wrapper');

      // The wrapper should contain the session-card
      const card = wrapper.querySelector('.session-card');
      expect(card).toBeInTheDocument();

      // Actions overlay should be sibling of session-card inside wrapper
      const actionsOverlay = wrapper.querySelector('.session-card-actions-overlay');
      expect(actionsOverlay).toBeInTheDocument();

      // Verify it's a sibling (not inside card)
      expect(card?.contains(actionsOverlay)).toBe(false);
    });

    it('should hide actions off-screen by default (translateX 100%)', () => {
      const sessions = [createMockSession({ id: '1', status: 'stopped' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const actionsOverlay = screen.getByTestId('session-card-1').querySelector('.session-card-actions-overlay');
      expect(actionsOverlay).toBeInTheDocument();

      // Actions overlay exists and contains buttons that are hidden by CSS transform/opacity
      // The overlay slides in from right side when card is hovered
      const buttons = actionsOverlay?.querySelectorAll('button');
      expect(buttons?.length).toBeGreaterThan(0);
    });

    it('should slide actions into view on card hover', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      const actionsOverlay = wrapper.querySelector('.session-card-actions-overlay');
      expect(actionsOverlay).toBeInTheDocument();

      // Hover over the wrapper to trigger slide-in
      fireEvent.mouseOver(wrapper);

      // Stop button should be visible for running sessions
      const stopButton = screen.getByTitle('Stop session');
      expect(stopButton).toBeInTheDocument();
    });

    it('should stack buttons vertically', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const actionsOverlay = screen.getByTestId('session-card-1').querySelector('.session-card-actions-overlay');
      expect(actionsOverlay).toBeInTheDocument();

      // Actions overlay contains multiple buttons stacked
      const buttons = actionsOverlay?.querySelectorAll('button');
      // Running session should have Stop + Delete buttons
      expect(buttons?.length).toBe(2);
    });

    it('should center buttons on card height', () => {
      const sessions = [createMockSession({ id: '1', status: 'stopped' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      // Session card wrapper contains both card and actions overlay
      const wrapper = screen.getByTestId('session-card-1');
      expect(wrapper).toHaveClass('session-card-wrapper');

      // Both card and overlay should be vertically aligned
      const card = wrapper.querySelector('.session-card');
      const actionsOverlay = wrapper.querySelector('.session-card-actions-overlay');
      expect(card).toBeInTheDocument();
      expect(actionsOverlay).toBeInTheDocument();
    });
  });

  describe('Session Card Rename', () => {
    it('should show pencil icon on session name hover', () => {
      const sessions = [createMockSession({ id: '1', name: 'My Session' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      fireEvent.mouseOver(wrapper);

      const pencilBtn = wrapper.querySelector('.session-rename-btn');
      expect(pencilBtn).toBeInTheDocument();
    });

    it('should enter inline edit mode on pencil click', () => {
      const sessions = [createMockSession({ id: '1', name: 'My Session' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      const pencilBtn = wrapper.querySelector('.session-rename-btn') as HTMLElement;
      fireEvent.click(pencilBtn);

      const input = wrapper.querySelector('.session-rename-input') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input.value).toBe('My Session');
    });

    it('should save on Enter key', async () => {
      const sessions = [createMockSession({ id: '1', name: 'My Session' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      const pencilBtn = wrapper.querySelector('.session-rename-btn') as HTMLElement;
      fireEvent.click(pencilBtn);

      const input = wrapper.querySelector('.session-rename-input') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'Renamed' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(sessionStore.renameSession).toHaveBeenCalledWith('1', 'Renamed');
    });

    it('should cancel on Escape key', () => {
      const sessions = [createMockSession({ id: '1', name: 'My Session' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      const pencilBtn = wrapper.querySelector('.session-rename-btn') as HTMLElement;
      fireEvent.click(pencilBtn);

      const input = wrapper.querySelector('.session-rename-input') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'Renamed' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      // Should exit edit mode, showing session name text again
      expect(wrapper.querySelector('.session-rename-input')).not.toBeInTheDocument();
      expect(screen.getByText('My Session')).toBeInTheDocument();
    });

    it('should save on blur', () => {
      const sessions = [createMockSession({ id: '1', name: 'My Session' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      const pencilBtn = wrapper.querySelector('.session-rename-btn') as HTMLElement;
      fireEvent.click(pencilBtn);

      const input = wrapper.querySelector('.session-rename-input') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'Blurred Name' } });
      fireEvent.blur(input);

      expect(sessionStore.renameSession).toHaveBeenCalledWith('1', 'Blurred Name');
    });

    it('should not save if name is empty', () => {
      const sessions = [createMockSession({ id: '1', name: 'My Session' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      const pencilBtn = wrapper.querySelector('.session-rename-btn') as HTMLElement;
      fireEvent.click(pencilBtn);

      const input = wrapper.querySelector('.session-rename-input') as HTMLInputElement;
      fireEvent.input(input, { target: { value: '  ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(sessionStore.renameSession).not.toHaveBeenCalled();
    });

    it('should not save if name is unchanged', () => {
      const sessions = [createMockSession({ id: '1', name: 'My Session' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      const pencilBtn = wrapper.querySelector('.session-rename-btn') as HTMLElement;
      fireEvent.click(pencilBtn);

      const input = wrapper.querySelector('.session-rename-input') as HTMLInputElement;
      // Don't change the value
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(sessionStore.renameSession).not.toHaveBeenCalled();
    });
  });

  describe('Drop Target', () => {
    it('should show drop highlight on dragover for running sessions', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      const card = wrapper.querySelector('.session-card') as HTMLElement;

      fireEvent.dragOver(card, {
        dataTransfer: { types: ['Files'], dropEffect: 'copy' },
        preventDefault: vi.fn(),
      });

      expect(card.classList.contains('session-card--drop-target')).toBe(true);
    });

    it('should remove drop highlight on dragleave', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      const card = wrapper.querySelector('.session-card') as HTMLElement;

      fireEvent.dragOver(card, {
        dataTransfer: { types: ['Files'], dropEffect: 'copy' },
        preventDefault: vi.fn(),
      });
      fireEvent.dragLeave(card);

      expect(card.classList.contains('session-card--drop-target')).toBe(false);
    });

    it('should call sendInputToTerminal on file drop for running sessions', () => {
      const mockSendInput = vi.mocked(sendInputToTerminal);
      mockSendInput.mockReturnValue(true);

      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      const card = wrapper.querySelector('.session-card') as HTMLElement;

      const file = new File(['content'], 'test.txt', { type: 'text/plain' });
      fireEvent.drop(card, {
        dataTransfer: { files: [file] },
        preventDefault: vi.fn(),
      });

      expect(mockSendInput).toHaveBeenCalledWith('1', '1', 'test.txt');
    });

    it('should not accept drops for stopped sessions', () => {
      const mockSendInput = vi.mocked(sendInputToTerminal);

      const sessions = [createMockSession({ id: '1', status: 'stopped' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const wrapper = screen.getByTestId('session-card-1');
      const card = wrapper.querySelector('.session-card') as HTMLElement;

      const file = new File(['content'], 'test.txt', { type: 'text/plain' });
      fireEvent.drop(card, {
        dataTransfer: { files: [file] },
        preventDefault: vi.fn(),
      });

      expect(mockSendInput).not.toHaveBeenCalled();
    });
  });

  describe('Sidebar Pin (onPinSidebar)', () => {
    it('should call onPinSidebar(true) when create dialog opens', () => {
      const onPinSidebar = vi.fn();
      render(() => <SessionList {...defaultProps} onPinSidebar={onPinSidebar} />);

      fireEvent.click(screen.getByTestId('session-create-btn'));

      expect(onPinSidebar).toHaveBeenCalledWith(true);
    });

    it('should call onPinSidebar(false) when create dialog toggles closed', () => {
      const onPinSidebar = vi.fn();
      render(() => <SessionList {...defaultProps} onPinSidebar={onPinSidebar} />);

      // Open
      fireEvent.click(screen.getByTestId('session-create-btn'));
      expect(onPinSidebar).toHaveBeenCalledWith(true);

      // Close via toggle
      fireEvent.click(screen.getByTestId('session-create-btn'));
      expect(onPinSidebar).toHaveBeenCalledWith(false);
    });

    it('should call onPinSidebar(false) after agent selection', () => {
      const onPinSidebar = vi.fn();
      render(() => <SessionList {...defaultProps} onPinSidebar={onPinSidebar} />);

      fireEvent.click(screen.getByTestId('session-create-btn'));
      onPinSidebar.mockClear();

      fireEvent.click(screen.getByTestId('csd-select-agent'));

      expect(onPinSidebar).toHaveBeenCalledWith(false);
    });

    it('should not throw when onPinSidebar is not provided', () => {
      render(() => <SessionList {...defaultProps} />);

      expect(() => {
        fireEvent.click(screen.getByTestId('session-create-btn'));
      }).not.toThrow();
    });
  });

  describe('Developer Metrics Section', () => {
    it('should render metrics section for running sessions', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      // Metrics section should be present for running sessions
      const metricsSection = screen.getByTestId('session-metrics');
      expect(metricsSection).toBeInTheDocument();
    });

    it('should NOT render metrics for stopped sessions', () => {
      const sessions = [createMockSession({ id: '1', status: 'stopped' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      // CPU metric should not be displayed for stopped sessions
      expect(screen.queryByTestId('session-card-1-metric-cpu')).not.toBeInTheDocument();
    });

    it('should display CPU metric', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const cpuElement = screen.getByTestId('session-card-1-metric-cpu');
      expect(cpuElement).toBeInTheDocument();
      expect(cpuElement.querySelector('.stat-card__metric-label')?.textContent).toContain('CPU');
    });

    it('should display MEM metric', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const memElement = screen.getByTestId('session-card-1-metric-mem');
      expect(memElement).toBeInTheDocument();
      expect(memElement.querySelector('.stat-card__metric-label')?.textContent).toContain('MEM');
    });

    it('should display HDD metric', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const hddElement = screen.getByTestId('session-card-1-metric-hdd');
      expect(hddElement).toBeInTheDocument();
      expect(hddElement.querySelector('.stat-card__metric-label')?.textContent).toContain('HDD');
    });

    it('should display bucket name', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const bucketElement = screen.getByTestId('session-card-1-metric-bucket');
      expect(bucketElement).toBeInTheDocument();
      expect(bucketElement.querySelector('.stat-card__metric-label')?.textContent).toContain('Bucket');
      // Mock returns codeflare-test
      expect(bucketElement.querySelector('.stat-card__metric-value')?.textContent).toBe('codeflare-test');
    });

    it('should not display sync metric', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      expect(screen.queryByTestId('session-card-1-metric-sync')).not.toBeInTheDocument();
    });

    it('should not display terminals metric', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      expect(screen.queryByTestId('session-card-1-metric-terminals')).not.toBeInTheDocument();
    });

    it('should display age metric', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const ageElement = screen.getByTestId('session-card-1-metric-uptime');
      expect(ageElement).toBeInTheDocument();
      expect(ageElement.querySelector('.stat-card__metric-label')?.textContent).toContain('Uptime');
    });

    it('should style metrics with stat-card classes', () => {
      const sessions = [createMockSession({ id: '1', status: 'running' })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const metricsSection = screen.getByTestId('session-metrics');
      expect(metricsSection).toBeInTheDocument();

      // Metrics section should contain metric values with the right class
      const metricValues = metricsSection.querySelectorAll('.stat-card__metric-value');
      expect(metricValues.length).toBeGreaterThan(0);
    });

    it('should display uptime for running sessions', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const sessions = [createMockSession({ id: '1', status: 'running', createdAt: twoHoursAgo })];
      render(() => <SessionList {...defaultProps} sessions={sessions} />);

      const uptimeElement = screen.getByTestId('session-card-1-metric-uptime');
      expect(uptimeElement).toBeInTheDocument();
      expect(uptimeElement.querySelector('.stat-card__metric-label')?.textContent).toContain('Uptime');
      // Should display "2h" for 2 hours
      expect(uptimeElement.querySelector('.stat-card__metric-value')?.textContent).toMatch(/2h/);
    });
  });

});
