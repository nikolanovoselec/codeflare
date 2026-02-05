import type { Terminal } from '@xterm/xterm';

// --- Tuning constants ---
const SWIPE_THRESHOLD = 20; // px minimum delta to qualify as a swipe
const LONG_PRESS_MS = 500; // after this delay, yield to browser text-selection
const REPEAT_INTERVAL = 80; // ms between repeated key sends while finger held
const DIRECTION_LOCK_RATIO = 1.5; // one axis must exceed the other by this factor

// ANSI escape sequences for arrow keys.
// Horizontal swipes always active; vertical swipes only when keyboard is open
// (to avoid conflicting with native terminal scrolling).
const ARROW: Record<string, string> = {
  left: '\x1b[D',
  right: '\x1b[C',
  up: '\x1b[A',
  down: '\x1b[B',
};

type Direction = 'left' | 'right' | 'up' | 'down';

/**
 * Send an escape sequence to the terminal as keyboard input (not paste).
 * Using paste() wraps data in bracketed paste markers, causing shells to
 * treat escape sequences as literal text. The internal triggerDataEvent
 * bypasses this and sends raw key data.
 */
export function sendTerminalKey(terminal: Terminal, sequence: string): void {
  const core = (terminal as any)._core;
  if (core?.coreService?.triggerDataEvent) {
    core.coreService.triggerDataEvent(sequence, false);
  }
}

/**
 * Attach swipe-to-arrow-key gestures to a terminal container.
 * Horizontal swipes (left/right) always map to arrow left/right.
 * Vertical swipes (up/down) map to arrow up/down only when keyboard is open
 * (when keyboard is closed, vertical scrolling uses native xterm behavior).
 * Returns a cleanup function, or undefined if touch is not supported.
 */
export function attachSwipeGestures(
  container: HTMLElement,
  terminal: Terminal,
  isKeyboardOpen?: () => boolean,
): (() => void) | undefined {
  if (typeof window === 'undefined' || !('ontouchstart' in window)) {
    return undefined;
  }

  let startX = 0;
  let startY = 0;
  let lockedDirection: Direction | null = null;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;

  function clearTimers() {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (repeatTimer !== null) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
  }

  function resetState() {
    clearTimers();
    lockedDirection = null;
    cancelled = false;
  }

  function resolveDirection(dx: number, dy: number): Direction | null {
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Horizontal dominates — always available
    if (absDx >= SWIPE_THRESHOLD && absDx >= absDy * DIRECTION_LOCK_RATIO) {
      return dx < 0 ? 'left' : 'right';
    }

    // Vertical dominates — only when keyboard is open
    if (absDy >= SWIPE_THRESHOLD && absDy >= absDx * DIRECTION_LOCK_RATIO) {
      if (isKeyboardOpen?.()) {
        return dy < 0 ? 'up' : 'down';
      }
      // Keyboard closed — let native scroll handle vertical
      return null;
    }

    return null;
  }

  function sendKey(dir: Direction) {
    sendTerminalKey(terminal, ARROW[dir]);
  }

  // --- Event handlers ---

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) {
      cancelled = true;
      clearTimers();
      return;
    }

    resetState();

    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;

    longPressTimer = setTimeout(() => {
      cancelled = true;
      clearTimers();
    }, LONG_PRESS_MS);
  }

  function onTouchMove(e: TouchEvent) {
    if (cancelled || e.touches.length !== 1) return;

    // When keyboard is open, block ALL touch scroll to prevent xterm's
    // internal Gesture handler from scrolling the terminal.
    // We handle navigation via swipe gestures instead.
    const kbOpen = isKeyboardOpen?.() ?? false;
    if (kbOpen) {
      e.preventDefault();
      e.stopPropagation();
    }

    const touch = e.touches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;

    // If we haven't locked a direction yet, try to resolve one
    if (lockedDirection === null) {
      const dir = resolveDirection(dx, dy);
      if (dir === null) return; // not enough movement or vertical swipe

      lockedDirection = dir;

      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }

      sendKey(lockedDirection);

      // Only auto-repeat for horizontal swipes (cursor movement).
      // Vertical swipes (command history) fire exactly once per gesture.
      if (lockedDirection === 'left' || lockedDirection === 'right') {
        repeatTimer = setInterval(() => {
          if (lockedDirection) sendKey(lockedDirection);
        }, REPEAT_INTERVAL);
      }
    }

    // When keyboard is closed, only block default for locked swipe directions
    if (!kbOpen && lockedDirection) {
      e.preventDefault();
    }
  }

  function onTouchEnd() {
    resetState();
  }

  // --- Attach listeners ---
  // Use capture phase so our handlers fire before xterm.js's internal
  // Gesture system (which listens on .xterm-screen in bubble/target phase).
  // This lets us intercept and block touch scroll when keyboard is open.
  container.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  container.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return () => {
    resetState();
    container.removeEventListener('touchstart', onTouchStart, { capture: true } as EventListenerOptions);
    container.removeEventListener('touchmove', onTouchMove, { capture: true } as EventListenerOptions);
    container.removeEventListener('touchend', onTouchEnd);
    container.removeEventListener('touchcancel', onTouchEnd);
  };
}
