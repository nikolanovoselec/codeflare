import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';

// Mock constants before importing terminal store
vi.mock('../../lib/constants', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    WS_RETRY_DELAY_MS: 100,
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

describe('Terminal Store', () => {
  const sessionId = 'test-session-123';
  const terminalId = '1';

  // Mock terminal instance
  const createMockTerminal = (): Terminal =>
    ({
      cols: 80,
      rows: 24,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn((_data: string, cb?: () => void) => { if (cb) cb(); }),
      reset: vi.fn(),
      scrollToBottom: vi.fn(),
      refresh: vi.fn(),
      dispose: vi.fn(),
      buffer: { active: { viewportY: 100, baseY: 100 } },
    }) as unknown as Terminal;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Write batching uses setTimeout(cb, 33) for 30fps throttle.
    // Fake timers handle this — tests must advance by ≥33ms to flush writes.
    // Also stub rAF for any remaining callers (ResizeObserver, etc).
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

      // Flush write batch (30fps throttle = 33ms setTimeout)
      await vi.advanceTimersByTimeAsync(50);

      expect(terminal.write).toHaveBeenCalledWith(rawData, expect.any(Function));

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
      expect(terminal.write).toHaveBeenCalledWith(pongMsg, expect.any(Function));

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
      expect(terminal.write).toHaveBeenCalledWith(malformedJson, expect.any(Function));

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
    it('retries with flat 1s delay on abnormal close (never gives up)', async () => {
      const terminal = createMockTerminal();

      const OriginalWebSocket = globalThis.WebSocket;
      const connectTimestamps: number[] = [];

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
          connectTimestamps.push(Date.now());
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

      expect(connectTimestamps.length).toBe(1);

      // Let first attempt fail
      await vi.advanceTimersByTimeAsync(0);

      // Each retry cycle: WS_RETRY_DELAY_MS (100ms mocked) + 1ms close timer
      // Advance through 3 retry cycles
      await vi.advanceTimersByTimeAsync(303);

      // Should have 4 total attempts (1 initial + 3 retries)
      expect(connectTimestamps.length).toBe(4);

      // Verify intervals are constant (flat delay)
      for (let i = 2; i < connectTimestamps.length; i++) {
        const interval = connectTimestamps[i] - connectTimestamps[i - 1];
        expect(interval).toBeLessThanOrEqual(150);
      }

      vi.stubGlobal('WebSocket', OriginalWebSocket);
    });

    it('never gives up retrying on retryable close codes', async () => {
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

      // Run 15 retry cycles — should NOT give up
      for (let i = 0; i < 15; i++) {
        await vi.advanceTimersByTimeAsync(0);   // WS closes
        await vi.advanceTimersByTimeAsync(100);  // WS_RETRY_DELAY_MS (mocked)
      }

      // Should still be retrying — NOT in error state
      const state = terminalStore.getConnectionState(sessionId, terminalId);
      expect(state).toBe('connecting');

      // Should have made more than 10 attempts (proves no limit)
      expect(connectCount).toBeGreaterThan(10);

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
      await vi.advanceTimersByTimeAsync(100);  // WS_RETRY_DELAY_MS (mocked to 100)
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

      // Advance through multiple retry cycles.
      // Retries are unlimited with flat delay. Each cycle is ~101ms
      // (100ms WS_RETRY_DELAY_MS + 1ms for setTimeout(close, 0) resolution
      // in @sinonjs/fake-timers). 500ms / 101ms ≈ 5 closes from a single loop.
      // If the bug existed (both loops running in parallel), we'd see ~10 closes.
      wsCloseCount = 0;
      await vi.advanceTimersByTimeAsync(500);

      // Only ONE retry loop should be active (the second connect's loop).
      // A single loop produces at most floor(500/101)+1 ≈ 5-6 closes.
      // Two parallel loops would produce ~10+. Assert single-loop bound.
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
