/**
 * Typed helper functions that encapsulate xterm.js internal access.
 *
 * xterm.js exposes several private APIs (prefixed with `_`) that we rely on
 * for mobile input handling and focus management. Instead of scattering
 * `(terminal as any)._core` casts throughout the codebase, this module
 * provides typed accessors with a single cast point.
 *
 * We also use a WeakMap-based approach for custom properties (__iframeInput,
 * __removeFocusGuard) instead of monkey-patching the Terminal instance, which
 * avoids polluting the xterm type and prevents accidental property collisions.
 *
 * xterm 6.0.0 note: The core class is now CoreBrowserTerminal (was Terminal).
 * The viewport was rewritten to use VS Code's SmoothScrollableElement and no
 * longer exposes touch handlers. Touch scrolling is handled internally.
 */
import type { Terminal } from '@xterm/xterm';

// ── Internal xterm types (not exported by @xterm/xterm) ──────────────

export interface XtermCoreBrowserService {
  isFocused: boolean;
}

export interface XtermCoreService {
  isCursorInitialized: boolean;
  triggerDataEvent: (data: string, wasUserInput: boolean) => void;
}

export interface XtermBufferService {
  scrollLines: (disp: number, suppressScrollEvent?: boolean) => void;
}

export interface XtermViewport {
  scrollToLine: (line: number, disableSmoothScroll?: boolean) => void;
}

export interface XtermCore {
  coreService: XtermCoreService | undefined;
  _bufferService: XtermBufferService | undefined;
  _coreBrowserService: XtermCoreBrowserService | undefined;
  _viewport: XtermViewport | undefined;
  _syncTextArea: (() => void) | undefined;
  _handleTextAreaFocus: ((e: FocusEvent) => void) | undefined;
  _handleTextAreaBlur: (() => void) | undefined;
}

export interface XtermBufferActive {
  cursorY: number;
  viewportY: number;
  length: number;
  getLine: (y: number) => { translateToString: (trimRight?: boolean) => string; isWrapped: boolean } | undefined;
}

// ── Core access ──────────────────────────────────────────────────────

/** Access xterm's internal _core object. Single cast point for the entire codebase. */
export function getXtermCore(terminal: Terminal): XtermCore | undefined {
  return (terminal as any)._core as XtermCore | undefined;
}

// ── Buffer access ────────────────────────────────────────────────────

/** Access the active terminal buffer (used for URL detection, cursor position). */
export function getBufferActive(terminal: Terminal): XtermBufferActive | undefined {
  return (terminal as any).buffer?.active as XtermBufferActive | undefined;
}

/**
 * Scroll normal-buffer scrollback through xterm's internal BufferService.
 *
 * The public Terminal.scrollLines() routes through the viewport and applies
 * the delta RELATIVE to the DOM scroll state's current scrollTop
 * (CoreBrowserTerminal: "All scrollLines methods need to go via the viewport
 * in order to support smooth scroll"). That DOM state can silently diverge
 * from the buffer: Viewport._sync() clamps scrollTop via setScrollDimensions()
 * with its scroll handler suppressed (e.g. a refit passing through zero
 * height), and the divergence is never repaired while ydisp matches the
 * viewport's cached _latestYDisp. The next relative tick then makes xterm
 * resolve the full divergence in one giant scrollLines() — the viewport
 * yanks to the top of scrollback mid-gesture.
 *
 * Scrolling the BufferService directly moves by exactly the requested delta,
 * and the onScroll it fires makes Viewport._sync() re-command the DOM scroll
 * state ABSOLUTELY (setScrollPosition(ydisp * cellHeight)), repairing any
 * divergence on every tick instead of amplifying it. Falls back to the
 * public API when internals are unavailable.
 */
export function scrollBufferLines(terminal: Terminal, lines: number): void {
  const bufferService = getXtermCore(terminal)?._bufferService;
  if (bufferService?.scrollLines) {
    bufferService.scrollLines(lines);
    // The repaint is wired to the viewport's DOM scroll path, not to buffer
    // scroll events: CoreBrowserTerminal pairs onRequestScrollLines with
    // `this.refresh(0, this.rows - 1)`. Scrolling the buffer service directly
    // bypasses that pairing, so without this refresh the scrollbar syncs but
    // the canvas keeps showing the old rows.
    terminal.refresh(0, terminal.rows - 1);
  } else {
    terminal.scrollLines(lines);
  }
}

/**
 * Anchor the viewport to the live bottom through the BufferService.
 *
 * The public no-argument Terminal.scrollToBottom() resolves RELATIVE to the
 * viewport's DOM scroll state (CoreBrowserTerminal.scrollToBottom →
 * scrollLines(ybase - ydisp) → Viewport.scrollLines(pos.scrollTop + disp)).
 * When the buffer already sits at the bottom that is scrollLines(0) — a no-op
 * that can never repair a DOM state diverged by a clamped refit; when the
 * buffer is above the bottom, the relative resolve lands wherever the stale
 * DOM points. Scrolling the BufferService by the buffer-derived delta moves
 * exactly to ybase, and the resulting onScroll makes Viewport._sync()
 * re-command the DOM scroll state absolutely.
 */
export function scrollBufferToBottom(terminal: Terminal): void {
  const active = terminal.buffer.active;
  const delta = active.baseY - active.viewportY;
  const bufferService = getXtermCore(terminal)?._bufferService;
  if (!bufferService?.scrollLines) {
    terminal.scrollToBottom();
    return;
  }
  if (delta === 0) return;
  scrollBufferLines(terminal, delta);
}

/**
 * Re-command the viewport's DOM scroll state from the buffer position.
 *
 * Viewport._sync() clamps the DOM scrollTop with its scroll handler
 * suppressed whenever scroll dimensions change (ScrollState clamps into
 * [0, scrollHeight - height]), and a resize-driven sync runs against the
 * cached _latestYDisp so it never re-commands the position. The stale DOM
 * state then resolves the divergence through the next relative scroll —
 * one wheel tick or keystroke yanks the buffer toward the top of scrollback.
 * Calling the internal viewport's scrollToLine with disableSmoothScroll=true
 * sets scrollTop absolutely from the CURRENT buffer position and corrects
 * the _latestYDisp cache. Call after any refit that does not re-anchor to
 * the bottom. No-ops when internals are unavailable.
 */
export function resyncViewportScrollState(terminal: Terminal): void {
  const viewport = getXtermCore(terminal)?._viewport;
  if (viewport?.scrollToLine) {
    viewport.scrollToLine(terminal.buffer.active.viewportY, true);
  }
}

// ── Custom property storage (WeakMap-based) ──────────────────────────

const iframeInputMap = new WeakMap<Terminal, HTMLInputElement>();
const removeFocusGuardMap = new WeakMap<Terminal, () => void>();

/** Get the iframe input element associated with a terminal (mobile compositor jail). */
export function getIframeInput(terminal: Terminal): HTMLInputElement | undefined {
  return iframeInputMap.get(terminal);
}

/** Associate an iframe input element with a terminal. */
export function setIframeInput(terminal: Terminal, input: HTMLInputElement): void {
  iframeInputMap.set(terminal, input);
}

/** Get the focus guard removal callback for a terminal. */
export function getRemoveFocusGuard(terminal: Terminal): (() => void) | undefined {
  return removeFocusGuardMap.get(terminal);
}

/** Set the focus guard removal callback for a terminal. */
export function setRemoveFocusGuard(terminal: Terminal, fn: () => void): void {
  removeFocusGuardMap.set(terminal, fn);
}
