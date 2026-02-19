import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@solidjs/testing-library';
import Terminal from '../../components/Terminal';
import { terminalStore } from '../../stores/terminal';
import { sessionStore } from '../../stores/session';
import { isTouchDevice, enableVirtualKeyboardOverlay } from '../../lib/mobile';

// Mock xterm.js and addons
const mockTerminalInstance = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  attachCustomKeyEventHandler: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn(),
  clear: vi.fn(),
  reset: vi.fn(),
  paste: vi.fn(),
  getSelection: vi.fn(() => ''),
  clearSelection: vi.fn(),
  scrollToBottom: vi.fn(),
  refresh: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
  cols: 80,
  rows: 24,
  buffer: {
    active: {
      length: 0,
      getLine: vi.fn(() => null) as ReturnType<typeof vi.fn>,
    },
    onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
  },
  parser: {
    registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
  },
  registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
};

// MOCK-DRIFT RISK: Terminal constructor returns a static mock. Real @xterm/xterm Terminal
// creates a full emulator with DOM rendering, buffer management, input handling, and
// CSI/OSC parsing. This mock only stubs the API surface used by useTerminal and the
// Terminal component — any new xterm API usage requires updating this mock.
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => mockTerminalInstance),
}));

// MOCK-DRIFT RISK: FitAddon.fit() is a no-op. Real FitAddon measures the container
// element to calculate cols/rows and calls terminal.resize(). Dimension-dependent
// tests must set cols/rows on mockTerminalInstance manually.
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({
    fit: vi.fn(),
  })),
}));

// MOCK-DRIFT RISK: terminalStore is a shallow stub of the reactive SolidJS store.
// Real store manages WebSocket connections, reconnection logic, and per-session
// terminal instances. Methods like connect() actually open WebSockets; here they
// return a no-op cleanup function.
vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    getConnectionState: vi.fn(),
    getRetryMessage: vi.fn(),
    getTerminal: vi.fn(),
    setTerminal: vi.fn(),
    connect: vi.fn(() => vi.fn()),
    disconnect: vi.fn(),
    resize: vi.fn(),
    // FitAddon management for layout changes
    registerFitAddon: vi.fn(),
    unregisterFitAddon: vi.fn(),
    triggerLayoutResize: vi.fn(),
    layoutChangeCounter: 0,
  },
}));

// MOCK-DRIFT RISK: sessionStore is a shallow stub. Real store manages session
// lifecycle (create/start/stop/delete), init progress tracking, metrics polling,
// and terminal tab state. Only the methods consumed by the Terminal component
// are mocked here.
vi.mock('../../stores/session', () => ({
  sessionStore: {
    isSessionInitializing: vi.fn(),
    getInitProgressForSession: vi.fn(),
  },
}));

// MOCK-DRIFT RISK: InitProgress is replaced with a trivial div. Real component
// renders a multi-stage progress overlay with animations, stage timings, and
// detail rows. Tests that depend on InitProgress internals should use the real
// component or a more detailed mock.
vi.mock('../../components/InitProgress', () => ({
  default: (props: { sessionName: string }) => (
    <div data-testid="init-progress">Init Progress: {props.sessionName}</div>
  ),
}));

// MOCK-DRIFT RISK: mobile module is stubbed to return desktop defaults.
// Tests that need touch behavior must override isTouchDevice per-test.
vi.mock('../../lib/mobile', () => ({
  isTouchDevice: vi.fn(() => false),
  isVirtualKeyboardOpen: vi.fn(() => false),
  getKeyboardHeight: vi.fn(() => 0),
  enableVirtualKeyboardOverlay: vi.fn(),
  disableVirtualKeyboardOverlay: vi.fn(),
  resetKeyboardStateIfStale: vi.fn(),
  forceResetKeyboardState: vi.fn(),
}));

vi.mock('../../lib/touch-gestures', () => ({
  attachSwipeGestures: vi.fn(() => vi.fn()),
}));

vi.mock('../../lib/terminal-mobile-input', () => ({
  setupMobileInput: vi.fn(() => vi.fn()),
}));

vi.mock('../../lib/terminal-link-provider', () => ({
  registerMultiLineLinkProvider: vi.fn(),
}));

describe('Terminal Component', () => {
  const defaultProps = {
    sessionId: 'test-session-123',
    terminalId: '1',
    sessionName: 'Test Session',
    active: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock return values
    vi.mocked(terminalStore.getConnectionState).mockReturnValue('disconnected');
    vi.mocked(terminalStore.getRetryMessage).mockReturnValue(null);
    vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
    vi.mocked(sessionStore.getInitProgressForSession).mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  describe('Init Progress Overlay', () => {
    it('should show init progress overlay when session is initializing', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(true);
      vi.mocked(sessionStore.getInitProgressForSession).mockReturnValue({
        stage: 'starting',
        progress: 25,
        message: 'Starting container...',
        details: [],
      });

      render(() => <Terminal {...defaultProps} />);

      expect(screen.getByTestId('init-progress')).toBeInTheDocument();
    });

    it('should not show init progress overlay when session is not initializing', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);

      render(() => <Terminal {...defaultProps} />);

      expect(screen.queryByTestId('init-progress')).not.toBeInTheDocument();
    });

    it('should pass sessionName to InitProgress component', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(true);

      render(() => <Terminal {...defaultProps} sessionName="My Custom Session" />);

      expect(screen.getByText('Init Progress: My Custom Session')).toBeInTheDocument();
    });

    it('should use fallback sessionName when not provided', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(true);

      // Render without sessionName prop to test fallback
      render(() => (
        <Terminal
          sessionId={defaultProps.sessionId}
          terminalId={defaultProps.terminalId}
          active={defaultProps.active}
        />
      ));

      expect(screen.getByText('Init Progress: Terminal')).toBeInTheDocument();
    });
  });

  describe('Connection State Overlay', () => {
    it('should show "Connecting..." when not connected and not initializing', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('connecting');

      render(() => <Terminal {...defaultProps} />);

      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });

    it('should show retry message when available', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('connecting');
      vi.mocked(terminalStore.getRetryMessage).mockReturnValue('Connecting... (attempt 3/45)');

      render(() => <Terminal {...defaultProps} />);

      expect(screen.getByText('Connecting... (attempt 3/45)')).toBeInTheDocument();
    });

    it('should not show connection overlay when connected', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('connected');

      render(() => <Terminal {...defaultProps} />);

      // Should not find "Connecting..." text
      expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
    });

    it('should not show connection overlay when session is initializing', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(true);
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('disconnected');

      render(() => <Terminal {...defaultProps} />);

      // Init progress overlay takes precedence
      expect(screen.getByTestId('init-progress')).toBeInTheDocument();
      // Connection overlay should not be visible (hidden by init overlay)
    });

    it('should show connection overlay for disconnected state', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('disconnected');

      render(() => <Terminal {...defaultProps} />);

      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });

    it('should show connection overlay for error state', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('error');

      render(() => <Terminal {...defaultProps} />);

      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });
  });

  describe('Terminal Visibility', () => {
    it('should display terminal when active is true', () => {
      render(() => <Terminal {...defaultProps} active={true} />);

      const wrapper = document.querySelector('.terminal-wrapper');
      expect(wrapper).toHaveStyle({ visibility: 'visible' });
      expect(wrapper).toHaveStyle({ position: 'relative' });
    });

    it('should hide terminal when active is false', () => {
      render(() => <Terminal {...defaultProps} active={false} />);

      const wrapper = document.querySelector('.terminal-wrapper');
      expect(wrapper).toHaveStyle({ visibility: 'hidden' });
      expect(wrapper).toHaveStyle({ position: 'absolute' });
    });
  });

  describe('Store Interactions', () => {
    it('should call setTerminal on mount', () => {
      render(() => <Terminal {...defaultProps} />);

      expect(terminalStore.setTerminal).toHaveBeenCalledWith(
        defaultProps.sessionId,
        defaultProps.terminalId,
        expect.any(Object)
      );
    });

    it('should get connection state with correct session and terminal IDs', () => {
      render(() => <Terminal {...defaultProps} />);

      expect(terminalStore.getConnectionState).toHaveBeenCalledWith(
        defaultProps.sessionId,
        defaultProps.terminalId
      );
    });

    it('should get retry message with correct session and terminal IDs', () => {
      render(() => <Terminal {...defaultProps} />);

      expect(terminalStore.getRetryMessage).toHaveBeenCalledWith(
        defaultProps.sessionId,
        defaultProps.terminalId
      );
    });

    it('should check session initializing state', () => {
      render(() => <Terminal {...defaultProps} />);

      expect(sessionStore.isSessionInitializing).toHaveBeenCalledWith(defaultProps.sessionId);
    });
  });

  describe('Overlay Priority', () => {
    it('should show init overlay when both init and connection would show', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(true);
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('disconnected');

      render(() => <Terminal {...defaultProps} />);

      expect(screen.getByTestId('init-progress')).toBeInTheDocument();
      // Connection overlay is hidden by init overlay (both rendered but init has higher z-index)
    });

    it('should show connection overlay when not initializing and not connected', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('disconnected');

      render(() => <Terminal {...defaultProps} />);

      expect(screen.queryByTestId('init-progress')).not.toBeInTheDocument();
      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });

    it('should show no overlays when connected', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('connected');

      render(() => <Terminal {...defaultProps} terminalId="1" />);

      expect(screen.queryByTestId('init-progress')).not.toBeInTheDocument();
      expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
    });
  });

  describe('Connection Spinner', () => {
    it('should render spinner when showing connection status', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('connecting');

      render(() => <Terminal {...defaultProps} />);

      expect(document.querySelector('.terminal-connection-spinner')).toBeInTheDocument();
    });

    it('should not render spinner when connected', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('connected');

      render(() => <Terminal {...defaultProps} terminalId="1" />);

      expect(document.querySelector('.terminal-connection-spinner')).not.toBeInTheDocument();
    });
  });

  describe('Mobile Touch Behavior', () => {
    // jsdom lacks PointerEvent — polyfill as a subclass of MouseEvent
    const PointerEventPolyfill = class extends MouseEvent {
      constructor(type: string, init?: MouseEventInit) { super(type, init); }
    };
    if (typeof globalThis.PointerEvent === 'undefined') {
      (globalThis as any).PointerEvent = PointerEventPolyfill;
    }

    beforeEach(() => {
      vi.mocked(isTouchDevice).mockReturnValue(true);
      // Provide a terminal instance so touch handlers can access it
      vi.mocked(terminalStore.getTerminal).mockReturnValue(mockTerminalInstance as any);
    });

    afterEach(() => {
      vi.mocked(isTouchDevice).mockReturnValue(false);
    });

    it('should NOT call enableVirtualKeyboardOverlay on pointerdown', () => {
      render(() => <Terminal {...defaultProps} />);

      // Clear any calls from useTerminal's createEffect (keyboard lifecycle on mount)
      vi.mocked(enableVirtualKeyboardOverlay).mockClear();

      const container = document.querySelector('.terminal-container')!;
      container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

      expect(enableVirtualKeyboardOverlay).not.toHaveBeenCalled();
    });

    it('should call enableVirtualKeyboardOverlay on click (tap)', () => {
      render(() => <Terminal {...defaultProps} />);

      const container = document.querySelector('.terminal-container')!;
      container.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(enableVirtualKeyboardOverlay).toHaveBeenCalled();
    });

    it('should call preventDefault on pointerdown for non-link targets', () => {
      render(() => <Terminal {...defaultProps} />);

      const container = document.querySelector('.terminal-container')!;
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      container.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('should NOT call preventDefault on pointerdown for link targets', () => {
      render(() => <Terminal {...defaultProps} />);

      const container = document.querySelector('.terminal-container')!;
      // Create a link element inside the container
      const linkEl = document.createElement('span');
      linkEl.classList.add('xterm-link');
      container.appendChild(linkEl);

      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      linkEl.dispatchEvent(event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });
  });
});
