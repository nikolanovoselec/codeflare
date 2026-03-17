import type { Terminal } from '@xterm/xterm';
import { onCleanup } from 'solid-js';
import { terminalStore } from '../stores/terminal';
import { hasRecentScrollIntent, clearScrollIntent } from '../lib/terminal-scroll-intent';
import { isTouchDevice, isVirtualKeyboardOpen } from '../lib/mobile';

/**
 * Grace period (ms) after a user scroll gesture (wheel, pointer, nav key, or
 * external intent signal) during which the detector will not correct scroll
 * position. Prevents the correction logic from fighting intentional scrolling.
 */
const USER_SCROLL_GRACE_MS = 150;

export interface ScrollCorrectionParams {
  sessionId: string;
  terminalId: string;
}

/**
 * Prevents unwanted viewport resets caused by browser focus-validation bugs.
 *
 * Browsers (especially Chrome) can snap xterm's viewport to scroll position 0
 * when internal focus management runs. CSS `overflow:hidden` on `.xterm-viewport`
 * is the primary defense; this hook is a secondary safeguard that detects and
 * reverses resets from any source.
 *
 * Two correction strategies:
 *
 * 1. **Bottom-following re-anchor** — If the user was following output (viewport
 *    at bottom) and gets displaced without recent scroll intent, immediately
 *    scroll back to bottom. Fires synchronously in xterm's `onScroll` callback
 *    (before the render pass) to avoid visible one-frame jitter.
 *
 * 2. **Distance-based reset detection** — During normal scrollback trimming,
 *    both `baseY` and `viewportY` shift together so distance-from-bottom stays
 *    roughly constant (~1-2 line drift per trim). A browser focus reset snaps
 *    `viewportY` to 0 while `baseY` stays large, causing distance to jump by
 *    tens or hundreds of lines. When `viewportY === 0`, the previous position
 *    was well into the buffer (`>20`), and distance drift exceeds 20 lines,
 *    the viewport is restored to its previous distance from bottom.
 *
 * Both strategies are suppressed when:
 * - The store's programmatic-scroll suppression flag is active (set by
 *   `flushWriteBuffer` post-write corrections to avoid feedback loops).
 * - A recent user scroll gesture was detected (wheel, pointer, nav key, or
 *   external intent from floating UI buttons).
 * - The mobile virtual keyboard is open (the write callback handles
 *   `scrollToBottom` in that mode; corrections here would cause oscillation).
 */
export function useScrollCorrection(
  terminal: Terminal,
  container: HTMLElement,
  params: ScrollCorrectionParams,
): void {
  const { sessionId, terminalId } = params;

  let wasFollowingOutput = true;
  let previousYdisp = 0;
  let previousDistFromBottom = 0;
  let lastUserScrollIntentAt = 0;
  let isCorrectingScroll = false;

  // --- User scroll intent detection ---
  // Track wheel, pointer, and navigation key events on the container so the
  // detector can distinguish user-initiated scrolls from browser bugs.

  const markUserScrollIntent = () => { lastUserScrollIntentAt = Date.now(); };

  const onNavKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') {
      markUserScrollIntent();
    }
  };

  container.addEventListener('wheel', markUserScrollIntent, { passive: true });
  container.addEventListener('pointerdown', markUserScrollIntent, { passive: true });
  container.addEventListener('keydown', onNavKeyDown);

  // --- Scroll event handler ---

  const scrollDisposable = terminal.onScroll((ydisp: number) => {
    const ybase = terminal.buffer.active.baseY;
    const distFromBottom = ybase - ydisp;

    // While we are correcting, only update baselines — do not re-enter detection.
    if (isCorrectingScroll) {
      wasFollowingOutput = ydisp >= ybase;
      previousYdisp = ydisp;
      previousDistFromBottom = distFromBottom;
      return;
    }

    // Skip events caused by post-write corrections in flushWriteBuffer. These
    // are tagged with a suppression counter to prevent feedback loops during
    // scrollback trimming. Baselines still update so the next unsuppressed
    // event compares correctly.
    if (terminalStore.isProgrammaticScrollSuppressed(sessionId, terminalId)) {
      wasFollowingOutput = ydisp >= ybase;
      previousYdisp = ydisp;
      previousDistFromBottom = distFromBottom;
      return;
    }

    const wasFollowing = wasFollowingOutput;
    wasFollowingOutput = ydisp >= ybase;

    // Strategy 1: Bottom-following re-anchor.
    // Fires synchronously in the parse loop (before the rAF render pass). If
    // the user was following output and got displaced during scrollback
    // trimming, correct immediately to prevent visible one-frame jitter.
    if (wasFollowing && ydisp < ybase) {
      const recentIntent = Date.now() - lastUserScrollIntentAt < USER_SCROLL_GRACE_MS
        || hasRecentScrollIntent(sessionId, terminalId, USER_SCROLL_GRACE_MS);
      if (!recentIntent) {
        isCorrectingScroll = true;
        try {
          terminal.scrollToBottom();
        } finally {
          isCorrectingScroll = false;
        }
        wasFollowingOutput = true;
        previousYdisp = terminal.buffer.active.viewportY;
        previousDistFromBottom = terminal.buffer.active.baseY - terminal.buffer.active.viewportY;
        return;
      }
    }

    // When the virtual keyboard is open on mobile, skip all further correction.
    // The write callback handles scrollToBottom; corrections here fight it.
    if (isTouchDevice() && isVirtualKeyboardOpen()) {
      previousYdisp = ydisp;
      previousDistFromBottom = distFromBottom;
      return;
    }

    const recentLocalIntent = Date.now() - lastUserScrollIntentAt < USER_SCROLL_GRACE_MS;
    const recentExternalIntent = hasRecentScrollIntent(sessionId, terminalId, USER_SCROLL_GRACE_MS);
    const recentUserIntent = recentLocalIntent || recentExternalIntent;

    // Strategy 2: Distance-based reset detection.
    // During normal scrollback trimming, distance-from-bottom stays roughly
    // constant (both baseY and viewportY shift together, ~1-2 line drift).
    // A browser focus reset snaps viewportY to 0 while baseY stays large,
    // causing distance to jump dramatically (from ~0 to baseY). Detection:
    // viewportY dropped to 0, previous position was deep in the buffer (>20),
    // baseY is substantial (>20), and distance drift exceeds 20 lines.
    const distanceDrift = Math.abs(distFromBottom - previousDistFromBottom);
    const suspiciousReset =
      !recentUserIntent &&
      ydisp === 0 &&
      previousYdisp > 20 &&
      ybase > 20 &&
      distanceDrift > 20;

    if (suspiciousReset) {
      isCorrectingScroll = true;
      const restoreDistance = wasFollowing ? 0 : previousDistFromBottom;
      queueMicrotask(() => {
        try {
          const currentBaseY = terminal.buffer.active.baseY;
          const currentY = terminal.buffer.active.viewportY;
          if (currentBaseY <= 0) return;
          const targetY = Math.max(0, currentBaseY - restoreDistance);
          const delta = targetY - currentY;
          if (delta !== 0) {
            terminal.scrollLines(delta);
          } else if (restoreDistance === 0) {
            terminal.scrollToBottom();
          }
        } finally {
          isCorrectingScroll = false;
        }
      });
    }

    previousYdisp = ydisp;
    previousDistFromBottom = distFromBottom;
  });

  // --- Cleanup ---

  onCleanup(() => {
    container.removeEventListener('wheel', markUserScrollIntent);
    container.removeEventListener('pointerdown', markUserScrollIntent);
    container.removeEventListener('keydown', onNavKeyDown);
    scrollDisposable.dispose();
    clearScrollIntent(sessionId, terminalId);
  });
}
