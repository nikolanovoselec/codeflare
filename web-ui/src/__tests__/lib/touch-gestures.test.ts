import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachSwipeGestures, sendTerminalKey } from '../../lib/touch-gestures';
import type { Terminal } from '@xterm/xterm';

// Helper: create a mock Terminal with the internal triggerDataEvent path
function createMockTerminal() {
  const triggerDataEvent = vi.fn();
  const scrollLines = vi.fn();
  const terminal = {
    _core: {
      coreService: {
        triggerDataEvent,
      },
    },
    options: { fontSize: 14, lineHeight: 1.2 },
    scrollLines,
  } as unknown as Terminal;
  return { terminal, triggerDataEvent, scrollLines };
}

// Helper: create a minimal TouchEvent
function makeTouchEvent(
  type: string,
  clientX: number,
  clientY: number,
  options?: { cancelable?: boolean },
): TouchEvent {
  const touch = { clientX, clientY, identifier: 0, target: document.body } as unknown as Touch;
  const event = new TouchEvent(type, {
    touches: type === 'touchend' ? [] : [touch],
    cancelable: options?.cancelable ?? true,
    bubbles: true,
  });
  return event;
}

describe('touch-gestures / REQ-MOB-005 (swipe gestures arrow keys/scroll)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.restoreAllMocks();
    vi.useRealTimers();
    // Remove ontouchstart if set
    delete (window as any).ontouchstart;
  });

  describe('sendTerminalKey', () => {
    it('should call triggerDataEvent with the sequence', () => {
      const { terminal, triggerDataEvent } = createMockTerminal();
      sendTerminalKey(terminal, '\x1b[D');
      expect(triggerDataEvent).toHaveBeenCalledWith('\x1b[D', false);
    });

    it('should not throw if coreService is missing', () => {
      const terminal = { _core: {} } as unknown as Terminal;
      expect(() => sendTerminalKey(terminal, '\x1b[D')).not.toThrow();
    });
  });

  describe('attachSwipeGestures', () => {
    describe('touch support detection', () => {
      it('should return undefined when touch is not supported', () => {
        // ontouchstart not in window by default in jsdom
        const { terminal } = createMockTerminal();
        const result = attachSwipeGestures(container, terminal);
        expect(result).toBeUndefined();
      });

      it('should return a cleanup function when touch is supported', () => {
        (window as any).ontouchstart = null;
        const { terminal } = createMockTerminal();
        const cleanup = attachSwipeGestures(container, terminal);
        expect(cleanup).toBeTypeOf('function');
        cleanup!();
      });
    });

    describe('horizontal swipe', () => {
      it('should send left arrow on leftward swipe exceeding threshold', () => {
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const cleanup = attachSwipeGestures(container, terminal)!;

        // touchstart at (100, 100)
        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        // touchmove to (70, 100) — dx = -30, exceeds 20px threshold
        container.dispatchEvent(makeTouchEvent('touchmove', 70, 100));

        expect(triggerDataEvent).toHaveBeenCalledWith('\x1b[D', false);
        cleanup();
      });

      it('should send right arrow on rightward swipe exceeding threshold', () => {
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const cleanup = attachSwipeGestures(container, terminal)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        container.dispatchEvent(makeTouchEvent('touchmove', 130, 100));

        expect(triggerDataEvent).toHaveBeenCalledWith('\x1b[C', false);
        cleanup();
      });

      it('should not send key when movement is below threshold', () => {
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const cleanup = attachSwipeGestures(container, terminal)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        container.dispatchEvent(makeTouchEvent('touchmove', 115, 100)); // dx=15, below 20

        expect(triggerDataEvent).not.toHaveBeenCalled();
        cleanup();
      });
    });

    describe('vertical swipe with keyboard closed (scroll mode)', () => {
      it('should call scrollLines on vertical swipe when keyboard is closed', () => {
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent, scrollLines } = createMockTerminal();
        const isKeyboardOpen = vi.fn(() => false);
        const cleanup = attachSwipeGestures(container, terminal, isKeyboardOpen)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        // dy=-40 exceeds threshold, enters scroll mode, pre-seeds accumulator
        // 40px / 17px-per-line = 2 lines scrolled immediately
        container.dispatchEvent(makeTouchEvent('touchmove', 100, 60, { cancelable: true }));

        // Should NOT send arrow keys — this is scroll, not key mode
        expect(triggerDataEvent).not.toHaveBeenCalled();
        // Should have scrolled the terminal buffer
        expect(scrollLines).toHaveBeenCalledWith(2);
        cleanup();
      });

      it('should call preventDefault in scroll mode', () => {
        (window as any).ontouchstart = null;
        const { terminal } = createMockTerminal();
        const isKeyboardOpen = vi.fn(() => false);
        const cleanup = attachSwipeGestures(container, terminal, isKeyboardOpen)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));

        // First move enters scroll mode
        const enterEvent = makeTouchEvent('touchmove', 100, 60, { cancelable: true });
        const enterSpy = vi.spyOn(enterEvent, 'preventDefault');
        container.dispatchEvent(enterEvent);
        expect(enterSpy).toHaveBeenCalled();

        // Subsequent moves also preventDefault
        const scrollEvent = makeTouchEvent('touchmove', 100, 35, { cancelable: true });
        const scrollSpy = vi.spyOn(scrollEvent, 'preventDefault');
        container.dispatchEvent(scrollEvent);
        expect(scrollSpy).toHaveBeenCalled();

        cleanup();
      });

      it('should scroll proportionally to finger movement including threshold distance', () => {
        (window as any).ontouchstart = null;
        const { terminal, scrollLines } = createMockTerminal();
        const isKeyboardOpen = vi.fn(() => false);
        const cleanup = attachSwipeGestures(container, terminal, isKeyboardOpen)!;

        // fontSize=14, lineHeight=1.2 → scrollPxPerLine=17 (from mock terminal defaults)
        // Start at y=200
        container.dispatchEvent(makeTouchEvent('touchstart', 100, 200));
        // Move to y=160 (dy=40, enters scroll mode; pre-seeds accumulator with 40px)
        // 40/17 = 2 lines scrolled immediately
        container.dispatchEvent(makeTouchEvent('touchmove', 100, 160));
        expect(scrollLines).toHaveBeenCalledWith(2);

        // Move another 34px up (y=126) → deltaY=34, accumulator = (40 - 2*17) + 34 = 40
        // 40/17 = 2 more lines
        container.dispatchEvent(makeTouchEvent('touchmove', 100, 126));
        expect(scrollLines).toHaveBeenCalledWith(2);

        cleanup();
      });
    });

    describe('vertical swipe with keyboard open', () => {
      it('should call preventDefault and send up arrow', () => {
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const isKeyboardOpen = vi.fn(() => true);
        const cleanup = attachSwipeGestures(container, terminal, isKeyboardOpen)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));

        const moveEvent = makeTouchEvent('touchmove', 100, 60, { cancelable: true });
        const preventDefaultSpy = vi.spyOn(moveEvent, 'preventDefault');
        container.dispatchEvent(moveEvent);

        expect(preventDefaultSpy).toHaveBeenCalled();
        // dy = -40, upward swipe → up arrow
        expect(triggerDataEvent).toHaveBeenCalledWith('\x1b[A', false);
        cleanup();
      });

      it('should send down arrow on downward swipe', () => {
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const isKeyboardOpen = vi.fn(() => true);
        const cleanup = attachSwipeGestures(container, terminal, isKeyboardOpen)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        container.dispatchEvent(makeTouchEvent('touchmove', 100, 140));

        expect(triggerDataEvent).toHaveBeenCalledWith('\x1b[B', false);
        cleanup();
      });
    });

    describe('direction lock ratio', () => {
      it('should not lock direction when neither axis dominates by 1.5x', () => {
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const isKeyboardOpen = vi.fn(() => true);
        const cleanup = attachSwipeGestures(container, terminal, isKeyboardOpen)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        // dx=25, dy=20 — ratio 25/20 = 1.25 < 1.5, neither dominates
        container.dispatchEvent(makeTouchEvent('touchmove', 125, 120));

        expect(triggerDataEvent).not.toHaveBeenCalled();
        cleanup();
      });

      it('should lock direction when one axis dominates by 1.5x', () => {
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const cleanup = attachSwipeGestures(container, terminal)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        // dx=30, dy=15 — ratio 30/15 = 2.0 > 1.5, horizontal dominates
        container.dispatchEvent(makeTouchEvent('touchmove', 130, 115));

        expect(triggerDataEvent).toHaveBeenCalledWith('\x1b[C', false);
        cleanup();
      });
    });

    describe('long press cancels gesture', () => {
      it('should not fire keys after long press timeout', () => {
        vi.useFakeTimers();
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const cleanup = attachSwipeGestures(container, terminal)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));

        // Advance past LONG_PRESS_MS (500ms)
        vi.advanceTimersByTime(600);

        // Now swipe — should be cancelled
        container.dispatchEvent(makeTouchEvent('touchmove', 70, 100));

        expect(triggerDataEvent).not.toHaveBeenCalled();
        cleanup();
      });

      it('should fire keys before long press timeout', () => {
        vi.useFakeTimers();
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const cleanup = attachSwipeGestures(container, terminal)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));

        // Swipe before long press fires
        vi.advanceTimersByTime(100);
        container.dispatchEvent(makeTouchEvent('touchmove', 70, 100));

        expect(triggerDataEvent).toHaveBeenCalledWith('\x1b[D', false);
        cleanup();
      });
    });

    describe('horizontal swipe auto-repeat', () => {
      it('should fire repeated keys via setInterval for horizontal swipe', () => {
        vi.useFakeTimers();
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const cleanup = attachSwipeGestures(container, terminal)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        container.dispatchEvent(makeTouchEvent('touchmove', 70, 100));

        // First call is the initial sendKey
        expect(triggerDataEvent).toHaveBeenCalledTimes(1);

        // Advance 80ms (REPEAT_INTERVAL) — should fire again
        vi.advanceTimersByTime(80);
        expect(triggerDataEvent).toHaveBeenCalledTimes(2);

        // Another interval
        vi.advanceTimersByTime(80);
        expect(triggerDataEvent).toHaveBeenCalledTimes(3);

        cleanup();
      });

      it('should NOT auto-repeat for vertical swipes', () => {
        vi.useFakeTimers();
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const isKeyboardOpen = vi.fn(() => true);
        const cleanup = attachSwipeGestures(container, terminal, isKeyboardOpen)!;

        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        container.dispatchEvent(makeTouchEvent('touchmove', 100, 60));

        expect(triggerDataEvent).toHaveBeenCalledTimes(1);

        // Advance several intervals — should stay at 1
        vi.advanceTimersByTime(400);
        expect(triggerDataEvent).toHaveBeenCalledTimes(1);

        cleanup();
      });
    });

    describe('cleanup removes listeners', () => {
      it('should remove all event listeners on cleanup', () => {
        (window as any).ontouchstart = null;
        const { terminal } = createMockTerminal();
        const removeEventSpy = vi.spyOn(container, 'removeEventListener');
        const cleanup = attachSwipeGestures(container, terminal)!;

        cleanup();

        expect(removeEventSpy).toHaveBeenCalledWith(
          'touchstart',
          expect.any(Function),
          expect.objectContaining({ capture: true }),
        );
        expect(removeEventSpy).toHaveBeenCalledWith(
          'touchmove',
          expect.any(Function),
          expect.objectContaining({ capture: true }),
        );
        expect(removeEventSpy).toHaveBeenCalledWith(
          'touchend',
          expect.any(Function),
          expect.objectContaining({ capture: true }),
        );
        expect(removeEventSpy).toHaveBeenCalledWith(
          'touchcancel',
          expect.any(Function),
          expect.objectContaining({ capture: true }),
        );
      });

      it('should not fire keys after cleanup', () => {
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const cleanup = attachSwipeGestures(container, terminal)!;

        cleanup();

        // These events should have no effect after cleanup
        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        container.dispatchEvent(makeTouchEvent('touchmove', 70, 100));

        expect(triggerDataEvent).not.toHaveBeenCalled();
      });
    });

    describe('multi-touch cancellation', () => {
      it('should cancel gesture when multiple touches detected on start', () => {
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const cleanup = attachSwipeGestures(container, terminal)!;

        // Simulate multi-touch (2 fingers)
        const multiTouchEvent = new TouchEvent('touchstart', {
          touches: [
            { clientX: 100, clientY: 100, identifier: 0, target: document.body } as unknown as Touch,
            { clientX: 200, clientY: 200, identifier: 1, target: document.body } as unknown as Touch,
          ],
          bubbles: true,
        });
        container.dispatchEvent(multiTouchEvent);

        // Subsequent move should be ignored
        container.dispatchEvent(makeTouchEvent('touchmove', 70, 100));

        expect(triggerDataEvent).not.toHaveBeenCalled();
        cleanup();
      });
    });

    describe('touchend resets state', () => {
      it('should allow new gesture after touchend', () => {
        (window as any).ontouchstart = null;
        const { terminal, triggerDataEvent } = createMockTerminal();
        const cleanup = attachSwipeGestures(container, terminal)!;

        // First gesture
        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        container.dispatchEvent(makeTouchEvent('touchmove', 70, 100));
        expect(triggerDataEvent).toHaveBeenCalledTimes(1);

        // End gesture
        container.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));

        // New gesture in opposite direction
        container.dispatchEvent(makeTouchEvent('touchstart', 100, 100));
        container.dispatchEvent(makeTouchEvent('touchmove', 130, 100));
        expect(triggerDataEvent).toHaveBeenCalledTimes(2);
        expect(triggerDataEvent).toHaveBeenLastCalledWith('\x1b[C', false);

        cleanup();
      });
    });
  });
});
