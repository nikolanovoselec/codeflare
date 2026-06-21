import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';

// Mock constants but keep real values (the real getTerminalWebSocketUrl reads
// MAX_TERMINALS_PER_SESSION from here). Shorten the retry delay like the
// sibling terminal.test.ts so fake-timer advances stay small.
vi.mock('../../lib/constants', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    WS_RETRY_DELAY_MS: 100,
  };
});

// AC2 requires asserting the *actual* WS URL string built. Delegate to the
// real getTerminalWebSocketUrl so connect()'s manual flag flows through the
// genuine URL builder (which appends ?manual=1). If connect() stopped passing
// `manual`, the real builder would omit the param and the AC2 tests would fail.
vi.mock('../../api/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { getTerminalWebSocketUrl: actual.getTerminalWebSocketUrl };
});

import {
  terminalStore,
  registerProcessNameCallback,
  parseControlMessage,
} from '../../stores/terminal';

const SESSION_ID = 'sessabc12345'; // matches SESSION_ID_RE /^[a-z0-9]{8,24}$/
const TERMINAL_ID = '1';

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

type CapturedSocket = {
  url: string;
  onmessage: ((event: MessageEvent) => void) | null;
  emitMessage: (data: string | ArrayBuffer) => void;
};

/** Capturing WebSocket mock — records the constructor URL and exposes onmessage. */
function installCapturingWebSocket() {
  const created: CapturedSocket[] = [];

  const OriginalWebSocket = globalThis.WebSocket;
  vi.stubGlobal(
    'WebSocket',
    class {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      url: string;
      binaryType = 'arraybuffer';
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      send = vi.fn();
      constructor(url: string) {
        this.url = url;
        (this as unknown as CapturedSocket).emitMessage = (data: string | ArrayBuffer) =>
          this.onmessage?.(new MessageEvent('message', { data }));
        created.push(this as unknown as CapturedSocket);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event('open'));
        }, 0);
      }
      close(): void {
        this.readyState = 3;
      }
    } as unknown as typeof WebSocket,
  );

  return { created, restore: () => vi.stubGlobal('WebSocket', OriginalWebSocket) };
}

describe('Terminal control-message handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    terminalStore.disposeAll();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ── REQ-TERM-006 AC2: manual flag propagated as ?manual=1 on the WS URL ─────
  describe('REQ-TERM-006 AC2: connect() propagates the manual flag onto the WebSocket URL', () => {
    it('REQ-TERM-006 AC2: appends manual=1 to the WS URL for a manual terminal', async () => {
      const ws = installCapturingWebSocket();
      try {
        // connect signature: (sessionId, terminalId, terminal, onError?, manual?)
        terminalStore.connect(SESSION_ID, TERMINAL_ID, createMockTerminal(), undefined, true);
        await vi.advanceTimersByTimeAsync(0);

        expect(ws.created).toHaveLength(1);
        const built = new URL(ws.created[0].url);
        expect(built.searchParams.get('manual')).toBe('1');
        expect(built.pathname).toBe(`/api/terminal/${SESSION_ID}-${TERMINAL_ID}/ws`);
      } finally {
        ws.restore();
      }
    });

    it('REQ-TERM-006 AC2: omits the manual param for a non-manual terminal', async () => {
      const ws = installCapturingWebSocket();
      try {
        terminalStore.connect(SESSION_ID, TERMINAL_ID, createMockTerminal(), undefined, false);
        await vi.advanceTimersByTimeAsync(0);

        expect(ws.created).toHaveLength(1);
        const built = new URL(ws.created[0].url);
        expect(built.searchParams.has('manual')).toBe(false);
      } finally {
        ws.restore();
      }
    });

    it('REQ-TERM-006 AC2: omits the manual param when the flag is not supplied', async () => {
      const ws = installCapturingWebSocket();
      try {
        terminalStore.connect(SESSION_ID, TERMINAL_ID, createMockTerminal());
        await vi.advanceTimersByTimeAsync(0);

        const built = new URL(ws.created[0].url);
        expect(built.searchParams.has('manual')).toBe(false);
      } finally {
        ws.restore();
      }
    });
  });

  // ── REQ-TERM-009 AC2: type-discriminator routing of control vs raw frames ───
  describe('REQ-TERM-009 AC2: parseControlMessage discriminates frames by leading type field', () => {
    it('REQ-TERM-009 AC2: routes a process-name frame to the process-name kind', () => {
      const result = parseControlMessage(JSON.stringify({ type: 'process-name', processName: 'claude' }));
      expect(result).toEqual({ kind: 'process-name', processName: 'claude' });
    });

    it('REQ-TERM-009 AC2: routes a restore frame (with state) to the restore kind', () => {
      const result = parseControlMessage(JSON.stringify({ type: 'restore', state: 'htop output' }));
      expect(result).toEqual({ kind: 'restore', state: 'htop output' });
    });

    it('REQ-TERM-009 AC2: treats raw PTY bytes as raw, not a control message', () => {
      const result = parseControlMessage('\x1b[32mHello World\x1b[0m\r\n');
      expect(result).toEqual({ kind: 'raw' });
    });

    it('REQ-TERM-009 AC2: a JSON object without a leading type discriminator is raw', () => {
      // Does not start with {"type": — must never be parsed as a control message.
      const result = parseControlMessage('{"processName":"claude","type":"process-name"}');
      expect(result).toEqual({ kind: 'raw' });
    });

    it('REQ-TERM-009 AC2: malformed JSON starting with {"type": does not crash and falls back to raw', () => {
      const result = parseControlMessage('{"type": not valid json at all');
      expect(result).toEqual({ kind: 'raw' });
    });

    it('REQ-TERM-009 AC2: an unknown control type (e.g. pong) is treated as raw', () => {
      const result = parseControlMessage(JSON.stringify({ type: 'pong' }));
      expect(result).toEqual({ kind: 'raw' });
    });

    it('REQ-TERM-009 AC2: a process-name frame missing processName is raw', () => {
      const result = parseControlMessage(JSON.stringify({ type: 'process-name' }));
      expect(result).toEqual({ kind: 'raw' });
    });
  });

  // ── REQ-TERM-009 AC6: registered callback is invoked on a process-name frame ─
  describe('REQ-TERM-009 AC6: registerProcessNameCallback routes process-name frames to the callback', () => {
    it('REQ-TERM-009 AC6: a dispatched process-name frame invokes the registered callback with the parsed name', async () => {
      const callback = vi.fn();
      registerProcessNameCallback(callback);

      const ws = installCapturingWebSocket();
      try {
        terminalStore.connect(SESSION_ID, TERMINAL_ID, createMockTerminal(), undefined, true);
        await vi.advanceTimersByTimeAsync(0); // open the socket

        ws.created[0].emitMessage(JSON.stringify({ type: 'process-name', processName: 'codex' }));

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(SESSION_ID, TERMINAL_ID, 'codex');
      } finally {
        ws.restore();
      }
    });

    it('REQ-TERM-009 AC6: raw terminal output does not invoke the process-name callback', async () => {
      const callback = vi.fn();
      registerProcessNameCallback(callback);

      const ws = installCapturingWebSocket();
      try {
        terminalStore.connect(SESSION_ID, TERMINAL_ID, createMockTerminal(), undefined, true);
        await vi.advanceTimersByTimeAsync(0);

        ws.created[0].emitMessage('plain shell output\r\n');
        await vi.advanceTimersByTimeAsync(50); // allow any write-batch flush

        expect(callback).not.toHaveBeenCalled();
      } finally {
        ws.restore();
      }
    });
  });
});
