import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot } from 'solid-js';
import { useScrollCorrection } from '../../hooks/useScrollCorrection';

const terminalStoreMock = vi.hoisted(() => ({ suppressed: false }));
const mobileMock = vi.hoisted(() => ({ touch: false, keyboardOpen: false }));
const scrollIntentMock = vi.hoisted(() => ({ recent: false }));

vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    isProgrammaticScrollSuppressed: vi.fn(() => terminalStoreMock.suppressed),
  },
}));

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

describe('useScrollCorrection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalStoreMock.suppressed = false;
    mobileMock.touch = false;
    mobileMock.keyboardOpen = false;
    scrollIntentMock.recent = false;
  });

  it('re-anchors a bottom-following terminal when scrollback trimming displaces it', () => {
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

  it('does not override deliberate user scroll gestures', () => {
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
});
