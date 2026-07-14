import type { Terminal } from '@xterm/xterm';
import { onCleanup } from 'solid-js';
import { hasRecentScrollIntent, clearScrollIntent } from '../lib/terminal-scroll-intent';
import { isTouchDevice, isVirtualKeyboardOpen } from '../lib/mobile';

/** Correlates an onScroll event with the gesture that immediately preceded it. */
const USER_SCROLL_GRACE_MS = 150;

export interface ScrollCorrectionParams {
  sessionId: string;
  terminalId: string;
}

/**
 * Keeps bottom-following terminals anchored without taking scroll ownership
 * away from a user who is reading scrollback.
 *
 * A wheel, pointer, navigation key, or external scroll intent establishes
 * manual viewport ownership when the resulting viewport is above the buffer
 * base. That ownership persists until the viewport returns to the bottom; it
 * does not expire with the short event-correlation window.
 *
 * Output-driven scrollback trimming remains entirely xterm-owned. When a full
 * buffer naturally reaches viewportY=0 because viewed lines aged out, this
 * hook does not restore an earlier distance from the bottom.
 *
 * While the touch keyboard is open, the keyboard lifecycle owns the viewport:
 * it performs fit + scrollToBottom on keyboard geometry changes, and touch
 * gestures are routed to terminal input rather than viewport scrolling.
 */
export function useScrollCorrection(
  terminal: Terminal,
  container: HTMLElement,
  params: ScrollCorrectionParams,
): void {
  const { sessionId, terminalId } = params;
  const initialBuffer = terminal.buffer.active;

  let userOwnsViewport = initialBuffer.viewportY < initialBuffer.baseY;
  let wasFollowingOutput = !userOwnsViewport;
  let lastUserScrollIntentAt = 0;
  let isCorrectingScroll = false;

  const markUserScrollIntent = () => { lastUserScrollIntentAt = Date.now(); };

  const onNavKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'PageUp' || event.key === 'PageDown' || event.key === 'Home' || event.key === 'End') {
      markUserScrollIntent();
    }
  };

  // Capture intent before xterm handles the event and emits onScroll.
  container.addEventListener('wheel', markUserScrollIntent, { passive: true, capture: true });
  container.addEventListener('pointerdown', markUserScrollIntent, { passive: true, capture: true });
  container.addEventListener('keydown', onNavKeyDown, { capture: true });

  const scrollDisposable = terminal.onScroll((viewportY: number) => {
    const baseY = terminal.buffer.active.baseY;

    if (isCorrectingScroll) {
      userOwnsViewport = viewportY < baseY;
      wasFollowingOutput = !userOwnsViewport;
      return;
    }

    // Mobile input mode explicitly owns fit + bottom anchoring. Generic output
    // correction must not move the viewport while touch gestures send keys.
    if (isTouchDevice() && isVirtualKeyboardOpen()) {
      userOwnsViewport = false;
      wasFollowingOutput = true;
      return;
    }

    const recentUserIntent = Date.now() - lastUserScrollIntentAt < USER_SCROLL_GRACE_MS
      || hasRecentScrollIntent(sessionId, terminalId, USER_SCROLL_GRACE_MS);

    if (recentUserIntent) {
      userOwnsViewport = viewportY < baseY;
      wasFollowingOutput = !userOwnsViewport;
      return;
    }

    if (userOwnsViewport) {
      if (viewportY >= baseY) {
        userOwnsViewport = false;
        wasFollowingOutput = true;
      } else {
        wasFollowingOutput = false;
      }
      return;
    }

    const previouslyFollowingOutput = wasFollowingOutput;
    wasFollowingOutput = viewportY >= baseY;

    // Preserve the existing defense for a bottom-following viewport displaced
    // by a browser/layout event. User-owned scrollback never enters this path.
    if (previouslyFollowingOutput && viewportY < baseY) {
      isCorrectingScroll = true;
      try {
        terminal.scrollToBottom();
      } finally {
        isCorrectingScroll = false;
      }
      userOwnsViewport = false;
      wasFollowingOutput = true;
    }
  });

  onCleanup(() => {
    container.removeEventListener('wheel', markUserScrollIntent, { capture: true });
    container.removeEventListener('pointerdown', markUserScrollIntent, { capture: true });
    container.removeEventListener('keydown', onNavKeyDown, { capture: true });
    scrollDisposable.dispose();
    clearScrollIntent(sessionId, terminalId);
  });
}
