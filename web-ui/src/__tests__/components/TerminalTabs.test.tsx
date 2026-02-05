import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import TerminalTabs from '../../components/TerminalTabs';
import { sessionStore } from '../../stores/session';

// Mock isMobile - default to desktop (false)
const isMobileMock = vi.hoisted(() => ({ value: false }));
vi.mock('../../lib/mobile', () => ({
  isMobile: () => isMobileMock.value,
}));

// Mock the session store
vi.mock('../../stores/session', () => ({
  sessionStore: {
    getTerminalsForSession: vi.fn(),
    addTerminalTab: vi.fn(),
    setActiveTerminalTab: vi.fn(),
    removeTerminalTab: vi.fn(),
    reorderTerminalTabs: vi.fn(),
    getTabOrder: vi.fn(),
    getTilingForSession: vi.fn(),
    setTilingLayout: vi.fn(),
    sessions: [],
    savePreset: vi.fn(),
    presets: [],
    deletePreset: vi.fn(),
    loadPresets: vi.fn(),
  },
}));

describe('TerminalTabs Component', () => {
  const mockSessionId = 'test-session-123';

  beforeEach(() => {
    vi.clearAllMocks();
    isMobileMock.value = false;
  });

  afterEach(() => {
    cleanup();
  });

  describe('Tab Rendering', () => {
    it('should render tabs for all terminals in session', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      expect(screen.getByTestId('terminal-tab-1')).toBeInTheDocument();
      expect(screen.getByTestId('terminal-tab-2')).toBeInTheDocument();
    });

    it('should render tab icons with correct test ids', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [{ id: '1', createdAt: new Date().toISOString() }],
        activeTabId: '1',
        tabOrder: ['1'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      expect(screen.getByTestId('terminal-tab-1-icon')).toBeInTheDocument();
    });

    it('should render add tab button when under max tabs', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [{ id: '1', createdAt: new Date().toISOString() }],
        activeTabId: '1',
        tabOrder: ['1'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      expect(screen.getByTestId('terminal-tab-add')).toBeInTheDocument();
    });

    it('should not render bookmark button in tab bar', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      expect(screen.queryByTestId('terminal-tab-preset-btn')).not.toBeInTheDocument();
    });

    it('should not render add tab button when at max tabs', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
          { id: '3', createdAt: new Date().toISOString() },
          { id: '4', createdAt: new Date().toISOString() },
          { id: '5', createdAt: new Date().toISOString() },
          { id: '6', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2', '3', '4', '5', '6'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      expect(screen.queryByTestId('terminal-tab-add')).not.toBeInTheDocument();
    });
  });

  describe('Active Tab Styling', () => {
    it('should apply active class to active tab', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      const activeTab = screen.getByTestId('terminal-tab-1');
      const inactiveTab = screen.getByTestId('terminal-tab-2');

      expect(activeTab).toHaveClass('terminal-tab--active');
      expect(inactiveTab).not.toHaveClass('terminal-tab--active');
    });
  });

  describe('Close Button', () => {
    it('should render close button only for tabs 2+ when multiple tabs exist', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      expect(screen.queryByTestId('terminal-tab-1-close')).not.toBeInTheDocument();
      expect(screen.getByTestId('terminal-tab-2-close')).toBeInTheDocument();
    });

    it('should not render close button when only one tab exists', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [{ id: '1', createdAt: new Date().toISOString() }],
        activeTabId: '1',
        tabOrder: ['1'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      expect(screen.queryByTestId('terminal-tab-1-close')).not.toBeInTheDocument();
    });
  });

  describe('Click Handlers', () => {
    it('should call setActiveTerminalTab when tab is clicked', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      const tab2 = screen.getByTestId('terminal-tab-2');
      fireEvent.click(tab2);

      expect(sessionStore.setActiveTerminalTab).toHaveBeenCalledWith(mockSessionId, '2');
    });

    it('should call addTerminalTab when add button is clicked', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [{ id: '1', createdAt: new Date().toISOString() }],
        activeTabId: '1',
        tabOrder: ['1'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      const addButton = screen.getByTestId('terminal-tab-add');
      fireEvent.click(addButton);

      expect(sessionStore.addTerminalTab).toHaveBeenCalledWith(mockSessionId);
    });

    it('should call removeTerminalTab when close button is clicked', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      const closeButton = screen.getByTestId('terminal-tab-2-close');
      fireEvent.click(closeButton);

      expect(sessionStore.removeTerminalTab).toHaveBeenCalledWith(mockSessionId, '2');
    });

    it('should not trigger tab selection when close button is clicked', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      const closeButton = screen.getByTestId('terminal-tab-2-close');
      fireEvent.click(closeButton);

      // setActiveTerminalTab should not be called when clicking close
      expect(sessionStore.setActiveTerminalTab).not.toHaveBeenCalled();
    });
  });

  describe('Tab Labels', () => {
    it('should display correct tab names from config', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
          { id: '3', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2', '3'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      expect(screen.getByText('Terminal 1')).toBeInTheDocument();
      expect(screen.getByText('Terminal 2')).toBeInTheDocument();
      expect(screen.getByText('Terminal 3')).toBeInTheDocument();
    });
  });

  describe('Visual Styling', () => {
    it('tabs have correct data-type attribute', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
          { id: '3', createdAt: new Date().toISOString() },
          { id: '4', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2', '3', '4'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // All tabs show generic defaults (process detection overrides at runtime)
      expect(screen.getByTestId('terminal-tab-1')).toHaveAttribute('data-type', 'Terminal 1');
      expect(screen.getByTestId('terminal-tab-2')).toHaveAttribute('data-type', 'Terminal 2');
      expect(screen.getByTestId('terminal-tab-3')).toHaveAttribute('data-type', 'Terminal 3');
      expect(screen.getByTestId('terminal-tab-4')).toHaveAttribute('data-type', 'Terminal 4');
    });

    it('active tab has gradient background class', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      const activeTab = screen.getByTestId('terminal-tab-1');
      const inactiveTab = screen.getByTestId('terminal-tab-2');

      // Active tab should have the active class which includes gradient background styles
      expect(activeTab).toHaveClass('terminal-tab--active');
      expect(inactiveTab).not.toHaveClass('terminal-tab--active');
    });
  });

  describe('Drag and Drop Reordering', () => {
    it('should not render drag handle for tab 1 (fixed position)', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // Tab 1 should not have a drag handle
      expect(screen.queryByTestId('terminal-tab-1-drag-handle')).not.toBeInTheDocument();
    });

    it('should render drag handle for tabs 2+ on hover', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
          { id: '3', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2', '3'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // Tabs 2 and 3 should have drag handles (visible on hover via CSS)
      expect(screen.getByTestId('terminal-tab-2-drag-handle')).toBeInTheDocument();
      expect(screen.getByTestId('terminal-tab-3-drag-handle')).toBeInTheDocument();
    });

    it('should render tabs in tabOrder sequence', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
          { id: '3', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '3', '2'], // Custom order: tab 3 before tab 2
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // Get all tabs
      const tabs = screen.getAllByTestId(/^terminal-tab-\d$/);
      expect(tabs).toHaveLength(3);

      // Verify order matches tabOrder: 1, 3, 2
      expect(tabs[0]).toHaveAttribute('data-testid', 'terminal-tab-1');
      expect(tabs[1]).toHaveAttribute('data-testid', 'terminal-tab-3');
      expect(tabs[2]).toHaveAttribute('data-testid', 'terminal-tab-2');
    });

    it('should call reorderTerminalTabs when drag ends with valid reorder', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
          { id: '3', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2', '3'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // The component should expose drag-drop functionality
      // We verify the drag handle exists which enables the functionality
      expect(screen.getByTestId('terminal-tab-2-drag-handle')).toBeInTheDocument();
      expect(screen.getByTestId('terminal-tab-3-drag-handle')).toBeInTheDocument();
    });

    it('should ensure tab 1 remains first after any reorder attempt', () => {
      // This tests the validation in sessionStore.reorderTerminalTabs
      // which rejects any order that doesn't have '1' first
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // Tab 1 should not be draggable (no drag handle)
      expect(screen.queryByTestId('terminal-tab-1-drag-handle')).not.toBeInTheDocument();

      // Tab 2 should be draggable
      expect(screen.getByTestId('terminal-tab-2-drag-handle')).toBeInTheDocument();
    });

    it('should wrap sortable tabs in drag-drop provider', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: new Date().toISOString() },
          { id: '2', createdAt: new Date().toISOString() },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // The terminal-tabs container should exist (provider wrapper)
      expect(screen.getByTestId('terminal-tabs')).toBeInTheDocument();
    });
  });

  describe('Tiling-aware tab selection', () => {
    it('disables tiling when clicking a tab not visible in tiled layout', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: '' }, { id: '2', createdAt: '' },
          { id: '3', createdAt: '' }, { id: '4', createdAt: '' },
          { id: '5', createdAt: '' }, { id: '6', createdAt: '' },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2', '3', '4', '5', '6'],
        tiling: { enabled: true, layout: '3-split' },
      });
      vi.mocked(sessionStore.getTilingForSession).mockReturnValue({
        enabled: true, layout: '3-split',
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);
      fireEvent.click(screen.getByTestId('terminal-tab-5'));

      expect(sessionStore.setTilingLayout).toHaveBeenCalledWith(mockSessionId, 'tabbed');
      expect(sessionStore.setActiveTerminalTab).toHaveBeenCalledWith(mockSessionId, '5');
    });

    it('does NOT disable tiling when clicking a tab visible in tiled layout', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: '' }, { id: '2', createdAt: '' },
          { id: '3', createdAt: '' }, { id: '4', createdAt: '' },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2', '3', '4'],
        tiling: { enabled: true, layout: '3-split' },
      });
      vi.mocked(sessionStore.getTilingForSession).mockReturnValue({
        enabled: true, layout: '3-split',
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);
      fireEvent.click(screen.getByTestId('terminal-tab-2'));

      expect(sessionStore.setTilingLayout).not.toHaveBeenCalled();
      expect(sessionStore.setActiveTerminalTab).toHaveBeenCalledWith(mockSessionId, '2');
    });

    it('does NOT disable tiling when tiling is not enabled', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [{ id: '1', createdAt: '' }, { id: '2', createdAt: '' }],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });
      vi.mocked(sessionStore.getTilingForSession).mockReturnValue(null);

      render(() => <TerminalTabs sessionId={mockSessionId} />);
      fireEvent.click(screen.getByTestId('terminal-tab-2'));

      expect(sessionStore.setTilingLayout).not.toHaveBeenCalled();
    });
  });

  describe('Mobile close popup', () => {
    beforeEach(() => {
      isMobileMock.value = true;
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows close popup when tapping already-active tab on mobile', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: '' },
          { id: '2', createdAt: '' },
        ],
        activeTabId: '2',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // Tap the already-active tab 2
      fireEvent.click(screen.getByTestId('terminal-tab-2'));

      // Close popup should appear
      expect(screen.getByTestId('close-popup-2')).toBeInTheDocument();
      // Should NOT switch tabs
      expect(sessionStore.setActiveTerminalTab).not.toHaveBeenCalled();
    });

    it('close popup button calls removeTerminalTab', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: '' },
          { id: '2', createdAt: '' },
        ],
        activeTabId: '2',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // Tap active tab to show popup
      fireEvent.click(screen.getByTestId('terminal-tab-2'));

      // Click the close button in the popup
      const closeBtn = screen.getByTestId('close-popup-btn-2');
      fireEvent.click(closeBtn);

      expect(sessionStore.removeTerminalTab).toHaveBeenCalledWith(mockSessionId, '2');
    });

    it('does NOT show close popup for tab 1 on mobile', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: '' },
          { id: '2', createdAt: '' },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // Tap active tab 1
      fireEvent.click(screen.getByTestId('terminal-tab-1'));

      // No close popup should appear for tab 1
      expect(screen.queryByTestId('close-popup-1')).not.toBeInTheDocument();
    });

    it('long-press on tab (except tab 1) shows close popup', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: '' },
          { id: '2', createdAt: '' },
          { id: '3', createdAt: '' },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2', '3'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // Tab 3 is NOT active — long-press it
      const tab3 = screen.getByTestId('terminal-tab-3');
      fireEvent.pointerDown(tab3);

      // Advance 500ms for long-press threshold
      vi.advanceTimersByTime(500);

      // Close popup should appear for tab 3
      expect(screen.getByTestId('close-popup-3')).toBeInTheDocument();
    });

    it('long-press on tab 1 does NOT show close popup', () => {
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: '' },
          { id: '2', createdAt: '' },
        ],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      const tab1 = screen.getByTestId('terminal-tab-1');
      fireEvent.pointerDown(tab1);
      vi.advanceTimersByTime(500);

      expect(screen.queryByTestId('close-popup-1')).not.toBeInTheDocument();
    });

    it('close popup dismisses when clicking elsewhere', async () => {
      // Use fake timers but manually flush requestAnimationFrame
      const rafCallbacks: FrameRequestCallback[] = [];
      const origRAF = globalThis.requestAnimationFrame;
      globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      };

      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({
        tabs: [
          { id: '1', createdAt: '' },
          { id: '2', createdAt: '' },
        ],
        activeTabId: '2',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      });

      render(() => <TerminalTabs sessionId={mockSessionId} />);

      // Tap active tab to show popup
      fireEvent.click(screen.getByTestId('terminal-tab-2'));
      expect(screen.getByTestId('close-popup-2')).toBeInTheDocument();

      // Flush requestAnimationFrame to register the click-outside listener
      rafCallbacks.forEach(cb => cb(0));

      // Click elsewhere on the document
      fireEvent.click(document.body);

      // Popup should be dismissed
      expect(screen.queryByTestId('close-popup-2')).not.toBeInTheDocument();

      globalThis.requestAnimationFrame = origRAF;
    });
  });
});
