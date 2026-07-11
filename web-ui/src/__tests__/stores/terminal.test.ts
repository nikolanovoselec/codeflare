import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';

// Mock constants before importing terminal store
vi.mock('../../lib/constants', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    // Short backoff window so fake-timer advances stay small: with base 50ms and
    // Math.random pinned to 1 (see beforeEach), reconnectBackoffMs(2)=100ms and
    // reconnectBackoffMs(3+)=200ms (capped). A huge connect-timeout keeps the
    // CONNECTING-freeze watchdog from firing in these socket-closes-at-t0 tests.
    WS_RECONNECT_BASE_MS: 50,
    WS_RECONNECT_MAX_MS: 200,
    WS_CONNECT_TIMEOUT_MS: 1_000_000,
    CSS_TRANSITION_DELAY_MS: 10,
  };
});

// Mock API client
vi.mock('../../api/client', () => ({
  getTerminalWebSocketUrl: vi.fn(
    (sessionId: string, terminalId: string) =>
      `ws://localhost/api/terminal/${sessionId}-${terminalId}/ws`
  ),
}));

// Import after mocks
import { terminalStore, sendInputToTerminal, cleanupMapByPrefix } from '../../stores/terminal';

// Get mock WebSocket class from global
const _MockWebSocket = globalThis.WebSocket as unknown as {
  new (url: string): WebSocket & {
    _simulateMessage: (data: string | ArrayBuffer) => void;
    _simulateError: () => void;
  };
  CONNECTING: number;
  OPEN: number;
  CLOSING: number;
  CLOSED: number;
};

// REQ-TERM-016: Terminal Pane Reconnect and Resize Authority
// REQ-TERM-019: Terminal WebSocket Control Frames and Protocol Guards

describe('Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)', () => {
  const sessionId = 'test-session-123';
  const terminalId = '1';

  // Mock terminal instance
  const createMockTerminal = (): Terminal =>
    ({
      cols: 80,
      rows: 24,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn((_data: string, cb?: () => void) => { if (cb) cb(); }),
      clear: vi.fn(),
      reset: vi.fn(),
      scrollToBottom: vi.fn(),
      refresh: vi.fn(),
      dispose: vi.fn(),
      buffer: { active: { viewportY: 100, baseY: 100 } },
    }) as unknown as Terminal;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Pin jitter so reconnectBackoffMs is deterministic: rand=1 ⇒ full (100%)
    // backoff, i.e. reconnectBackoffMs(2)=100ms, reconnectBackoffMs(3+)=200ms.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    // Write batching uses setTimeout(cb, 33) for 30fps throttle.
    // Fake timers handle this — tests must advance by ≥33ms to flush writes.
    // Also stub rAF for any remaining callers (ResizeObserver, etc).
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Clean up any connections
    terminalStore.disposeAll();
  });

  describe('getConnectionState', () => {
    it('should return "disconnected" for unknown session/terminal', () => {
      const state = terminalStore.getConnectionState('unknown', '1');
      expect(state).toBe('disconnected');
    });
  });

  describe('setTerminal', () => {
    it('should store terminal instance', () => {
      const terminal = createMockTerminal();
      terminalStore.setTerminal(sessionId, terminalId, terminal);

      const storedTerminal = terminalStore.getTerminal(sessionId, terminalId);
      expect(storedTerminal).toBe(terminal);
    });

    it('should return undefined for unknown terminal', () => {
      const terminal = terminalStore.getTerminal('unknown', '1');
      expect(terminal).toBeUndefined();
    });
  });

  describe('connect', () => {
    it('should set connection state to "connecting" initially', () => {
      const terminal = createMockTerminal();

      terminalStore.connect(sessionId, terminalId, terminal);

      expect(terminalStore.getConnectionState(sessionId, terminalId)).toBe('connecting');
    });

    it('should return a cleanup function', () => {
      const terminal = createMockTerminal();

      const cleanup = terminalStore.connect(sessionId, terminalId, terminal);

      expect(typeof cleanup).toBe('function');
    });

    it('REQ-TERM-012: stale cleanup from an older connection cannot close a newer connection for the same terminal', () => {
      const OriginalWebSocket = globalThis.WebSocket;
      const sockets: Array<WebSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; _open: () => void; readyState: number }> = [];
      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        onopen: (() => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        readyState: number = WebSocket.CONNECTING;
        binaryType = 'arraybuffer';
        send = vi.fn();
        close = vi.fn(() => { this.readyState = WebSocket.CLOSED; });
        constructor(_url: string) { sockets.push(this as any); }
        _open() { this.readyState = WebSocket.OPEN; this.onopen?.(); }
      } as unknown as typeof WebSocket);

      try {
        const firstCleanup = terminalStore.connect(sessionId, terminalId, createMockTerminal());
        sockets[0]._open();
        const secondCleanup = terminalStore.connect(sessionId, terminalId, createMockTerminal());
        sockets[1]._open();

        firstCleanup();

        expect(sendInputToTerminal(sessionId, terminalId, 'x')).toBe(true);
        expect(sockets[1].send).toHaveBeenCalledWith('x');
        expect(sockets[1].close).not.toHaveBeenCalled();
        secondCleanup();
      } finally {
        vi.stubGlobal('WebSocket', OriginalWebSocket);
      }
    });

    it('should set connection state to "connected" on WebSocket open', async () => {
      const terminal = createMockTerminal();

      terminalStore.connect(sessionId, terminalId, terminal);

      // Allow WebSocket to simulate opening
      await vi.advanceTimersByTimeAsync(0);

      expect(terminalStore.getConnectionState(sessionId, terminalId)).toBe('connected');
    });

    it('should send initial resize on connection', async () => {
      const terminal = {
        ...createMockTerminal(),
        cols: 120,
        rows: 40,
      } as unknown as Terminal;

      // Track WebSocket send calls
      const sendSpy = vi.fn();
      const OriginalWebSocket = globalThis.WebSocket;
      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        send = sendSpy;
        constructor(url: string) {
          super(url);
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);

      // Allow WebSocket to open
      await vi.advanceTimersByTimeAsync(0);

      expect(sendSpy).toHaveBeenCalledWith(
        JSON.stringify({ type: 'resize', cols: 120, rows: 40 })
      );

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should dispose existing input handler before creating new one', async () => {
      const terminal = createMockTerminal();
      const disposeFn = vi.fn();
      (terminal.onData as ReturnType<typeof vi.fn>).mockReturnValue({ dispose: disposeFn });

      // First connection
      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      // Second connection should dispose existing handler
      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      expect(disposeFn).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('should set connection state to "disconnected"', async () => {
      const terminal = createMockTerminal();

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      terminalStore.disconnect(sessionId, terminalId);

      expect(terminalStore.getConnectionState(sessionId, terminalId)).toBe('disconnected');
    });
  });

  // REQ-TERM-020 AC1: quiet teardown — tearing down an in-flight (CONNECTING)
  // connection during rapid enter/exit must not force-close the socket (which
  // makes the browser log "WebSocket is closed before the connection is
  // established") nor surface a spurious onerror. An open socket is still closed.
  describe('REQ-TERM-020 AC1: quiet teardown of in-flight connections', () => {
    function stubControllableWebSocket(sockets: Array<{ readyState: number; close: ReturnType<typeof vi.fn>; onopen: (() => void) | null; onerror: ((e: Event) => void) | null; onclose: ((e: CloseEvent) => void) | null }>, autoOpen: boolean) {
      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = 0;
        binaryType = 'arraybuffer';
        onopen: (() => void) | null = null;
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        onclose: ((e: CloseEvent) => void) | null = null;
        send = vi.fn();
        close = vi.fn(() => { this.readyState = 3; });
        constructor(_url: string) {
          sockets.push(this as never);
          if (autoOpen) {
            setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
          }
        }
      } as unknown as typeof WebSocket);
    }

    it('does NOT force-close a still-CONNECTING socket (avoids "closed before established"), but still releases the connection', () => {
      const OriginalWebSocket = globalThis.WebSocket;
      const sockets: Array<{ readyState: number; close: ReturnType<typeof vi.fn>; onopen: (() => void) | null; onerror: ((e: Event) => void) | null; onclose: ((e: CloseEvent) => void) | null }> = [];
      stubControllableWebSocket(sockets, false); // never opens — stays CONNECTING
      try {
        terminalStore.connect(sessionId, terminalId, createMockTerminal());
        expect(sockets[0].readyState).toBe(0); // CONNECTING

        terminalStore.disconnect(sessionId, terminalId);

        // The mid-handshake socket is NOT force-closed (that is what logs the warning)...
        expect(sockets[0].close).not.toHaveBeenCalled();
        // ...but the connection is still fully released.
        expect(terminalStore.getConnectionState(sessionId, terminalId)).toBe('disconnected');
        expect(terminalStore.isConnected(sessionId, terminalId)).toBe(false);
      } finally {
        vi.stubGlobal('WebSocket', OriginalWebSocket);
      }
    });

    it('still force-closes a socket that has actually OPENED', async () => {
      const OriginalWebSocket = globalThis.WebSocket;
      const sockets: Array<{ readyState: number; close: ReturnType<typeof vi.fn>; onopen: (() => void) | null; onerror: ((e: Event) => void) | null; onclose: ((e: CloseEvent) => void) | null }> = [];
      stubControllableWebSocket(sockets, true); // opens on next tick
      try {
        terminalStore.connect(sessionId, terminalId, createMockTerminal());
        await vi.advanceTimersByTimeAsync(0);
        expect(sockets[0].readyState).toBe(1); // OPEN

        terminalStore.disconnect(sessionId, terminalId);

        expect(sockets[0].close).toHaveBeenCalled();
      } finally {
        vi.stubGlobal('WebSocket', OriginalWebSocket);
      }
    });

    it('does NOT log an error when an aborted in-flight socket later errors', () => {
      const OriginalWebSocket = globalThis.WebSocket;
      const sockets: Array<{ readyState: number; close: ReturnType<typeof vi.fn>; onopen: (() => void) | null; onerror: ((e: Event) => void) | null; onclose: ((e: CloseEvent) => void) | null }> = [];
      stubControllableWebSocket(sockets, false);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        terminalStore.connect(sessionId, terminalId, createMockTerminal());
        terminalStore.disconnect(sessionId, terminalId);
        errorSpy.mockClear();

        // The orphaned handshake now fails — browser fires onerror on the aborted socket.
        sockets[0].onerror?.(new Event('error'));

        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        vi.stubGlobal('WebSocket', OriginalWebSocket);
      }
    });
  });

  describe('isConnected', () => {
    it('should return false when not connected', () => {
      expect(terminalStore.isConnected(sessionId, terminalId)).toBe(false);
    });

    it('should return true when connected', async () => {
      const terminal = createMockTerminal();

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      expect(terminalStore.isConnected(sessionId, terminalId)).toBe(true);
    });

    it('should return false after disconnect', async () => {
      const terminal = createMockTerminal();

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);
      terminalStore.disconnect(sessionId, terminalId);

      expect(terminalStore.isConnected(sessionId, terminalId)).toBe(false);
    });
  });

  describe('resize', () => {
    it('should send resize message when connected', async () => {
      const terminal = createMockTerminal();
      const sendSpy = vi.fn();
      const OriginalWebSocket = globalThis.WebSocket;
      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        send = sendSpy;
        constructor(url: string) {
          super(url);
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      terminalStore.resize(sessionId, terminalId, 100, 50);

      expect(sendSpy).toHaveBeenCalledWith(
        JSON.stringify({ type: 'resize', cols: 100, rows: 50 })
      );

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('REQ-TERM-011: should send focus ownership control frame when connected', async () => {
      const terminal = createMockTerminal();
      const sendSpy = vi.fn();
      const OriginalWebSocket = globalThis.WebSocket;
      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        send = sendSpy;
        constructor(url: string) {
          super(url);
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      terminalStore.claimResizeAuthority(sessionId, terminalId);

      expect(sendSpy).toHaveBeenCalledWith(JSON.stringify({ type: 'focus' }));

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('REQ-TERM-011: sends queued focus before the initial resize when the WebSocket opens', async () => {
      const terminal = {
        ...createMockTerminal(),
        cols: 132,
        rows: 43,
      } as unknown as Terminal;
      const sendSpy = vi.fn();
      const OriginalWebSocket = globalThis.WebSocket;
      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        send = sendSpy;
        constructor(url: string) {
          super(url);
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      terminalStore.claimResizeAuthority(sessionId, terminalId);
      await vi.advanceTimersByTimeAsync(0);

      expect(sendSpy.mock.calls.map(([frame]) => frame)).toEqual([
        JSON.stringify({ type: 'focus' }),
        JSON.stringify({ type: 'resize', cols: 132, rows: 43 }),
      ]);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('REQ-TERM-011: resends focused resize authority after a retry reconnect opens', async () => {
      const terminal = {
        ...createMockTerminal(),
        cols: 120,
        rows: 40,
      } as unknown as Terminal;
      const sendSpy = vi.fn();
      const sockets: Array<{
        readyState: number;
        onopen: ((event: Event) => void) | null;
        onclose: ((event: CloseEvent) => void) | null;
      }> = [];
      const OriginalWebSocket = globalThis.WebSocket;
      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = 0;
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        send = sendSpy;
        constructor(_url: string) {
          sockets.push(this);
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.(new Event('open'));
          }, 0);
        }
        close(): void {
          this.readyState = 3;
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      terminalStore.claimResizeAuthority(sessionId, terminalId);
      await vi.advanceTimersByTimeAsync(0);
      expect(sendSpy.mock.calls.map(([frame]) => frame)).toEqual([
        JSON.stringify({ type: 'focus' }),
        JSON.stringify({ type: 'resize', cols: 120, rows: 40 }),
      ]);

      sendSpy.mockClear();
      sockets[0].readyState = 3;
      sockets[0].onclose?.({ code: 1006, reason: 'network' } as CloseEvent);
      await vi.runOnlyPendingTimersAsync();
      await vi.runOnlyPendingTimersAsync();

      expect(sendSpy.mock.calls.map(([frame]) => frame)).toEqual([
        JSON.stringify({ type: 'focus' }),
        JSON.stringify({ type: 'resize', cols: 120, rows: 40 }),
      ]);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('REQ-TERM-014: clears a stale queued focus claim before WebSocket open', async () => {
      const terminal = {
        ...createMockTerminal(),
        cols: 132,
        rows: 43,
      } as unknown as Terminal;
      const sendSpy = vi.fn();
      const OriginalWebSocket = globalThis.WebSocket;
      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = 0;
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        send = sendSpy;
        constructor(_url: string) {
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.(new Event('open'));
          }, 0);
        }
        close(): void {
          this.readyState = 3;
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      terminalStore.claimResizeAuthority(sessionId, terminalId);
      terminalStore.clearPendingResizeAuthority(sessionId, terminalId);
      await vi.advanceTimersByTimeAsync(0);

      expect(sendSpy.mock.calls.map(([frame]) => frame)).toEqual([
        JSON.stringify({ type: 'resize', cols: 132, rows: 43 }),
      ]);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should not throw when not connected', () => {
      expect(() => {
        terminalStore.resize(sessionId, terminalId, 100, 50);
        terminalStore.claimResizeAuthority(sessionId, terminalId);
      }).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('should disconnect and dispose terminal', async () => {
      const terminal = createMockTerminal();

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      terminalStore.dispose(sessionId, terminalId);

      expect(terminalStore.getConnectionState(sessionId, terminalId)).toBe('disconnected');
      expect(terminal.dispose).toHaveBeenCalled();
    });

    it('REQ-TERM-002: sends a kill control frame before closing the terminal connection', async () => {
      const terminal = createMockTerminal();
      const sendSpy = vi.fn();
      const OriginalWebSocket = globalThis.WebSocket;
      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        send = sendSpy;
        constructor(url: string) {
          super(url);
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      terminalStore.dispose(sessionId, terminalId);

      expect(sendSpy).toHaveBeenCalledWith(JSON.stringify({ type: 'kill' }));

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('REQ-TERM-011: disposes local terminal UI without killing the PTY', async () => {
      const terminal = createMockTerminal();
      const sendSpy = vi.fn();
      const OriginalWebSocket = globalThis.WebSocket;
      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        send = sendSpy;
        constructor(url: string) {
          super(url);
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);
      sendSpy.mockClear();

      terminalStore.disposeLocalTerminal(sessionId, terminalId);

      expect(terminalStore.getConnectionState(sessionId, terminalId)).toBe('disconnected');
      expect(terminalStore.getTerminal(sessionId, terminalId)).toBeUndefined();
      expect(terminal.dispose).toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalledWith(JSON.stringify({ type: 'kill' }));

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should clear stored terminal', async () => {
      const terminal = createMockTerminal();
      terminalStore.setTerminal(sessionId, terminalId, terminal);

      terminalStore.dispose(sessionId, terminalId);

      expect(terminalStore.getTerminal(sessionId, terminalId)).toBeUndefined();
    });
  });

  describe('disposeSession', () => {
    it('should dispose all terminals for a session', async () => {
      const terminal1 = createMockTerminal();
      const terminal2 = createMockTerminal();

      terminalStore.connect(sessionId, '1', terminal1);
      terminalStore.connect(sessionId, '2', terminal2);
      await vi.advanceTimersByTimeAsync(0);

      terminalStore.disposeSession(sessionId);

      expect(terminalStore.getConnectionState(sessionId, '1')).toBe('disconnected');
      expect(terminalStore.getConnectionState(sessionId, '2')).toBe('disconnected');
    });

    it('should clean up fitAddons, reconnectAttempts, and inputDisposables for the session', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const terminal1 = createMockTerminal();
      const terminal2 = createMockTerminal();
      const mockFitAddon = { fit: vi.fn() };

      // Set up connections and fitAddons for the target session
      terminalStore.connect(sessionId, '1', terminal1);
      terminalStore.connect(sessionId, '2', terminal2);
      await vi.advanceTimersByTimeAsync(0);

      terminalStore.registerFitAddon(sessionId, '1', mockFitAddon as any);
      terminalStore.registerFitAddon(sessionId, '2', mockFitAddon as any);

      // Dispose the session
      terminalStore.disposeSession(sessionId);

      // Verify terminals are gone
      expect(terminalStore.getTerminal(sessionId, '1')).toBeUndefined();
      expect(terminalStore.getTerminal(sessionId, '2')).toBeUndefined();

      // Verify connections are disconnected
      expect(terminalStore.getConnectionState(sessionId, '1')).toBe('disconnected');
      expect(terminalStore.getConnectionState(sessionId, '2')).toBe('disconnected');

      // Verify reconnect returns null (no stored terminal = Maps were cleaned up)
      expect(terminalStore.reconnect(sessionId, '1')).toBeNull();
      expect(terminalStore.reconnect(sessionId, '2')).toBeNull();
      errorSpy.mockRestore();
    });

    it('should not affect other sessions', async () => {
      const terminal1 = createMockTerminal();
      const terminal2 = createMockTerminal();

      terminalStore.connect('session-1', '1', terminal1);
      terminalStore.connect('session-2', '1', terminal2);
      await vi.advanceTimersByTimeAsync(0);

      terminalStore.disposeSession('session-1');

      expect(terminalStore.getConnectionState('session-1', '1')).toBe('disconnected');
      expect(terminalStore.getConnectionState('session-2', '1')).toBe('connected');
    });
  });

  describe('disposeAll', () => {
    it('should dispose all terminals across all sessions', async () => {
      const terminal1 = createMockTerminal();
      const terminal2 = createMockTerminal();

      terminalStore.connect('session-1', '1', terminal1);
      terminalStore.connect('session-2', '1', terminal2);
      await vi.advanceTimersByTimeAsync(0);

      terminalStore.disposeAll();

      expect(terminalStore.getConnectionState('session-1', '1')).toBe('disconnected');
      expect(terminalStore.getConnectionState('session-2', '1')).toBe('disconnected');
    });

    it('should clear all auxiliary Maps (fitAddons, inputDisposables, reconnectAttempts, retryTimeouts)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const terminal1 = createMockTerminal();
      const terminal2 = createMockTerminal();
      const mockFitAddon = { fit: vi.fn() };

      // Set up connections and fitAddons
      terminalStore.connect('session-a', '1', terminal1);
      terminalStore.connect('session-b', '1', terminal2);
      await vi.advanceTimersByTimeAsync(0);

      terminalStore.registerFitAddon('session-a', '1', mockFitAddon as any);
      terminalStore.registerFitAddon('session-b', '1', mockFitAddon as any);

      // Now dispose all
      terminalStore.disposeAll();

      // Verify terminals are gone
      expect(terminalStore.getTerminal('session-a', '1')).toBeUndefined();
      expect(terminalStore.getTerminal('session-b', '1')).toBeUndefined();

      // Verify connections are disconnected
      expect(terminalStore.getConnectionState('session-a', '1')).toBe('disconnected');
      expect(terminalStore.getConnectionState('session-b', '1')).toBe('disconnected');

      // Verify reconnect returns null (no stored terminal means Maps are cleared)
      expect(terminalStore.reconnect('session-a', '1')).toBeNull();
      expect(terminalStore.reconnect('session-b', '1')).toBeNull();
      errorSpy.mockRestore();
    });

    it('should call dispose on all terminal instances', async () => {
      const terminal1 = createMockTerminal();
      const terminal2 = createMockTerminal();

      terminalStore.setTerminal('session-x', '1', terminal1);
      terminalStore.setTerminal('session-y', '2', terminal2);
      terminalStore.connect('session-x', '1', terminal1);
      terminalStore.connect('session-y', '2', terminal2);
      await vi.advanceTimersByTimeAsync(0);

      terminalStore.disposeAll();

      expect(terminal1.dispose).toHaveBeenCalled();
      expect(terminal2.dispose).toHaveBeenCalled();
    });
  });

  describe('reconnect', () => {
    it('should return null if terminal not found', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = terminalStore.reconnect('unknown', '1');
      expect(result).toBeNull();
      errorSpy.mockRestore();
    });

    it('should return cleanup function on successful reconnect', async () => {
      const terminal = createMockTerminal();
      terminalStore.setTerminal(sessionId, terminalId, terminal);

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      const cleanup = terminalStore.reconnect(sessionId, terminalId);

      expect(typeof cleanup).toBe('function');
    });

    it('should disconnect before reconnecting', async () => {
      const terminal = createMockTerminal();

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);
      expect(terminalStore.isConnected(sessionId, terminalId)).toBe(true);

      // Reconnect
      terminalStore.reconnect(sessionId, terminalId);

      // Should go through connecting state again
      expect(terminalStore.getConnectionState(sessionId, terminalId)).toBe('connecting');
    });
  });

  describe('FitAddon management', () => {
    it('should register and unregister fitAddon', () => {
      const mockFitAddon = { fit: vi.fn() };

      // Should not throw
      expect(() => {
        terminalStore.registerFitAddon(sessionId, terminalId, mockFitAddon as any);
        terminalStore.unregisterFitAddon(sessionId, terminalId);
      }).not.toThrow();
    });
  });

  describe('triggerLayoutResize', () => {
    it('should increment layout change counter', () => {
      const initialCounter = terminalStore.layoutChangeCounter;

      terminalStore.triggerLayoutResize();
      vi.advanceTimersByTime(100);

      expect(terminalStore.layoutChangeCounter).toBe(initialCounter + 1);
    });
  });

  describe('restore message handling (xterm-headless reconnect)', () => {
    it('should handle restore message by resetting and writing serialized state', async () => {
      const terminal = {
        ...createMockTerminal(),
        cols: 100,
        rows: 30,
      } as unknown as Terminal;

      const OriginalWebSocket = globalThis.WebSocket;
      let wsInstance: any;

      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        constructor(url: string) {
          super(url);
          wsInstance = this;
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);

      // Allow WebSocket to open
      await vi.advanceTimersByTimeAsync(0);

      // Clear mocks to isolate restore behavior
      (terminal.clear as ReturnType<typeof vi.fn>).mockClear();
      (terminal.reset as ReturnType<typeof vi.fn>).mockClear();
      (terminal.write as ReturnType<typeof vi.fn>).mockClear();
      (terminal.scrollToBottom as ReturnType<typeof vi.fn>).mockClear();
      (terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

      // Simulate server sending restore message with serialized terminal state
      const serializedState = '\x1b[?1049h\x1b[H\x1b[2Jhtop output here';
      wsInstance._simulateMessage(JSON.stringify({ type: 'restore', state: serializedState }));

      // ANSI clear-screen + clear-scrollback + cursor-home should be the
      // first write (synchronous PTY-level clear before xterm.clear/reset)
      expect(terminal.write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H');
      // xterm.clear() should have been called (viewport clear)
      expect(terminal.clear).toHaveBeenCalled();
      // terminal.reset should have been called to clear existing state
      expect(terminal.reset).toHaveBeenCalled();
      // terminal.write should have been called with the serialized state
      expect(terminal.write).toHaveBeenCalledWith(serializedState);
      // terminal.scrollToBottom should have been called
      expect(terminal.scrollToBottom).toHaveBeenCalled();
      // terminal.refresh should have been called to force repaint
      expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should ignore restore message with empty state', async () => {
      const terminal = createMockTerminal();

      const OriginalWebSocket = globalThis.WebSocket;
      let wsInstance: any;

      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        constructor(url: string) {
          super(url);
          wsInstance = this;
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);

      // Allow WebSocket to open
      await vi.advanceTimersByTimeAsync(0);

      // Clear mocks
      (terminal.reset as ReturnType<typeof vi.fn>).mockClear();

      // Simulate server sending restore message without state
      wsInstance._simulateMessage(JSON.stringify({ type: 'restore' }));

      // terminal.reset should NOT have been called (no state to restore)
      expect(terminal.reset).not.toHaveBeenCalled();

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('REQ-TERM-014: preserves xterm viewport anchoring when full scrollback trims during a batched write', async () => {
      const activeBuffer = { viewportY: 500, baseY: 1000 };
      const scrollLines = vi.fn((delta: number) => {
        activeBuffer.viewportY += delta;
      });
      const terminal = {
        ...createMockTerminal(),
        buffer: { active: activeBuffer },
        scrollLines,
        write: vi.fn((_data: string, callback?: () => void) => {
          // xterm 6.1 keeps the visible content anchored while ten old lines trim.
          activeBuffer.viewportY = 490;
          callback?.();
        }),
      } as unknown as Terminal;

      const OriginalWebSocket = globalThis.WebSocket;
      let wsInstance: any;

      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        constructor(url: string) {
          super(url);
          wsInstance = this;
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      for (let line = 0; line < 10; line += 1) {
        wsInstance._simulateMessage(`line-${line}\r\n`);
      }
      await vi.advanceTimersByTimeAsync(50);

      expect(terminal.buffer.active.viewportY).toBe(490);
      expect(scrollLines).not.toHaveBeenCalled();

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should still write non-JSON raw terminal data to terminal', async () => {
      const terminal = createMockTerminal();

      const OriginalWebSocket = globalThis.WebSocket;
      let wsInstance: any;

      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        constructor(url: string) {
          super(url);
          wsInstance = this;
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);

      // Allow WebSocket to open
      await vi.advanceTimersByTimeAsync(0);

      // Simulate raw terminal data (escape sequences, text, etc.)
      const rawData = '\x1b[32mHello World\x1b[0m\r\n';
      wsInstance._simulateMessage(rawData);

      // Flush write batch (30fps throttle = 33ms setTimeout)
      await vi.advanceTimersByTimeAsync(50);

      expect(terminal.write).toHaveBeenCalledWith(rawData);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should write unknown JSON control messages (e.g. pong) as raw terminal data', async () => {
      const terminal = createMockTerminal();

      const OriginalWebSocket = globalThis.WebSocket;
      let wsInstance: any;

      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        constructor(url: string) {
          super(url);
          wsInstance = this;
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);

      // Allow WebSocket to open
      await vi.advanceTimersByTimeAsync(0);

      // Send a pong message — no longer a recognized control message
      const pongMsg = JSON.stringify({ type: 'pong' });
      wsInstance._simulateMessage(pongMsg);

      // Flush write batch (30fps throttle = 33ms setTimeout)
      await vi.advanceTimersByTimeAsync(50);

      // Since pong is no longer handled, it falls through to terminal.write
      expect(terminal.write).toHaveBeenCalledWith(pongMsg);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should write JSON-like strings that fail parsing as raw terminal data', async () => {
      const terminal = createMockTerminal();

      const OriginalWebSocket = globalThis.WebSocket;
      let wsInstance: any;

      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        constructor(url: string) {
          super(url);
          wsInstance = this;
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);

      // Allow WebSocket to open
      await vi.advanceTimersByTimeAsync(0);

      // Send malformed JSON that starts with '{' but isn't valid JSON
      const malformedJson = '{not valid json at all';
      wsInstance._simulateMessage(malformedJson);

      // Flush write batch (30fps throttle = 33ms setTimeout)
      await vi.advanceTimersByTimeAsync(50);

      // Should fall through to raw write
      expect(terminal.write).toHaveBeenCalledWith(malformedJson);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });
  });

  describe('sendInputToTerminal', () => {
    it('should return false when no connection exists', () => {
      const result = sendInputToTerminal('nonexistent', '1', 'hello');
      expect(result).toBe(false);
    });

    it('should return true and send text when WebSocket is OPEN', async () => {
      const terminal = createMockTerminal();
      const sendSpy = vi.fn();
      const OriginalWebSocket = globalThis.WebSocket;

      vi.stubGlobal('WebSocket', class extends (OriginalWebSocket as unknown as { new (url: string): WebSocket }) {
        send = sendSpy;
        constructor(url: string) {
          super(url);
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      const result = sendInputToTerminal(sessionId, terminalId, 'ls -la\n');

      expect(result).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith('ls -la\n');

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should return false when WebSocket is not in OPEN state', async () => {
      const terminal = createMockTerminal();

      // Connect then disconnect (WebSocket will be closed)
      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);
      terminalStore.disconnect(sessionId, terminalId);

      const result = sendInputToTerminal(sessionId, terminalId, 'hello');
      expect(result).toBe(false);
    });
  });

  describe('WebSocket reconnection behavior', () => {
    it('stops retrying on 4503 (container stopped) and sets disconnected', async () => {
      const terminal = createMockTerminal();
      const OriginalWebSocket = globalThis.WebSocket;
      let connectCount = 0;

      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = 0;
        url: string;
        binaryType: BinaryType = 'blob';
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string) {
          this.url = url;
          connectCount++;
          setTimeout(() => {
            this.readyState = 3;
            if (this.onclose) {
              // Server-authoritative: container is not running
              this.onclose(new CloseEvent('close', { code: 4503, reason: 'container-stopped' }));
            }
          }, 0);
        }

        send(_data: string | ArrayBuffer | Blob | ArrayBufferView): void {}
        close(_code?: number, _reason?: string): void {
          this.readyState = 3;
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);

      // Should NOT retry — 4503 is authoritative
      await vi.advanceTimersByTimeAsync(200);
      expect(connectCount).toBe(1);

      expect(terminalStore.getConnectionState(sessionId, terminalId)).toBe('disconnected');
      expect(terminalStore.getRetryMessage(sessionId, terminalId)).toBe('Session stopped');

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('retries indefinitely on 1006 (network error) without dead-container inference', async () => {
      const terminal = createMockTerminal();
      const OriginalWebSocket = globalThis.WebSocket;
      let connectCount = 0;

      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = 0;
        url: string;
        binaryType: BinaryType = 'blob';
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string) {
          this.url = url;
          connectCount++;
          setTimeout(() => {
            this.readyState = 3;
            if (this.onclose) {
              this.onclose(new CloseEvent('close', { code: 1006 }));
            }
          }, 0);
        }

        send(_data: string | ArrayBuffer | Blob | ArrayBufferView): void {}
        close(_code?: number, _reason?: string): void {
          this.readyState = 3;
        }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);

      // Let the initial attempt fail, then walk the backoff schedule. Each socket
      // closes on its setTimeout(0), so attempts land at t=0 (initial), 100, 300,
      // 500, 700… (backoff 100, then 200 capped). advance(0) fires the first
      // close; advance(800) blows through attempts 2–5 (700 < 800).
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(800);

      // Should keep retrying — no dead-container cutoff at attemptNumber > 1
      expect(connectCount).toBeGreaterThanOrEqual(5);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('exports getRetryMessage in the store API', () => {
      expect('getRetryMessage' in terminalStore).toBe(true);
    });
  });

  describe('WS retryable close codes (Fix 5)', () => {
    it('should retry on close code 1001 (Going Away)', async () => {
      const terminal = createMockTerminal();
      const OriginalWebSocket = globalThis.WebSocket;
      let connectCount = 0;

      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = 0;
        url: string;
        binaryType: BinaryType = 'blob';
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string) {
          this.url = url;
          connectCount++;
          setTimeout(() => {
            this.readyState = 3;
            if (this.onclose) {
              this.onclose(new CloseEvent('close', { code: 1001 }));
            }
          }, 0);
        }

        send(_data: string | ArrayBuffer | Blob | ArrayBufferView): void {}
        close(_code?: number, _reason?: string): void { this.readyState = 3; }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);   // First WS closes with 1001
      await vi.advanceTimersByTimeAsync(100);  // first backoff = reconnectBackoffMs(2) = 100ms
      await vi.advanceTimersByTimeAsync(0);    // Second WS created

      expect(connectCount).toBeGreaterThanOrEqual(2);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should retry on close code 1011 (Unexpected Condition)', async () => {
      const terminal = createMockTerminal();
      const OriginalWebSocket = globalThis.WebSocket;
      let connectCount = 0;

      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = 0;
        url: string;
        binaryType: BinaryType = 'blob';
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string) {
          this.url = url;
          connectCount++;
          setTimeout(() => {
            this.readyState = 3;
            if (this.onclose) {
              this.onclose(new CloseEvent('close', { code: 1011 }));
            }
          }, 0);
        }

        send(_data: string | ArrayBuffer | Blob | ArrayBufferView): void {}
        close(_code?: number, _reason?: string): void { this.readyState = 3; }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(0);

      expect(connectCount).toBeGreaterThanOrEqual(2);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should retry on close codes 1012 (Service Restart) and 1013 (Try Again Later)', async () => {
      const terminal = createMockTerminal();
      const OriginalWebSocket = globalThis.WebSocket;

      for (const code of [1012, 1013]) {
        let connectCount = 0;

        vi.stubGlobal('WebSocket', class {
          static CONNECTING = 0;
          static OPEN = 1;
          static CLOSING = 2;
          static CLOSED = 3;

          readyState = 0;
          url: string;
          binaryType: BinaryType = 'blob';
          onopen: ((event: Event) => void) | null = null;
          onclose: ((event: CloseEvent) => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;

          constructor(url: string) {
            this.url = url;
            connectCount++;
            setTimeout(() => {
              this.readyState = 3;
              if (this.onclose) {
                this.onclose(new CloseEvent('close', { code }));
              }
            }, 0);
          }

          send(_data: string | ArrayBuffer | Blob | ArrayBufferView): void {}
          close(_code?: number, _reason?: string): void { this.readyState = 3; }
        } as unknown as typeof WebSocket);

        terminalStore.connect(sessionId, terminalId, terminal);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(0);

        expect(connectCount).toBeGreaterThanOrEqual(2);

        terminalStore.disconnect(sessionId, terminalId);
        await vi.advanceTimersByTimeAsync(0);
      }

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should NOT retry on close code 1000 (Normal Closure)', async () => {
      const terminal = createMockTerminal();
      const OriginalWebSocket = globalThis.WebSocket;
      let connectCount = 0;

      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = 0;
        url: string;
        binaryType: BinaryType = 'blob';
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string) {
          this.url = url;
          connectCount++;
          setTimeout(() => {
            this.readyState = 3;
            if (this.onclose) {
              this.onclose(new CloseEvent('close', { code: 1000 }));
            }
          }, 0);
        }

        send(_data: string | ArrayBuffer | Blob | ArrayBufferView): void {}
        close(_code?: number, _reason?: string): void { this.readyState = 3; }
      } as unknown as typeof WebSocket);

      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(200);

      // Should NOT have retried — only 1 connection attempt
      expect(connectCount).toBe(1);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });
  });

  describe('AbortController-based cancellation', () => {
    it('should cancel previous retry loops when connect() is called again for same key', async () => {
      const terminal = createMockTerminal();

      // Create WebSocket that immediately closes with abnormal code
      const OriginalWebSocket = globalThis.WebSocket;
      let wsCloseCount = 0;

      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = 0;
        url: string;
        binaryType: BinaryType = 'blob';
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string) {
          this.url = url;
          // Simulate immediate failure
          setTimeout(() => {
            this.readyState = 3;
            wsCloseCount++;
            if (this.onclose) {
              this.onclose(new CloseEvent('close', { code: 1006 }));
            }
          }, 0);
        }

        send(_data: string | ArrayBuffer | Blob | ArrayBufferView): void {}
        close(_code?: number, _reason?: string): void {
          this.readyState = 3;
        }
      } as unknown as typeof WebSocket);

      // First connect — starts retry loop
      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0); // First WS fails

      // Second connect for SAME key — should abort first retry loop
      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0); // Second WS fails

      // Advance through multiple retry cycles. Each socket closes on its
      // setTimeout(0), so a single loop's closes land at t=100,300,500,700,900
      // (backoff 100ms, then 200ms capped). Over a 900ms window a single loop
      // produces 5 closes; two parallel loops (the regression) would produce ~10.
      wsCloseCount = 0;
      await vi.advanceTimersByTimeAsync(900);

      // Only ONE retry loop should be active (the second connect's loop).
      // A single loop produces 5 closes in 900ms; two parallel loops would
      // produce ~10. Assert the single-loop bound.
      expect(wsCloseCount).toBeLessThanOrEqual(6);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should cancel in-flight retries when disconnect() is called', async () => {
      const terminal = createMockTerminal();

      // Create WebSocket that immediately closes with abnormal code
      const OriginalWebSocket = globalThis.WebSocket;
      let connectAttempts = 0;

      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = 0;
        url: string;
        binaryType: BinaryType = 'blob';
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string) {
          this.url = url;
          connectAttempts++;
          setTimeout(() => {
            this.readyState = 3;
            if (this.onclose) {
              this.onclose(new CloseEvent('close', { code: 1006 }));
            }
          }, 0);
        }

        send(_data: string | ArrayBuffer | Blob | ArrayBufferView): void {}
        close(_code?: number, _reason?: string): void {
          this.readyState = 3;
        }
      } as unknown as typeof WebSocket);

      // Connect — starts retry loop
      terminalStore.connect(sessionId, terminalId, terminal);
      await vi.advanceTimersByTimeAsync(0); // First WS fails

      // Disconnect — should abort controller and stop retries
      const attemptsBeforeDisconnect = connectAttempts;
      terminalStore.disconnect(sessionId, terminalId);

      // Advance time — no more retries should happen
      await vi.advanceTimersByTimeAsync(500);

      // disconnect() itself creates no new connections, so attempts should stay the same
      // (the +1 from disconnect calling connect is not expected here since disconnect just aborts)
      expect(connectAttempts).toBe(attemptsBeforeDisconnect);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('should stop all retries when disconnectAll is called via disposeAll()', async () => {
      const terminal1 = createMockTerminal();
      const terminal2 = createMockTerminal();

      const OriginalWebSocket = globalThis.WebSocket;
      let connectAttempts = 0;

      vi.stubGlobal('WebSocket', class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = 0;
        url: string;
        binaryType: BinaryType = 'blob';
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string) {
          this.url = url;
          connectAttempts++;
          setTimeout(() => {
            this.readyState = 3;
            if (this.onclose) {
              this.onclose(new CloseEvent('close', { code: 1006 }));
            }
          }, 0);
        }

        send(_data: string | ArrayBuffer | Blob | ArrayBufferView): void {}
        close(_code?: number, _reason?: string): void {
          this.readyState = 3;
        }
      } as unknown as typeof WebSocket);

      // Start two failing connections
      terminalStore.connect('session-1', '1', terminal1);
      terminalStore.connect('session-2', '1', terminal2);
      await vi.advanceTimersByTimeAsync(0);

      const attemptsBeforeDispose = connectAttempts;
      terminalStore.disposeAll();

      // Advance time — no more retries
      await vi.advanceTimersByTimeAsync(500);

      expect(connectAttempts).toBe(attemptsBeforeDispose);

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

  });


  describe('cleanupMapByPrefix', () => {
    it('cleanupMapByPrefix removes matching keys and calls teardown', () => {
      const map = new Map<string, number>();
      map.set('session-1:tab-1', 1);
      map.set('session-1:tab-2', 2);
      map.set('session-2:tab-1', 3);

      const teardown = vi.fn();
      cleanupMapByPrefix(map, 'session-1:', teardown);

      expect(map.size).toBe(1);
      expect(map.has('session-2:tab-1')).toBe(true);
      expect(teardown).toHaveBeenCalledTimes(2);
      expect(teardown).toHaveBeenCalledWith(1);
      expect(teardown).toHaveBeenCalledWith(2);
    });

    it('cleanupMapByPrefix preserves non-matching keys', () => {
      const map = new Map<string, string>();
      map.set('alpha:1', 'a');
      map.set('beta:1', 'b');
      map.set('alpha:2', 'c');

      cleanupMapByPrefix(map, 'gamma:');

      expect(map.size).toBe(3);
    });
  });
});
