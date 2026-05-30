import type { Terminal } from '@xterm/xterm';
import { ACTIONABLE_URL_PATTERNS, URL_CHECK_INTERVAL_MS, MAX_URL_CONTINUATION_ROWS } from '../lib/constants';
import { getBufferActive } from '../lib/xterm-internals';

/**
 * URL Detection module — extracted from terminal.ts (L26).
 *
 * Scans terminal buffers periodically for actionable URLs (OAuth, auth flows)
 * and sets reactive signals consumed by UI components.
 *
 * Uses dependency injection (registerUrlDetectionDeps) to avoid circular imports
 * with the terminal store, following the pattern established by session-presets.ts.
 */

// ─── Dependency Injection ────────────────────────────────────────────────────

type TerminalGetter = (sessionId: string, terminalId: string) => Terminal | undefined;
type UrlSetter = (url: string | null) => void;

let getTerminalFn: TerminalGetter = () => undefined;
let setAuthUrlFn: UrlSetter = () => {};
let setNormalUrlFn: UrlSetter = () => {};

export function registerUrlDetectionDeps(
  getTerminal: TerminalGetter,
  setAuthUrl: UrlSetter,
  setNormalUrl: UrlSetter,
): void {
  getTerminalFn = getTerminal;
  setAuthUrlFn = setAuthUrl;
  setNormalUrlFn = setNormalUrl;
}

// ─── URL Parsing ─────────────────────────────────────────────────────────────

/** Strips trailing non-URL characters (TUI border decoration like |, padding) */
const TRAILING_NON_URL = /[^a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
/** Strips leading non-URL characters (TUI border decoration like |, padding) */
const LEADING_NON_URL = /^[^a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;

/**
 * Checks whether the next buffer line is likely a URL continuation from
 * an application-inserted newline (e.g. ink-based TUIs like Claude Code).
 */
function isLikelyUrlContinuation(
  currentLineText: string,
  nextLineText: string,
  terminalCols: number,
  insideUrl = false,
): boolean {
  const effectiveCurrent = insideUrl
    ? currentLineText.replace(TRAILING_NON_URL, '')
    : currentLineText;
  if (!insideUrl && effectiveCurrent.length < terminalCols - 1) return false;
  const urlChars = /[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
  if (!effectiveCurrent || !urlChars.test(effectiveCurrent.slice(-1))) return false;
  const checkText = insideUrl ? nextLineText.replace(LEADING_NON_URL, '') : nextLineText;
  if (!checkText || /^\s/.test(checkText)) return false;
  if (/^[$>#]/.test(checkText)) return false;
  if (!urlChars.test(checkText[0])) return false;
  if (/^https?:\/\//i.test(checkText)) return false;
  if (insideUrl) {
    const contentOnly = checkText.replace(TRAILING_NON_URL, '');
    if (/\s/.test(contentOnly)) return false;
  }
  return true;
}

export function getLastUrlFromBuffer(term: Terminal): string | null {
  const buffer = getBufferActive(term);
  if (!buffer) return null;

  const cols: number = term.cols || 80;
  const rows: number = term.rows || 24;
  const urlRegex = /https?:\/\/[^\s"'<>]+/g;
  let lastUrl: string | null = null;
  const viewportY: number = buffer.viewportY ?? Math.max(0, buffer.length - rows);
  const startLine = Math.max(0, viewportY - 3);
  const endLine = Math.min(buffer.length, viewportY + rows + 3);

  let i = startLine;
  while (i < endLine) {
    const line = buffer.getLine(i);
    if (!line) { i++; continue; }
    if (line.isWrapped) { i++; continue; }

    let fullText = line.translateToString(true);
    let j = i + 1;
    // Once a logical line begins, follow its continuation rows past the viewport
    // edge (endLine) so a long URL whose tail scrolls just below the visible
    // viewport is still joined in full (matters on mobile where the on-screen
    // keyboard shrinks `rows`, and thus endLine). A single shared budget bounds
    // ALL joins for this logical line (soft-wrap rows + heuristic rows) so a
    // pathological soft-wrapped blob (e.g. `cat` of a minified file producing
    // tens of thousands of isWrapped rows) cannot make this 2s-interval scan
    // walk the entire scrollback and stall the main thread.
    let joinedRows = 0;
    while (j < buffer.length && joinedRows < MAX_URL_CONTINUATION_ROWS) {
      const nextLine = buffer.getLine(j);
      if (!nextLine?.isWrapped) break;
      fullText += nextLine.translateToString(true);
      j++;
      joinedRows++;
    }

    while (j < buffer.length && joinedRows < MAX_URL_CONTINUATION_ROWS) {
      const nextLine = buffer.getLine(j);
      if (!nextLine) break;
      const nextText = nextLine.translateToString(true);
      const lastPhysicalLine = buffer.getLine(j - 1)!.translateToString(true);
      const cleanedForCheck = fullText.replace(TRAILING_NON_URL, '');
      const midUrl = /https?:\/\/[^\s]*$/.test(cleanedForCheck);
      if (!isLikelyUrlContinuation(lastPhysicalLine, nextText, cols, midUrl)) break;
      if (midUrl) {
        fullText = cleanedForCheck;
        fullText += nextText.replace(LEADING_NON_URL, '').replace(TRAILING_NON_URL, '');
      } else {
        fullText += nextText;
      }
      j++;
      joinedRows++;
      while (j < buffer.length && joinedRows < MAX_URL_CONTINUATION_ROWS) {
        const wrapped = buffer.getLine(j);
        if (!wrapped?.isWrapped) break;
        fullText += wrapped.translateToString(true);
        j++;
        joinedRows++;
      }
    }

    const matches = fullText.match(urlRegex);
    if (matches) {
      lastUrl = matches[matches.length - 1];
    }
    i = j;
  }

  return lastUrl;
}

/** Returns true if the URL matches any pattern in ACTIONABLE_URL_PATTERNS */
export function isActionableUrl(url: string): boolean {
  return ACTIONABLE_URL_PATTERNS.some((pattern) => pattern.test(url));
}

// ─── Detection Lifecycle ─────────────────────────────────────────────────────

/** Classify a detected URL into auth vs normal and update signals */
function setDetectedUrl(url: string | null): void {
  if (url && isActionableUrl(url)) {
    setAuthUrlFn(url);
    setNormalUrlFn(null);
  } else if (url) {
    setAuthUrlFn(null);
    setNormalUrlFn(url);
  } else {
    setAuthUrlFn(null);
    setNormalUrlFn(null);
  }
}

let urlDetectionInterval: ReturnType<typeof setInterval> | null = null;

export function startUrlDetection(sessionId: string, terminalId: string): void {
  stopUrlDetection();
  urlDetectionInterval = setInterval(() => {
    const term = getTerminalFn(sessionId, terminalId);
    const url = term ? getLastUrlFromBuffer(term) : null;
    setDetectedUrl(url);
  }, URL_CHECK_INTERVAL_MS);
}

export function stopUrlDetection(): void {
  if (urlDetectionInterval) {
    clearInterval(urlDetectionInterval);
    urlDetectionInterval = null;
  }
  setDetectedUrl(null);
}
