import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot } from 'solid-js';
import { useScrollCorrection } from '../../hooks/useScrollCorrection';

const mobileMock = vi.hoisted(() => ({ touch: false, keyboardOpen: false }));
const scrollIntentMock = vi.hoisted(() => ({ recent: false }));

vi.mock('../../lib/mobile', () => ({
  isTouchDevice: () => mobileMock.touch,
  isVirtualKeyboardOpen: () => mobileMock.keyboardOpen,
}));

vi.mock('../../lib/terminal-scroll-intent', () => ({
  hasRecentScrollIntent: vi.fn(() => scrollIntentMock.recent),
  clearScrollIntent: vi.fn(),
}));

function createFakeTerminal() {
  let onScrollHandler: ((ydisp: number) => void) | undefined;
  const terminal = {
    buffer: { active: { baseY: 0, viewportY: 0 } },
    scrollToBottom: vi.fn(() => { terminal.buffer.active.viewportY = terminal.buffer.active.baseY; }),
    scrollLines: vi.fn((delta: number) => { terminal.buffer.active.viewportY += delta; }),
    onScroll: vi.fn((handler: (ydisp: number) => void) => {
      onScrollHandler = handler;
      return { dispose: vi.fn() };
    }),
    emitScroll(ydisp: number, baseY: number) {
      terminal.buffer.active.baseY = baseY;
      terminal.buffer.active.viewportY = ydisp;
      onScrollHandler?.(ydisp);
    },
  };
  return terminal;
}

describe('useScrollCorrection / REQ-TERM-014 terminal scroll anchoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileMock.touch = false;
    mobileMock.keyboardOpen = false;
    scrollIntentMock.recent = false;
  });

  it('REQ-TERM-014: re-anchors a bottom-following terminal when scrollback trimming displaces it', () => {
    createRoot((dispose) => {
      const terminal = createFakeTerminal();
      const container = document.createElement('div');
      useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

      terminal.emitScroll(100, 100);
      terminal.emitScroll(99, 100);

      expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(terminal.buffer.active.viewportY).toBe(100);
      dispose();
    });
  });

  it('REQ-TERM-014: does not override deliberate user scroll gestures', () => {
    createRoot((dispose) => {
      const terminal = createFakeTerminal();
      const container = document.createElement('div');
      useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

      terminal.emitScroll(100, 100);
      container.dispatchEvent(new WheelEvent('wheel'));
      terminal.emitScroll(99, 100);

      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
      expect(terminal.buffer.active.viewportY).toBe(99);
      dispose();
    });
  });

  // ==========================================================================
  // REQ-MOB-012 AC2/AC4: touch-keyboard viewport ownership
  // ==========================================================================
  it('REQ-MOB-012 AC2: freezes correction-owned viewport movement while the touch keyboard is open', () => {
    createRoot((dispose) => {
      mobileMock.touch = true;
      mobileMock.keyboardOpen = true;

      const terminal = createFakeTerminal();
      const container = document.createElement('div');
      useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

      terminal.emitScroll(100, 100);
      terminal.emitScroll(99, 100);

      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
      expect(terminal.scrollLines).not.toHaveBeenCalled();
      dispose();
    });
  });

  it('REQ-MOB-012 AC6: keyboard close hands viewport ownership back to bottom following', () => {
    createRoot((dispose) => {
      mobileMock.touch = true;
      mobileMock.keyboardOpen = true;

      const terminal = createFakeTerminal();
      const container = document.createElement('div');
      useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

      terminal.emitScroll(100, 100);
      terminal.emitScroll(99, 100);
      expect(terminal.scrollToBottom).not.toHaveBeenCalled();

      mobileMock.keyboardOpen = false;
      terminal.emitScroll(98, 100);

      expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(terminal.buffer.active.viewportY).toBe(100);
      dispose();
    });
  });

  it('REQ-MOB-012 AC2: still corrects when keyboard is open but device is NOT touch', () => {
    createRoot((dispose) => {
      mobileMock.touch = false;
      mobileMock.keyboardOpen = true;

      const terminal = createFakeTerminal();
      const container = document.createElement('div');
      useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

      terminal.emitScroll(100, 100);
      terminal.emitScroll(99, 100);

      expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
      dispose();
    });
  });

  // ==========================================================================
  // REQ-MOB-004 AC4 + AC5 / REQ-MOB-012 AC7: persistent manual ownership.
  // ==========================================================================
  it('REQ-TERM-014 AC2: manual scroll ownership persists when output trimming reaches zero', async () => {
    await createRoot(async (dispose) => {
      vi.useFakeTimers();
      try {
        const terminal = createFakeTerminal();
        const container = document.createElement('div');
        useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

        terminal.emitScroll(200, 200);
        container.dispatchEvent(new WheelEvent('wheel'));
        terminal.emitScroll(120, 200);
        vi.advanceTimersByTime(5_000);

        terminal.scrollLines.mockClear();
        terminal.scrollToBottom.mockClear();
        terminal.emitScroll(0, 200);
        await Promise.resolve();

        expect(terminal.scrollLines).not.toHaveBeenCalled();
        expect(terminal.scrollToBottom).not.toHaveBeenCalled();
        expect(terminal.buffer.active.viewportY).toBe(0);
      } finally {
        vi.useRealTimers();
        dispose();
      }
    });
  });

  it('REQ-TERM-014 AC1/AC2: returning to bottom releases manual ownership and restores bottom following', async () => {
    await createRoot(async (dispose) => {
      vi.useFakeTimers();
      try {
        const terminal = createFakeTerminal();
        const container = document.createElement('div');
        useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

        terminal.emitScroll(200, 200);
        container.dispatchEvent(new WheelEvent('wheel'));
        terminal.emitScroll(120, 200);
        vi.advanceTimersByTime(5_000);

        container.dispatchEvent(new WheelEvent('wheel'));
        terminal.emitScroll(200, 200);
        vi.advanceTimersByTime(200);
        terminal.scrollToBottom.mockClear();

        terminal.emitScroll(199, 200);

        expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
        expect(terminal.buffer.active.viewportY).toBe(200);
      } finally {
        vi.useRealTimers();
        dispose();
      }
    });
  });

  it('REQ-MOB-004 AC5: ignores a small trim shift while manual ownership is active', async () => {
    await createRoot(async (dispose) => {
      vi.useFakeTimers();
      try {
        const terminal = createFakeTerminal();
        const container = document.createElement('div');
        useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

        terminal.emitScroll(200, 200);
        container.dispatchEvent(new WheelEvent('wheel'));
        terminal.emitScroll(120, 200);
        vi.advanceTimersByTime(200);

        terminal.scrollLines.mockClear();
        terminal.scrollToBottom.mockClear();

        // Native trimming shifts the surviving content while the user remains
        // the viewport owner; the hook must not inject another scroll.
        terminal.emitScroll(119, 201);

        await Promise.resolve();
        await Promise.resolve();

        expect(terminal.scrollLines).not.toHaveBeenCalled();
        expect(terminal.scrollToBottom).not.toHaveBeenCalled();
        expect(terminal.buffer.active.viewportY).toBe(119);
      } finally {
        vi.useRealTimers();
        dispose();
      }
    });
  });

  it('REQ-MOB-004 AC4/AC5: keeps a shallow manually owned viewport at top when viewed lines age out', async () => {
    await createRoot(async (dispose) => {
      vi.useFakeTimers();
      try {
        const terminal = createFakeTerminal();
        const container = document.createElement('div');
        useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

        terminal.emitScroll(200, 200);
        // Scroll close to the oldest available content, then let output age it
        // out after the gesture-correlation window has elapsed.
        container.dispatchEvent(new WheelEvent('wheel'));
        terminal.emitScroll(10, 200);
        vi.advanceTimersByTime(200);

        terminal.scrollLines.mockClear();
        terminal.scrollToBottom.mockClear();

        terminal.emitScroll(0, 200);

        await Promise.resolve();
        await Promise.resolve();

        expect(terminal.scrollLines).not.toHaveBeenCalled();
        expect(terminal.scrollToBottom).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        dispose();
      }
    });
  });
});
