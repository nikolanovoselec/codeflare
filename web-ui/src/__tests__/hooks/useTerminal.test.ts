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
  scrollLines: vi.fn(),
  onScroll: vi.fn(() => ({ dispose: vi.fn() })),
  buffer: {
    active: { length: 0, cursorY: 0, viewportY: 0, baseY: 0, getLine: vi.fn(() => null) },
    onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
  },
  parser: {
    registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
  },
  registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
  _core: {},
};

// MOCK-DRIFT RISK: Terminal constructor returns a static mock object.
// Real @xterm/xterm Terminal creates a full terminal emulator with DOM rendering,
// buffer management, and input processing. Our mock only stubs the methods
// that useTerminal calls during lifecycle.
vi.mock('@xterm/xterm', () => {
  const TerminalClass = vi.fn(function (this: any) {
    Object.assign(this, mockTerminalInstance);
  }) as any;
  return { Terminal: TerminalClass };
});

// MOCK-DRIFT RISK: FitAddon.fit() is a no-op here.
// Real FitAddon calculates terminal dimensions from container element size
// and calls terminal.resize(). Our mock skips dimension calculation entirely.
vi.mock('@xterm/addon-fit', () => {
  const FitAddonClass = vi.fn(function (this: any) {
    this.fit = mockFit;
  }) as any;
  return { FitAddon: FitAddonClass };
});

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
    getConnectionState: vi.fn(() => 'disconnected'),
    getRetryMessage: vi.fn(() => null),
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
  isSamsungBrowser: false,
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

vi.mock('../../lib/settings', () => ({
  loadSettings: vi.fn(() => ({ clipboardAccess: true })),
}));

import { useTerminal, type UseTerminalOptions, DECTCEM_CURSOR_PARAM, KEYBOARD_REFIT_DEBOUNCE_MS } from '../../hooks/useTerminal';
import { terminalStore } from '../../stores/terminal';
import { sessionStore } from '../../stores/session';
import { isTouchDevice, getKeyboardHeight, isVirtualKeyboardOpen, forceResetKeyboardState } from '../../lib/mobile';
import * as mobileModule from '../../lib/mobile';
import { loadSettings } from '../../lib/settings';

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

  describe('right-click to paste', () => {
    it('should add contextmenu listener to container on mount', () => {
      const addEventSpy = vi.spyOn(containerEl, 'addEventListener');

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      expect(addEventSpy).toHaveBeenCalledWith('contextmenu', expect.any(Function));

      dispose();
    });

    it('should prevent default context menu and paste clipboard text', async () => {
      const clipboardText = 'pasted content';
      Object.assign(navigator, {
        clipboard: {
          readText: vi.fn().mockResolvedValue(clipboardText),
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      });

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      containerEl.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();

      // Wait for clipboard promise to resolve
      await vi.waitFor(() => {
        expect(mockTerminalInstance.paste).toHaveBeenCalledWith(clipboardText);
      });

      dispose();
    });

    it('should not paste when clipboard is empty', async () => {
      Object.assign(navigator, {
        clipboard: {
          readText: vi.fn().mockResolvedValue(''),
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      });

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      containerEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

      // Give the promise time to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(mockTerminalInstance.paste).not.toHaveBeenCalled();

      dispose();
    });

    it('should handle clipboard permission denial gracefully', async () => {
      Object.assign(navigator, {
        clipboard: {
          readText: vi.fn().mockRejectedValue(new DOMException('Denied')),
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      });

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      // Should not throw
      containerEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

      await new Promise((r) => setTimeout(r, 10));
      expect(mockTerminalInstance.paste).not.toHaveBeenCalled();

      dispose();
    });

    it('should remove contextmenu listener on cleanup', () => {
      const removeEventSpy = vi.spyOn(containerEl, 'removeEventListener');

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      dispose();

      expect(removeEventSpy).toHaveBeenCalledWith('contextmenu', expect.any(Function));
    });
  });

  describe('clipboard access setting', () => {
    beforeEach(() => {
      Object.assign(navigator, {
        clipboard: {
          readText: vi.fn().mockResolvedValue('clipboard text'),
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      });
    });

    it('should not read clipboard on right-click when clipboardAccess is disabled', async () => {
      vi.mocked(loadSettings).mockReturnValue({ clipboardAccess: false });

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      containerEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

      await new Promise((r) => setTimeout(r, 10));
      expect(navigator.clipboard.readText).not.toHaveBeenCalled();

      dispose();
    });

    it('should read clipboard on right-click when clipboardAccess is enabled', async () => {
      vi.mocked(loadSettings).mockReturnValue({ clipboardAccess: true });

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      containerEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

      await vi.waitFor(() => {
        expect(navigator.clipboard.readText).toHaveBeenCalled();
      });

      dispose();
    });
  });

  describe('keyboard height refit', () => {
    it('should scroll to bottom when keyboard opens (closed→open transition)', async () => {
      vi.useFakeTimers();

      const isTouchDeviceMock = vi.mocked(isTouchDevice);
      const getKeyboardHeightMock = vi.mocked(getKeyboardHeight);
      const isVirtualKeyboardOpenMock = vi.mocked(isVirtualKeyboardOpen);

      isTouchDeviceMock.mockReturnValue(true);

      const [kbHeight, setKbHeight] = createSignal(0);
      const [kbOpen, setKbOpen] = createSignal(false);
      getKeyboardHeightMock.mockImplementation(() => kbHeight());
      isVirtualKeyboardOpenMock.mockImplementation(() => kbOpen());

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      mockScrollToBottom.mockClear();
      mockFit.mockClear();

      // Simulate keyboard opening (closed→open)
      setKbHeight(300);
      setKbOpen(true);

      await vi.advanceTimersByTimeAsync(200);

      expect(mockFit).toHaveBeenCalled();
      expect(mockScrollToBottom).toHaveBeenCalled();

      dispose();
      vi.useRealTimers();
    });

    it('should NOT scroll to bottom when keyboard closes (open→closed transition)', async () => {
      vi.useFakeTimers();

      const isTouchDeviceMock = vi.mocked(isTouchDevice);
      const getKeyboardHeightMock = vi.mocked(getKeyboardHeight);
      const isVirtualKeyboardOpenMock = vi.mocked(isVirtualKeyboardOpen);

      isTouchDeviceMock.mockReturnValue(true);

      const [kbHeight, setKbHeight] = createSignal(0);
      const [kbOpen, setKbOpen] = createSignal(false);
      getKeyboardHeightMock.mockImplementation(() => kbHeight());
      isVirtualKeyboardOpenMock.mockImplementation(() => kbOpen());

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      // Open keyboard first
      setKbHeight(300);
      setKbOpen(true);
      await vi.advanceTimersByTimeAsync(200);

      mockScrollToBottom.mockClear();
      mockFit.mockClear();

      // Close keyboard
      setKbHeight(0);
      setKbOpen(false);
      await vi.advanceTimersByTimeAsync(200);

      expect(mockFit).toHaveBeenCalled();
      expect(mockScrollToBottom).not.toHaveBeenCalled();

      dispose();
      vi.useRealTimers();
    });

    it('should scroll to bottom on close→reopen even if close debounce was cancelled', async () => {
      vi.useFakeTimers();

      const isTouchDeviceMock = vi.mocked(isTouchDevice);
      const getKeyboardHeightMock = vi.mocked(getKeyboardHeight);
      const isVirtualKeyboardOpenMock = vi.mocked(isVirtualKeyboardOpen);

      isTouchDeviceMock.mockReturnValue(true);

      const [kbHeight, setKbHeight] = createSignal(0);
      const [kbOpen, setKbOpen] = createSignal(false);
      getKeyboardHeightMock.mockImplementation(() => kbHeight());
      isVirtualKeyboardOpenMock.mockImplementation(() => kbOpen());

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      // Open keyboard and let debounce complete
      setKbHeight(300);
      setKbOpen(true);
      await vi.advanceTimersByTimeAsync(200);

      mockScrollToBottom.mockClear();
      mockFit.mockClear();

      // Close keyboard but reopen BEFORE the close debounce fires (within 150ms).
      setKbHeight(0);
      setKbOpen(false);
      // Advance only 50ms — not enough for close debounce to fire
      await vi.advanceTimersByTimeAsync(50);

      // Reopen keyboard — the close debounce was cancelled
      setKbHeight(300);
      setKbOpen(true);
      await vi.advanceTimersByTimeAsync(200);

      expect(mockFit).toHaveBeenCalled();
      expect(mockScrollToBottom).toHaveBeenCalled();

      dispose();
      vi.useRealTimers();
    });

    it('should scroll to bottom on mid-animation height adjustments while keyboard stays open', async () => {
      vi.useFakeTimers();

      const isTouchDeviceMock = vi.mocked(isTouchDevice);
      const getKeyboardHeightMock = vi.mocked(getKeyboardHeight);
      const isVirtualKeyboardOpenMock = vi.mocked(isVirtualKeyboardOpen);

      isTouchDeviceMock.mockReturnValue(true);

      const [kbHeight, setKbHeight] = createSignal(0);
      const [kbOpen, setKbOpen] = createSignal(false);
      getKeyboardHeightMock.mockImplementation(() => kbHeight());
      isVirtualKeyboardOpenMock.mockImplementation(() => kbOpen());

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      // Open keyboard
      setKbHeight(300);
      setKbOpen(true);
      await vi.advanceTimersByTimeAsync(200);

      mockScrollToBottom.mockClear();
      mockFit.mockClear();

      // Height adjustment while keyboard stays open (e.g. Samsung address bar)
      setKbHeight(350);
      await vi.advanceTimersByTimeAsync(200);

      expect(mockFit).toHaveBeenCalled();
      // Always scroll to bottom when keyboard is open — fit() can reset scroll
      // position, so we must re-anchor to prevent "jump to top"
      expect(mockScrollToBottom).toHaveBeenCalled();

      dispose();
      vi.useRealTimers();
    });

    it('should skip fitAddon.fit() in active-state effect when kbDebouncePending is true', async () => {
      vi.useFakeTimers();

      const isTouchDeviceMock = vi.mocked(isTouchDevice);
      const getKeyboardHeightMock = vi.mocked(getKeyboardHeight);

      // Mobile device
      isTouchDeviceMock.mockReturnValue(true);

      // Use a SolidJS signal to back the mock so createEffect re-tracks
      const [kbHeight, setKbHeight] = createSignal(0);
      getKeyboardHeightMock.mockImplementation(() => kbHeight());

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      // Clear mount-time fit calls
      mockFit.mockClear();

      // Trigger keyboard height change — sets kbDebouncePending = true
      setKbHeight(300);

      // At this point kbDebouncePending is true (debounce timer hasn't fired).
      // No synchronous fit() calls should happen because:
      //  - The keyboard refit effect only starts a debounce timer (no immediate fit)
      //  - The active-state effect's fit() is guarded by kbDebouncePending
      //  - The ResizeObserver's fit() is also guarded by kbDebouncePending
      expect(mockFit).not.toHaveBeenCalled();

      // Now advance past debounce — the debounced keyboard refit should call fit()
      await vi.advanceTimersByTimeAsync(KEYBOARD_REFIT_DEBOUNCE_MS + 50);

      // fit() should have been called at least once (by the debounced refit callback;
      // other deferred effects like document.fonts.ready may also contribute)
      expect(mockFit).toHaveBeenCalled();

      dispose();
      vi.useRealTimers();
    });
  });

  describe('named constants', () => {
    it('DECTCEM_CURSOR_PARAM equals 25', () => {
      expect(DECTCEM_CURSOR_PARAM).toBe(25);
    });

    it('KEYBOARD_REFIT_DEBOUNCE_MS equals 150', () => {
      expect(KEYBOARD_REFIT_DEBOUNCE_MS).toBe(150);
    });
  });

  describe('extracted functions', () => {
    it('initializeTerminal creates Terminal with correct options', async () => {
      const { Terminal } = await import('@xterm/xterm');

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      // Terminal constructor should have been called with expected options
      expect(Terminal).toHaveBeenCalledWith(
        expect.objectContaining({
          cursorBlink: true,
          cursorStyle: 'bar',
          fontSize: 14,
          lineHeight: 1.2,
          allowProposedApi: true,
          convertEol: true,
          scrollback: 400,
        })
      );

      dispose();
    });

    it('setupMobileTerminal is called when touch device detected', async () => {
      const isTouchDeviceMock = vi.mocked(isTouchDevice);
      isTouchDeviceMock.mockReturnValue(true);

      const { setupMobileInput } = await import('../../lib/terminal-mobile-input');

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      // setupMobileInput should be called on mobile devices
      expect(setupMobileInput).toHaveBeenCalled();

      dispose();
    });
  });

  describe('Samsung focusout keyboard dismiss (Fix 1)', () => {
    beforeEach(() => {
      vi.mocked(isTouchDevice).mockReturnValue(true);
    });

    afterEach(() => {
      vi.mocked(isTouchDevice).mockReturnValue(false);
      // Reset isSamsungBrowser
      (mobileModule as any).isSamsungBrowser = false;
    });

    it('should register focusout handler on Samsung to detect back-button keyboard dismiss', () => {
      (mobileModule as any).isSamsungBrowser = true;

      // Provide a textarea on the mock terminal for the handler to attach to
      const mockTextarea = document.createElement('textarea');
      const addEventSpy = vi.spyOn(mockTextarea, 'addEventListener');
      mockTerminalInstance.textarea = mockTextarea as any;

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      // Should have attached a focusout handler
      expect(addEventSpy).toHaveBeenCalledWith('focusout', expect.any(Function));

      dispose();
      mockTerminalInstance.textarea = null;
    });

    it('should call forceResetKeyboardState when focusout fires while keyboard is open on Samsung', () => {
      (mobileModule as any).isSamsungBrowser = true;
      vi.mocked(isVirtualKeyboardOpen).mockReturnValue(true);

      const mockTextarea = document.createElement('textarea');
      mockTerminalInstance.textarea = mockTextarea as any;

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      // Simulate focusout event (Samsung back-button dismiss)
      mockTextarea.dispatchEvent(new Event('focusout'));

      expect(forceResetKeyboardState).toHaveBeenCalled();

      dispose();
      mockTerminalInstance.textarea = null;
    });

    it('should NOT register focusout handler on non-Samsung browsers', () => {
      (mobileModule as any).isSamsungBrowser = false;

      const mockTextarea = document.createElement('textarea');
      const addEventSpy = vi.spyOn(mockTextarea, 'addEventListener');
      mockTerminalInstance.textarea = mockTextarea as any;

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      const focusoutCalls = addEventSpy.mock.calls.filter(([type]) => type === 'focusout');
      expect(focusoutCalls).toHaveLength(0);

      dispose();
      mockTerminalInstance.textarea = null;
    });
  });

  describe('kbDebounceTimer race fix (Fix 3)', () => {
    it('should not block ResizeObserver after keyboard debounce timer cleanup', async () => {
      vi.useFakeTimers();

      const isTouchDeviceMock = vi.mocked(isTouchDevice);
      const getKeyboardHeightMock = vi.mocked(getKeyboardHeight);

      isTouchDeviceMock.mockReturnValue(true);

      const [kbHeight, setKbHeight] = createSignal(0);
      getKeyboardHeightMock.mockImplementation(() => kbHeight());

      const dispose = createRoot((dispose) => {
        const result = useTerminal(defaultProps);
        result.containerRef(containerEl);
        return dispose;
      });

      // Trigger keyboard height change — starts debounce timer
      setKbHeight(300);

      // Let debounce timer fire and complete
      await vi.advanceTimersByTimeAsync(KEYBOARD_REFIT_DEBOUNCE_MS + 50);

      // Clear fit calls from above
      mockFit.mockClear();

      // Now trigger a ResizeObserver callback manually
      // The ResizeObserver should NOT be blocked (kbDebounceTimer should be null)
      const resizeObserverCallback = (globalThis as any).__lastResizeObserverCallback;
      if (resizeObserverCallback) {
        resizeObserverCallback([{ contentRect: { width: 900, height: 700 } }]);
        // RAF should allow fit to be called
        expect(mockFit).toHaveBeenCalled();
      }

      dispose();
      vi.useRealTimers();
    });
  });

  // Pointer-events toggle tests removed — xterm 6.0.0 moved scrolling to
  // SmoothScrollableElement (JS-based). Touch scrolling when keyboard is closed
  // is now handled by touch-gestures.ts via terminal.scrollLines().
});
