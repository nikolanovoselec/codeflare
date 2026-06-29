import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';

// Small connect-timeout so the CONNECTING-freeze watchdog fires under fake
// timers, and a short backoff (deterministic via Math.random=1 in beforeEach:
// reconnectBackoffMs(2) = 100ms).
vi.mock('../../lib/constants', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    WS_RECONNECT_BASE_MS: 50,
    WS_RECONNECT_MAX_MS: 200,
    WS_CONNECT_TIMEOUT_MS: 1000,
  };
});

vi.mock('../../api/client', () => ({
  getTerminalWebSocketUrl: vi.fn(
    (sessionId: string, terminalId: string) =>
      `ws://localhost/api/terminal/${sessionId}-${terminalId}/ws`,
  ),
}));

import { terminalStore, reconnectOnVisibilityReturn } from '../../stores/terminal';

const sessionId = 'test-session-456';
const terminalId = '1';

const createMockTerminal = (): Terminal =>
  ({
    cols: 80,
    rows: 24,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn((_data: string, cb?: () => void) => {
      if (cb) cb();
    }),
    clear: vi.fn(),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
    buffer: { active: { viewportY: 100, baseY: 100 } },
  }) as unknown as Terminal;

// REQ-TERM-003 AC8/AC9: connect-timeout force-close + pause-while-hidden.
describe('Terminal Store / REQ-TERM-003 AC8: connect-timeout force-close & AC9 pause-while-hidden', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1); // pin jitter: backoff(2)=100ms
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    terminalStore.disposeAll();
  });

  // AC8: a socket frozen in CONNECTING (no open/close/error) is force-closed
  // after WS_CONNECT_TIMEOUT_MS, then a backoff reconnect is scheduled.
  it('force-closes a socket stuck in CONNECTING and schedules a backoff reconnect', async () => {
    const OriginalWebSocket = globalThis.WebSocket;
    const sockets: Array<{ readyState: number; close: ReturnType<typeof vi.fn> }> = [];
    let connectCount = 0;

    vi.stubGlobal(
      'WebSocket',
      class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        // Stays CONNECTING forever: never opens, never closes, never errors.
        readyState = 0;
        binaryType = 'arraybuffer';
        onopen: ((e: Event) => void) | null = null;
        onmessage: ((e: MessageEvent) => void) | null = null;
        onclose: ((e: CloseEvent) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        send = vi.fn();
        close = vi.fn(function (this: { readyState: number }) {
          this.readyState = 3;
        });
        constructor(_url: string) {
          connectCount++;
          sockets.push(this as never);
        }
      } as unknown as typeof WebSocket,
    );

    try {
      terminalStore.connect(sessionId, terminalId, createMockTerminal());
      expect(connectCount).toBe(1);
      expect(sockets[0].readyState).toBe(0); // CONNECTING

      // Reach the connect-timeout: the frozen socket is force-closed, no new
      // attempt yet (the reconnect is queued behind the backoff delay).
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets[0].close).toHaveBeenCalled();
      expect(connectCount).toBe(1);

      // Advance the backoff (reconnectBackoffMs(2) = 100ms) — a fresh attempt fires.
      await vi.advanceTimersByTimeAsync(100);
      expect(connectCount).toBe(2);
    } finally {
      vi.stubGlobal('WebSocket', OriginalWebSocket);
    }
  });

  // AC9: while document.hidden, a retryable close schedules NO reconnect; on
  // visibility return the reconnect fires (restarting at attempt 1).
  it('pauses reconnect while hidden and resumes on visibility return', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });

    const OriginalWebSocket = globalThis.WebSocket;
    let connectCount = 0;

    vi.stubGlobal(
      'WebSocket',
      class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = 0;
        binaryType = 'arraybuffer';
        onopen: ((e: Event) => void) | null = null;
        onmessage: ((e: MessageEvent) => void) | null = null;
        onclose: ((e: CloseEvent) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        send = vi.fn();
        constructor(_url: string) {
          connectCount++;
          // Retryable close (1006) on the next tick.
          setTimeout(() => {
            this.readyState = 3;
            this.onclose?.(new CloseEvent('close', { code: 1006 }));
          }, 0);
        }
        close(): void {
          this.readyState = 3;
        }
      } as unknown as typeof WebSocket,
    );

    try {
      terminalStore.connect(sessionId, terminalId, createMockTerminal());
      await vi.advanceTimersByTimeAsync(0); // first socket closes (1006) while hidden
      expect(connectCount).toBe(1);

      // Hidden: NO reconnect is scheduled even past the backoff delay.
      await vi.advanceTimersByTimeAsync(300);
      expect(connectCount).toBe(1);
      expect(terminalStore.getConnectionState(sessionId, terminalId)).toBe('connecting');

      // Visibility return: flip hidden=false and run the return handler — a fresh
      // attempt is created synchronously (no advance needed).
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      reconnectOnVisibilityReturn(undefined, [`${sessionId}:${terminalId}`]);
      expect(connectCount).toBe(2);
    } finally {
      delete (document as { hidden?: unknown }).hidden;
      vi.stubGlobal('WebSocket', OriginalWebSocket);
    }
  });
});
