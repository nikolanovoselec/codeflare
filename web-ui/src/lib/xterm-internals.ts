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

export interface XtermCore {
  coreService: XtermCoreService | undefined;
  _coreBrowserService: XtermCoreBrowserService | undefined;
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
