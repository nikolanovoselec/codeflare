import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';

// Mock constants before importing terminal store
vi.mock('../../lib/constants', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    MAX_WS_RETRIES: 3,
    WS_RETRY_DELAY_MS: 100,
    CSS_TRANSITION_DELAY_MS: 10,
    WS_CLOSE_ABNORMAL: 1006,
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
import { terminalStore, sendInputToTerminal } from '../../stores/terminal';

// Get mock WebSocket class from global
const MockWebSocket = globalThis.WebSocket as unknown as {
  new (url: string): WebSocket & {
    _simulateMessage: (data: string | ArrayBuffer) => void;
    _simulateError: () => void;
  };
  CONNECTING: number;
  OPEN: number;
  CLOSING: number;
  CLOSED: number;
};

describe('Terminal Store', () => {
  const sessionId = 'test-session-123';
  const terminalId = '1';

  // Mock terminal instance
  const createMockTerminal = (): Terminal =>
    ({
      cols: 80,
      rows: 24,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      reset: vi.fn(),
      scrollToBottom: vi.fn(),
      refresh: vi.fn(),
      dispose: vi.fn(),
    }) as unknown as Terminal;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up any connections
    terminalStore.disposeAll();
  });

  describe('getConnectionState', () => {
    it('should return "disconnected" for unknown session/terminal', () => {
      const state = terminalStore.getConnectionState('unknown', '1');
      expect(state).toBe('disconnected');
    });
  });

  describe('getRetryMessage', () => {
    it('should return null for unknown session/terminal', () => {
      const message = terminalStore.getRetryMessage('unknown', '1');
      expect(message).toBeNull();
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

    it('should set retry message when connecting', () => {
      const terminal = createMockTerminal();

      terminalStore.connect(sessionId, terminalId, terminal);

      expect(terminalStore.getRetryMessage(sessionId, terminalId)).toBe('Connecting...');
    });

    it('should return a cleanup function', () => {
      const terminal = createMockTerminal();

      const cleanup = terminalStore.connect(sessionId, terminalId, terminal);

      expect(typeof cleanup).toBe('function');
    });

    it('should set connection state to "connected" on WebSocket open', async () => {
      const terminal = createMockTerminal();

      terminalStore.connect(sessionId, terminalId, terminal);

      // Allow WebSocket to simulate opening
      await vi.advanceTimersByTimeAsync(0);

      expect(terminalStore.getConnectionState(sessionId, terminalId)).toBe('connected');
    });

    it('should clear retry message on successful connection', async () => {
      const terminal = createMockTerminal();

      terminalStore.connect(sessionId, terminalId, terminal);

      // Allow WebSocket to simulate opening
      await vi.advanceTimersByTimeAsync(0);

      expect(terminalStore.getRetryMessage(sessionId, terminalId)).toBeNull();
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

    it('should not throw when not connected', () => {
      expect(() => {
        terminalStore.resize(sessionId, terminalId, 100, 50);
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
      (terminal.reset as ReturnType<typeof vi.fn>).mockClear();
      (terminal.write as ReturnType<typeof vi.fn>).mockClear();
      (terminal.scrollToBottom as ReturnType<typeof vi.fn>).mockClear();
      (terminal.refresh as ReturnType<typeof vi.fn>).mockClear();

      // Simulate server sending restore message with serialized terminal state
      const serializedState = '\x1b[?1049h\x1b[H\x1b[2Jhtop output here';
      wsInstance._simulateMessage(JSON.stringify({ type: 'restore', state: serializedState }));

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

      // Should write raw data directly to terminal
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
    it('should show retry attempt in message', async () => {
      const terminal = createMockTerminal();

      // Create WebSocket that immediately closes with abnormal code
      const OriginalWebSocket = globalThis.WebSocket;
      let wsInstance: WebSocket & { onclose?: ((event: CloseEvent) => void) | null };

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
          wsInstance = this as unknown as WebSocket & { onclose?: ((event: CloseEvent) => void) | null };
          // Simulate immediate failure
          setTimeout(() => {
            this.readyState = 3; // CLOSED
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

      // First attempt
      expect(terminalStore.getRetryMessage(sessionId, terminalId)).toBe('Connecting...');

      // Let first attempt fail
      await vi.advanceTimersByTimeAsync(0);

      // Wait for retry delay
      await vi.advanceTimersByTimeAsync(100);

      // Should show retry attempt
      const retryMessage = terminalStore.getRetryMessage(sessionId, terminalId);
      expect(retryMessage).toMatch(/attempt/i);

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

      // Advance through what would be multiple retry cycles
      // With MAX_WS_RETRIES=3 and delay=100ms, 3 retries = 300ms
      // If the bug existed, both loops would retry independently = 6+ connections
      wsCloseCount = 0;
      await vi.advanceTimersByTimeAsync(500);

      // Should have at most MAX_WS_RETRIES (3) retries from the second connect,
      // NOT double from both loops running in parallel
      expect(wsCloseCount).toBeLessThanOrEqual(3);

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

    it('should use single-tier retry with MAX_WS_RETRIES limit', async () => {
      const terminal = createMockTerminal();
      const onError = vi.fn();

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

      terminalStore.connect(sessionId, terminalId, terminal, onError);

      // Run through all retries (MAX_WS_RETRIES=3 in test mock, delay=100ms)
      // Each attempt: 0ms for WS close + 100ms delay = ~100ms per attempt
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(0);   // WS closes
        await vi.advanceTimersByTimeAsync(100);  // retry delay
      }

      // Should have exactly MAX_WS_RETRIES (3) attempts total
      // (initial + 2 retries, since attemptNumber starts at 1 and retries at attemptNumber < MAX_WS_RETRIES)
      expect(connectAttempts).toBe(3);

      // Should have called onError after exhausting retries
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('Failed to connect'));

      // State should be 'error' (was never connected)
      expect(terminalStore.getConnectionState(sessionId, terminalId)).toBe('error');

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });
  });
});
