import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FitAddon } from '@xterm/addon-fit';

// Mock constants before importing
vi.mock('../../lib/constants', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    CSS_TRANSITION_DELAY_MS: 10,
  };
});

// Mock API client
vi.mock('../../api/client', () => ({
  getTerminalWebSocketUrl: vi.fn(),
}));

// Import after mocks
import type { Terminal } from '@xterm/xterm';
import {
  registerFitAddon,
  unregisterFitAddon,
  triggerLayoutResize,
  getLayoutChangeCounter,
  registerLayoutDeps,
  refitAllTerminalsExported,
} from '../../stores/terminal-layout';

describe('terminal-layout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggerLayoutResize increments layout change counter', () => {
    const before = getLayoutChangeCounter();
    triggerLayoutResize();
    expect(getLayoutChangeCounter()).toBe(before + 1);
  });

  it('registerFitAddon/unregisterFitAddon manages addon map', () => {
    const mockFitAddon = { fit: vi.fn() } as unknown as FitAddon;

    // Should not throw
    expect(() => {
      registerFitAddon('session-1', '1', mockFitAddon);
    }).not.toThrow();

    expect(() => {
      unregisterFitAddon('session-1', '1');
    }).not.toThrow();
  });

  // ==========================================================================
  // REQ-MOB-010 AC6: a refit that produces unchanged dimensions must NOT send a
  // resize message to the PTY. Driven through the real refit code path with a
  // terminal + connection injected via registerLayoutDeps.
  // ==========================================================================
  describe('REQ-MOB-010 AC6: unchanged-dimensions skip resize message', () => {
    const KEY = 'sess-mob010:term-1';

    function makeTerminal(cols: number, rows: number): { terminal: Terminal; scrollToBottom: ReturnType<typeof vi.fn> } {
      const scrollToBottom = vi.fn();
      const terminal = {
        cols,
        rows,
        buffer: { active: { viewportY: 100, baseY: 100 } },
        scrollToBottom,
      } as unknown as Terminal;
      return { terminal, scrollToBottom };
    }

    afterEach(() => {
      // Reset injected deps so other tests in the file see empty maps.
      registerLayoutDeps(() => new Map(), () => new Map());
      unregisterFitAddon('sess-mob010', 'term-1');
    });

    it('does NOT send a resize message when fit() leaves cols/rows unchanged', () => {
      const { terminal } = makeTerminal(80, 24);
      // fit() runs but dimensions stay identical.
      const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
      const send = vi.fn();
      const ws = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;

      registerLayoutDeps(
        () => new Map([[KEY, terminal]]),
        () => new Map([[KEY, ws]]),
      );
      registerFitAddon('sess-mob010', 'term-1', fitAddon);

      refitAllTerminalsExported();

      expect(fitAddon.fit).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    });

    it('DOES send a resize message when fit() changes cols/rows (positive control)', () => {
      const { terminal } = makeTerminal(80, 24);
      // fit() mutates the terminal dimensions, simulating a real layout change.
      const fitAddon = {
        fit: vi.fn(() => {
          (terminal as { cols: number }).cols = 120;
          (terminal as { rows: number }).rows = 40;
        }),
      } as unknown as FitAddon;
      const send = vi.fn();
      const ws = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;

      registerLayoutDeps(
        () => new Map([[KEY, terminal]]),
        () => new Map([[KEY, ws]]),
      );
      registerFitAddon('sess-mob010', 'term-1', fitAddon);

      refitAllTerminalsExported();

      expect(send).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(send.mock.calls[0][0] as string);
      expect(payload).toEqual({ type: 'resize', cols: 120, rows: 40 });
    });

    it('does NOT send a resize message when the socket is not OPEN, even if dimensions changed', () => {
      const { terminal } = makeTerminal(80, 24);
      const fitAddon = {
        fit: vi.fn(() => {
          (terminal as { cols: number }).cols = 100;
        }),
      } as unknown as FitAddon;
      const send = vi.fn();
      const ws = { readyState: WebSocket.CLOSED, send } as unknown as WebSocket;

      registerLayoutDeps(
        () => new Map([[KEY, terminal]]),
        () => new Map([[KEY, ws]]),
      );
      registerFitAddon('sess-mob010', 'term-1', fitAddon);

      refitAllTerminalsExported();

      expect(fitAddon.fit).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    });
  });
});
