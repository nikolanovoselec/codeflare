import type { Terminal } from '@xterm/xterm';
import { scrollBufferLines } from './xterm-internals';
import { getScrollPxPerLine } from './touch-gestures';

/**
 * Route mouse-wheel scrollback navigation through the BufferService.
 *
 * xterm 6.1's viewport resolves wheel input against a DOM scroll state
 * (SmoothScrollableElement scrollTop) that can silently diverge from the
 * buffer: Viewport._sync() clamps scrollTop with its scroll handler
 * suppressed during dimension changes, and a resize sync never re-commands
 * the position (see scrollBufferLines / resyncViewportScrollState in
 * xterm-internals). Once diverged, the first wheel tick resolves the whole
 * divergence as one giant scrollLines — the viewport yanks to the top of
 * scrollback. Intercepting the wheel in the capture phase and scrolling the
 * buffer service by the converted delta makes every tick buffer-exact, and
 * each resulting onScroll re-commands the DOM state absolutely.
 *
 * Passthrough (no interception, xterm handles the event natively):
 * - Alternate-buffer applications — xterm forwards wheel to the app's mouse
 *   protocol or emulates arrow keys; there is no scrollback to navigate.
 * - Ctrl/meta-modified wheel — browser zoom and pinch gestures.
 * - Pure horizontal wheel (deltaY === 0).
 */
export function attachWheelScrolling(
  container: HTMLElement,
  terminal: Terminal,
): () => void {
  let accumulatedLines = 0;

  function onWheel(event: WheelEvent): void {
    if (terminal.buffer.active.type !== 'normal') return;
    if (event.ctrlKey || event.metaKey) return;
    if (event.deltaY === 0) return;

    // Own the event: stop xterm's DOM-relative wheel path entirely, even for
    // sub-line deltas — a leaked tick could still resolve a stale DOM state.
    event.preventDefault();
    event.stopPropagation();

    let deltaLines: number;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      deltaLines = event.deltaY;
    } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      deltaLines = event.deltaY * Math.max(1, terminal.rows - 1);
    } else {
      deltaLines = event.deltaY / getScrollPxPerLine(terminal);
    }

    accumulatedLines += deltaLines;
    const lines = Math.trunc(accumulatedLines);
    if (lines !== 0) {
      accumulatedLines -= lines;
      scrollBufferLines(terminal, lines);
    }
  }

  container.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    container.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  };
}
