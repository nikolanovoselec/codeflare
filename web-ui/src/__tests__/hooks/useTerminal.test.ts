import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, createSignal } from 'solid-js';

// Mock all heavy dependencies before importing the hook
const mockFit = vi.fn();
const mockTerminalOpen = vi.fn();
const mockTerminalDispose = vi.fn();
const mockLoadAddon = vi.fn();
const mockAttachCustomKeyEventHandler = vi.fn();
const mockScrollToBottom = vi.fn();
const mockRefresh = vi.fn();
const mockFocus = vi.fn();

const mockTerminalInstance = {
  loadAddon: mockLoadAddon,
  open: mockTerminalOpen,
  attachCustomKeyEventHandler: mockAttachCustomKeyEventHandler,
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn(),
  clear: vi.fn(),
  reset: vi.fn(),
  paste: vi.fn(),
  getSelection: vi.fn(() => ''),
  clearSelection: vi.fn(),
  scrollToBottom: mockScrollToBottom,
  refresh: mockRefresh,
  focus: mockFocus,
  dispose: mockTerminalDispose,
  cols: 80,
  rows: 24,
  options: { fontFamily: 'monospace', theme: {} },
  textarea: null,
  buffer: {
    active: { length: 0, cursorY: 0, getLine: vi.fn(() => null) },
    onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
  },
  parser: {
    registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
  },
  registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
};

// MOCK-DRIFT RISK: Terminal constructor returns a static mock object.
// Real @xterm/xterm Terminal creates a full terminal emulator with DOM rendering,
// buffer management, and input processing. Our mock only stubs the methods
// that useTerminal calls during lifecycle.
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => mockTerminalInstance),
}));

// MOCK-DRIFT RISK: FitAddon.fit() is a no-op here.
// Real FitAddon calculates terminal dimensions from container element size
// and calls terminal.resize(). Our mock skips dimension calculation entirely.
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({ fit: mockFit })),
}));

// MOCK-DRIFT RISK: terminalStore.connect() returns a cleanup function.
// Real implementation opens a WebSocket, attaches data handlers, and manages
// reconnection logic. Our mock bypasses all network activity.
vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    setTerminal: vi.fn(),
    registerFitAddon: vi.fn(),
    unregisterFitAddon: vi.fn(),
    connect: vi.fn(() => vi.fn()),
    resize: vi.fn(),
    getRetryMessage: vi.fn(() => null),
    getConnectionState: vi.fn(() => 'disconnected'),
    triggerLayoutResize: vi.fn(),
    startUrlDetection: vi.fn(),
    stopUrlDetection: vi.fn(),
  },
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    isSessionInitializing: vi.fn(() => false),
    getInitProgressForSession: vi.fn(() => null),
    getTerminalsForSession: vi.fn(() => ({ tabs: [{ id: '1', label: 'Terminal', manual: false }], activeTabId: '1' })),
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

vi.mock('../../lib/terminal-link-provider', () => ({
  registerMultiLineLinkProvider: vi.fn(),
}));

vi.mock('../../lib/terminal-mobile-input', () => ({
  setupMobileInput: vi.fn(() => vi.fn()),
}));

import { useTerminal, type UseTerminalOptions } from '../../hooks/useTerminal';
import { terminalStore } from '../../stores/terminal';
import { sessionStore } from '../../stores/session';
import { isTouchDevice, getKeyboardHeight } from '../../lib/mobile';

describe('useTerminal hook', () => {
  const defaultProps: UseTerminalOptions = {
    sessionId: 'test-session-123',
    terminalId: '1',
    active: true,
  };

  // Create a minimal container element for the hook
  let containerEl: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    containerEl = document.createElement('div');
    // Give it dimensions so ResizeObserver has something to work with
    Object.defineProperty(containerEl, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(containerEl, 'clientHeight', { value: 600, configurable: true });
    document.body.appendChild(containerEl);

    // Mock getComputedStyle for terminal theme extraction
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: vi.fn(() => ''),
    } as any);

    // Mock document.fonts
    Object.defineProperty(document, 'fonts', {
      value: { ready: Promise.resolve() },
      configurable: true,
    });

    // Stub window.scrollTo (not implemented in jsdom)
    window.scrollTo = vi.fn() as any;

    // Mock requestAnimationFrame
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    document.body.removeChild(containerEl);
    vi.restoreAllMocks();
  });

  describe('lifecycle', () => {
    it('should return all expected interface members', () => {
      let result!: ReturnType<typeof useTerminal>;

      const dispose = createRoot((dispose) => {
        result = useTerminal(defaultProps);
        return dispose;
      });

      expect(result.containerRef).toBeTypeOf('function');
      expect(result.terminal).toBeTypeOf('function');
      expect(result.dimensions).toBeTypeOf('function');
      expect(result.retryMessage).toBeTypeOf('function');
      expect(result.connectionState).toBeTypeOf('function');
      expect(result.isInitializing).toBeTypeOf('function');
      expect(result.initProgress).toBeTypeOf('function');

      dispose();
    });

    it('should provide default dimensions of 80x24', () => {
      let result!: ReturnType<typeof useTerminal>;

      const dispose = createRoot((dispose) => {
        result = useTerminal(defaultProps);
        return dispose;
      });

      expect(result.dimensions()).toEqual({ cols: 80, rows: 24 });

      dispose();
    });

    it('should expose retryMessage from terminalStore', () => {
      vi.mocked(terminalStore.getRetryMessage).mockReturnValue('Retrying...');

      let result!: ReturnType<typeof useTerminal>;

      const dispose = createRoot((dispose) => {
        result = useTerminal(defaultProps);
        return dispose;
      });

      expect(result.retryMessage()).toBe('Retrying...');

      dispose();
    });

    it('should expose connectionState from terminalStore', () => {
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('connected');

      let result!: ReturnType<typeof useTerminal>;

      const dispose = createRoot((dispose) => {
        result = useTerminal(defaultProps);
        return dispose;
      });

      expect(result.connectionState()).toBe('connected');

      dispose();
    });

    it('should expose isInitializing from sessionStore', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(true);

      let result!: ReturnType<typeof useTerminal>;

      const dispose = createRoot((dispose) => {
        result = useTerminal(defaultProps);
        return dispose;
      });

      expect(result.isInitializing()).toBe(true);

      dispose();
    });
  });

  describe('cleanup on unmount', () => {
    it('should unregister fit addon on dispose', () => {
      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      dispose();

      expect(terminalStore.unregisterFitAddon).toHaveBeenCalledWith(
        defaultProps.sessionId,
        defaultProps.terminalId
      );
    });
  });

  describe('URL detection lifecycle', () => {
    it('should start URL detection after WebSocket connects', () => {
      // isSessionInitializing returns false so the connect effect fires immediately
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      expect(terminalStore.startUrlDetection).toHaveBeenCalledWith(
        defaultProps.sessionId,
        defaultProps.terminalId
      );

      dispose();
    });

    it('should stop URL detection on cleanup', () => {
      vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      dispose();

      expect(terminalStore.stopUrlDetection).toHaveBeenCalled();
    });
  });

  describe('resize handling', () => {
    it('should register fit addon in the store on mount', () => {
      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      expect(terminalStore.registerFitAddon).toHaveBeenCalledWith(
        defaultProps.sessionId,
        defaultProps.terminalId,
        expect.objectContaining({ fit: expect.any(Function) })
      );

      dispose();
    });
  });

  describe('keyboard height refit', () => {
    it('should call scrollToBottom after fit when keyboard height changes on mobile', async () => {
      vi.useFakeTimers();

      const isTouchDeviceMock = vi.mocked(isTouchDevice);
      const getKeyboardHeightMock = vi.mocked(getKeyboardHeight);

      // Start as mobile device with keyboard closed
      isTouchDeviceMock.mockReturnValue(true);

      // Use a SolidJS signal to back the mock so createEffect re-tracks
      const [kbHeight, setKbHeight] = createSignal(0);
      getKeyboardHeightMock.mockImplementation(() => kbHeight());

      let result!: ReturnType<typeof useTerminal>;

      const dispose = createRoot((dispose) => {
        result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      // Clear any calls from initial mount
      mockScrollToBottom.mockClear();
      mockFit.mockClear();

      // Simulate keyboard opening by changing keyboard height
      setKbHeight(300);

      // Advance past the 150ms debounce
      await vi.advanceTimersByTimeAsync(200);

      expect(mockFit).toHaveBeenCalled();
      expect(mockScrollToBottom).toHaveBeenCalled();

      dispose();
      vi.useRealTimers();
    });
  });
});
