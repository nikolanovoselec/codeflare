import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';

vi.mock('../../lib/constants', async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  WS_RECONNECT_BASE_MS: 50,
  WS_RECONNECT_MAX_MS: 200,
  WS_CONNECT_TIMEOUT_MS: 1_000_000,
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { getTerminalWebSocketUrl: actual.getTerminalWebSocketUrl };
});

import { terminalStore, parseControlMessage } from '../../stores/terminal';

const SESSION_ID = 'sessabc12345';
const TERMINAL_ID = '1';

const createMockTerminal = (): Terminal => ({
  cols: 80,
  rows: 24,
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn((_data: string, cb?: () => void) => cb?.()),
  clear: vi.fn(),
  reset: vi.fn(),
  scrollToBottom: vi.fn(),
  refresh: vi.fn(),
  dispose: vi.fn(),
  buffer: { active: { viewportY: 100, baseY: 100 } },
}) as unknown as Terminal;

function installCapturingWebSocket() {
  const created: Array<{ url: string }> = [];
  vi.stubGlobal('WebSocket', class {
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
      created.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.(new Event('open'));
      }, 0);
    }
    close(): void { this.readyState = 3; }
  } as unknown as typeof WebSocket);
  return created;
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

  it('connects only the stable internal terminal 1 path without a manual-tab query', async () => {
    const sockets = installCapturingWebSocket();
    terminalStore.connect(SESSION_ID, TERMINAL_ID, createMockTerminal());
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    const built = new URL(sockets[0].url);
    expect(built.pathname).toBe(`/api/terminal/${SESSION_ID}-1/ws`);
    expect(built.search).toBe('');
  });

  it('keeps restore controls and raw PTY bytes distinct', () => {
    expect(parseControlMessage(JSON.stringify({ type: 'restore', state: 'screen' })))
      .toEqual({ kind: 'restore', state: 'screen' });
    expect(parseControlMessage(JSON.stringify({ type: 'process-name', processName: 'herdr' })))
      .toEqual({ kind: 'process-name' });
    expect(parseControlMessage('\x1b[32mHello\x1b[0m\r\n')).toEqual({ kind: 'raw' });
    expect(parseControlMessage('{"processName":"claude","type":"process-name"}')).toEqual({ kind: 'raw' });
    expect(parseControlMessage('{"type": not-json')).toEqual({ kind: 'raw' });
  });
});
