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

describe('useScrollCorrection / REQ-TERM-014 terminal scroll anchoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalStoreMock.suppressed = false;
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
  // REQ-MOB-012 AC2: keyboard-open detector skip
  // ==========================================================================
  it('REQ-MOB-012 AC2: suppresses the Strategy-2 reset-restore when touch + keyboard are open', async () => {
    await createRoot(async (dispose) => {
      vi.useFakeTimers();
      try {
        mobileMock.touch = true;
        mobileMock.keyboardOpen = true;

        const terminal = createFakeTerminal();
        const container = document.createElement('div');
        useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

        // Reproduce the exact focus-reset sequence that Strategy 2 restores in the
        // REQ-MOB-004 AC4 test (sit at bottom, scroll up with intent, let the grace
        // window lapse, then viewport snaps to 0). The keyboard-open gate runs after
        // Strategy 1 and before Strategy 2, so the restore must NOT happen here.
        terminal.emitScroll(200, 200);
        container.dispatchEvent(new WheelEvent('wheel'));
        terminal.emitScroll(120, 200);
        vi.advanceTimersByTime(200);

        terminal.scrollLines.mockClear();
        terminal.scrollToBottom.mockClear();
        terminal.emitScroll(0, 200);
        await Promise.resolve();
        await Promise.resolve();

        // Gut-check: remove the `isTouchDevice() && isVirtualKeyboardOpen()` gate and
        // Strategy 2 fires scrollLines(120) (exactly as the AC4 test asserts) -> this fails.
        expect(terminal.scrollLines).not.toHaveBeenCalled();
        expect(terminal.scrollToBottom).not.toHaveBeenCalled();
        expect(terminal.buffer.active.viewportY).toBe(0);
      } finally {
        vi.useRealTimers();
        dispose();
      }
    });
  });

  it('REQ-MOB-012 AC2: still corrects when keyboard is open but device is NOT touch (gate is touch AND keyboard)', () => {
    createRoot((dispose) => {
      // The production gate is `isTouchDevice() && isVirtualKeyboardOpen()`.
      // A desktop browser reporting keyboardOpen=true must NOT disable Strategy 1.
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
  // REQ-MOB-012 AC1: suppression marker is consumed by the detector
  // ==========================================================================
  it('REQ-MOB-012 AC1: skips correction while the programmatic-scroll suppression marker is set', () => {
    createRoot((dispose) => {
      terminalStoreMock.suppressed = true;

      const terminal = createFakeTerminal();
      const container = document.createElement('div');
      useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

      // A drop that would normally re-anchor (Strategy 1) must be ignored while
      // suppression is active, so our own post-write corrections cannot feed back.
      terminal.emitScroll(100, 100);
      terminal.emitScroll(50, 100);

      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
      expect(terminal.buffer.active.viewportY).toBe(50);

      // Once suppression clears, the detector re-anchors a following user again.
      terminalStoreMock.suppressed = false;
      terminal.emitScroll(100, 100);
      terminal.emitScroll(99, 100);
      expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
      dispose();
    });
  });

  // ==========================================================================
  // REQ-MOB-004 AC4 + AC5 / REQ-MOB-012 AC4: distance-based reset detection
  // (Strategy 2) restores a scrolled-up user's relative position.
  // ==========================================================================
  it('REQ-MOB-004 AC4 + REQ-MOB-012 AC4: restores a scrolled-up user after a browser focus reset snaps viewport to 0', async () => {
    await createRoot(async (dispose) => {
      vi.useFakeTimers();
      try {
        const terminal = createFakeTerminal();
        const container = document.createElement('div');
        useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

        // 1. Sit at the bottom of a tall buffer (no Strategy 1 — ydisp >= baseY).
        terminal.emitScroll(200, 200);

        // 2. User scrolls up. A wheel gesture marks intent so Strategy 1 does
        //    NOT yank them back to the bottom; this leaves wasFollowing=false
        //    and records previousYdisp=120, previousDistFromBottom=80.
        container.dispatchEvent(new WheelEvent('wheel'));
        terminal.emitScroll(120, 200);
        expect(terminal.scrollToBottom).not.toHaveBeenCalled();

        // 3. Let the user-intent grace window (150ms) lapse so the next event is
        //    treated as a browser reset rather than a user gesture.
        vi.advanceTimersByTime(200);

        // 4. Browser focus-validation bug: viewportY snaps to 0 while baseY
        //    stays high. distanceDrift jumps from 80 to 200 (>20) → suspicious.
        terminal.scrollLines.mockClear();
        terminal.emitScroll(0, 200);

        // Strategy 2 schedules the restore in a microtask.
        await Promise.resolve();
        await Promise.resolve();

        // restoreDistance = previousDistFromBottom = 80, targetY = 200-80 = 120,
        // delta = 120 - 0 = 120 → scrollLines(120) puts the user back where
        // they were relative to the bottom.
        expect(terminal.scrollLines).toHaveBeenCalledWith(120);
        expect(terminal.buffer.active.viewportY).toBe(120);
      } finally {
        vi.useRealTimers();
        dispose();
      }
    });
  });

  it('REQ-MOB-004 AC5: ignores a small distance drift (normal scrollback trimming, not a reset)', async () => {
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

        // viewportY is NOT 0 here (just a ~2-line trim drift): the five-gate
        // suspiciousReset requires ydisp === 0, so distance-based detection
        // must NOT fire. Small drifts are normal trimming, not a focus reset.
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

  it('REQ-MOB-004 AC5: does not treat a shallow previous position (previousYdisp <= 20) as a reset', async () => {
    await createRoot(async (dispose) => {
      vi.useFakeTimers();
      try {
        const terminal = createFakeTerminal();
        const container = document.createElement('div');
        useScrollCorrection(terminal as any, container, { sessionId: 's1', terminalId: '1' });

        terminal.emitScroll(200, 200);
        // Scroll up to a position very close to the top of the buffer window
        // (previousYdisp = 10, which fails the `previousYdisp > 20` gate).
        container.dispatchEvent(new WheelEvent('wheel'));
        terminal.emitScroll(10, 200);
        vi.advanceTimersByTime(200);

        terminal.scrollLines.mockClear();
        terminal.scrollToBottom.mockClear();

        // viewportY drops to 0 with high baseY and big drift, but previousYdisp
        // was only 10 → the gate `previousYdisp > 20` blocks the false positive.
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
