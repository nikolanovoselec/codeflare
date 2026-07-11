import type { Terminal } from '@xterm/xterm';
import { getXtermCore } from './xterm-internals';

// --- Tuning constants ---
const SWIPE_THRESHOLD = 20; // px minimum delta to qualify as a swipe
const LONG_PRESS_MS = 500; // after this delay, yield to browser text-selection
const REPEAT_INTERVAL = 80; // ms between repeated key sends while finger held
const DIRECTION_LOCK_RATIO = 1.5; // one axis must exceed the other by this factor
// Inertia scrolling: after finger lifts, continue scrolling with decaying velocity
const INERTIA_FRICTION = 0.993; // velocity decay per ms (≈400ms of meaningful scroll)
const INERTIA_MIN_VELOCITY = 0.05; // px/ms — stop inertia below this
const VELOCITY_SAMPLE_COUNT = 4; // number of recent touch samples for velocity calc
const VELOCITY_MAX_AGE_MS = 300; // ignore velocity samples older than this
// ANSI escape sequences for arrow keys.
// Horizontal swipes are always active. Vertical swipes use arrows only when
// the keyboard is open and no fullscreen application captures wheel input.
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
  const core = getXtermCore(terminal);
  if (core?.coreService?.triggerDataEvent) {
    core.coreService.triggerDataEvent(sequence, false);
  }
}

function getScrollPxPerLine(terminal: Terminal): number {
  const fontSize = typeof terminal.options.fontSize === 'number' ? terminal.options.fontSize : 14;
  const lineHeight = typeof terminal.options.lineHeight === 'number' ? terminal.options.lineHeight : 1.2;
  return Math.max(12, Math.round(fontSize * lineHeight));
}

function hasFullscreenWheelTracking(terminal: Terminal): boolean {
  const mouseTrackingMode = terminal.modes.mouseTrackingMode;
  return terminal.buffer.active.type === 'alternate'
    && mouseTrackingMode !== 'none'
    && mouseTrackingMode !== 'x10';
}

function scrollTouchLines(
  terminal: Terminal,
  lines: number,
  clientX: number,
  clientY: number,
): void {
  const element = terminal.element;
  if (!hasFullscreenWheelTracking(terminal) || !element) {
    terminal.scrollLines(lines);
    return;
  }

  const deltaY = Math.sign(lines);
  for (let index = 0; index < Math.abs(lines); index += 1) {
    element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    }));
  }
}

/**
 * Attach touch gestures to a terminal container.
 * Horizontal swipes (left/right) always map to arrow left/right.
 * Vertical swipes route to a fullscreen application's wheel protocol when active,
 * otherwise they map to arrow up/down with the keyboard open or scroll normal
 * terminal scrollback with the keyboard closed.
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
  let scrollMode = false;
  let lastScrollY = 0;
  let scrollAccumulator = 0;
  const scrollPxPerLine = getScrollPxPerLine(terminal);

  // Inertia scrolling state
  let velocitySamples: { y: number; time: number }[] = [];
  let inertiaRaf: number | null = null;

  function cancelInertia() {
    if (inertiaRaf !== null) {
      cancelAnimationFrame(inertiaRaf);
      inertiaRaf = null;
    }
  }

  function startInertia(velocityPxPerMs: number, clientX: number, clientY: number) {
    let velocity = velocityPxPerMs;
    let lastTime = performance.now();
    let accumulator = 0;

    function frame() {
      const now = performance.now();
      const dt = now - lastTime;
      lastTime = now;

      // Exponential decay: v *= friction^dt (frame-rate independent)
      velocity *= Math.pow(INERTIA_FRICTION, dt);
      accumulator += velocity * dt;

      const lines = Math.trunc(accumulator / scrollPxPerLine);
      if (lines !== 0) {
        scrollTouchLines(terminal, lines, clientX, clientY);
        accumulator -= lines * scrollPxPerLine;
      }

      if (Math.abs(velocity) > INERTIA_MIN_VELOCITY) {
        inertiaRaf = requestAnimationFrame(frame);
      } else {
        inertiaRaf = null;
      }
    }

    cancelInertia();
    inertiaRaf = requestAnimationFrame(frame);
  }

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
    scrollMode = false;
    lastScrollY = 0;
    scrollAccumulator = 0;
    velocitySamples = [];
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
      // Keyboard closed — scroll mode handles this (see onTouchMove)
      return null;
    }

    return null;
  }

  function sendKey(dir: Direction) {
    sendTerminalKey(terminal, ARROW[dir]);
  }

  // --- Event handlers ---

  function onTouchStart(e: TouchEvent) {
    // Cancel any running inertia animation when a new touch begins
    cancelInertia();

    if (e.touches.length !== 1) {
      resetState();
      cancelled = true;
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

    const kbOpen = isKeyboardOpen?.() ?? false;

    // When keyboard is open, block native touch behavior. Vertical gestures
    // become fullscreen wheel input or arrow-key navigation below.
    if (kbOpen) {
      e.preventDefault();
    }

    const touch = e.touches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;

    // Already in scroll mode — accumulate delta and scroll terminal buffer
    if (scrollMode) {
      e.preventDefault();
      const deltaY = lastScrollY - touch.clientY; // positive = finger up = scroll down
      lastScrollY = touch.clientY;
      scrollAccumulator += deltaY;

      // Track velocity for inertia: store recent positions with timestamps
      const now = performance.now();
      velocitySamples.push({ y: touch.clientY, time: now });
      if (velocitySamples.length > VELOCITY_SAMPLE_COUNT) velocitySamples.shift();

      const lines = Math.trunc(scrollAccumulator / scrollPxPerLine);
      if (lines !== 0) {
        scrollTouchLines(terminal, lines, touch.clientX, touch.clientY);
        scrollAccumulator -= lines * scrollPxPerLine;
      }
      return;
    }

    // If we haven't locked a direction yet, try to resolve one
    if (lockedDirection === null) {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const fullscreenWheelTracking = hasFullscreenWheelTracking(terminal);

      // A vertical-dominant swipe enters scroll mode when normal scrollback is
      // available with the keyboard closed, or when a fullscreen application
      // requests wheel input regardless of keyboard state.
      if ((!kbOpen || fullscreenWheelTracking)
        && absDy >= SWIPE_THRESHOLD
        && absDy >= absDx * DIRECTION_LOCK_RATIO) {
        scrollMode = true;
        lastScrollY = touch.clientY;
        scrollAccumulator = startY - touch.clientY; // pre-seed with threshold movement
        if (longPressTimer !== null) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        // Immediately scroll if the threshold crossing already covers a full line
        const lines = Math.trunc(scrollAccumulator / scrollPxPerLine);
        if (lines !== 0) {
          scrollTouchLines(terminal, lines, touch.clientX, touch.clientY);
          scrollAccumulator -= lines * scrollPxPerLine;
        }
        e.preventDefault();
        return;
      }

      const dir = resolveDirection(dx, dy);
      if (dir === null) return;

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
  }

  function onTouchEnd() {
    // Start inertia scrolling if we were in scroll mode with enough velocity
    if (scrollMode && velocitySamples.length >= 2) {
      const now = performance.now();
      const first = velocitySamples[0];
      const last = velocitySamples[velocitySamples.length - 1];
      const dt = last.time - first.time;

      // Only start inertia if samples are recent and span meaningful time
      if (dt > 0 && dt < VELOCITY_MAX_AGE_MS && (now - last.time) < 50) {
        // Velocity in px/ms: positive = finger moving up = scroll down (content moves up)
        const velocity = (first.y - last.y) / dt;
        if (Math.abs(velocity) > INERTIA_MIN_VELOCITY) {
          startInertia(velocity, startX, lastScrollY);
        }
      }
    }
    resetState();
  }

  // touchcancel: gesture interrupted by the system (e.g. phone call, notification).
  // Do NOT launch inertia — just stop everything cleanly.
  function onTouchCancel() {
    cancelInertia();
    resetState();
  }

  // --- Attach listeners ---
  // Use capture phase so our handlers fire before xterm.js's internal
  // Gesture system (which listens on .xterm-screen in bubble/target phase).
  // This lets us intercept and block touch scroll when keyboard is open.
  container.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  container.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  container.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
  container.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });

  // --- xterm >=6.1 Gesture shield ---
  // xterm 6.1 (6.1.0-beta.288) registers a DOCUMENT-level Gesture singleton
  // (vendored VS Code touch.ts, via MouseService Gesture.addTarget on
  // .xterm-screen) that claims every touch starting inside the terminal and
  // calls preventDefault() on the native touchstart/touchend. preventDefault
  // on those events suppresses the browser's synthesized click — the ONLY
  // trigger that opens the mobile virtual keyboard (Terminal.tsx on:click) —
  // and its gesture scrolling double-drives our scrollLines() path. This app
  // owns all touch handling on the terminal container, so stop touch events
  // here (bubble phase, i.e. after our capture handlers above) before they
  // reach xterm's document-level listeners. stopPropagation() does not affect
  // browser defaults, so tap -> click synthesis keeps working.
  function shieldFromXtermGesture(e: TouchEvent) {
    e.stopPropagation();
  }
  container.addEventListener('touchstart', shieldFromXtermGesture);
  container.addEventListener('touchmove', shieldFromXtermGesture);
  container.addEventListener('touchend', shieldFromXtermGesture);

  return () => {
    resetState();
    cancelInertia();
    container.removeEventListener('touchstart', onTouchStart, { capture: true } as EventListenerOptions);
    container.removeEventListener('touchmove', onTouchMove, { capture: true } as EventListenerOptions);
    container.removeEventListener('touchend', onTouchEnd, { capture: true } as EventListenerOptions);
    container.removeEventListener('touchcancel', onTouchCancel, { capture: true } as EventListenerOptions);
    container.removeEventListener('touchstart', shieldFromXtermGesture);
    container.removeEventListener('touchmove', shieldFromXtermGesture);
    container.removeEventListener('touchend', shieldFromXtermGesture);
  };
}
