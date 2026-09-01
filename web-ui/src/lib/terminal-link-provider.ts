import type { Terminal as XTerm, ILink, IDisposable } from '@xterm/xterm';
import { isTouchDevice } from './mobile';
import { MAX_URL_CONTINUATION_ROWS } from './constants';

/** Minimal interface for xterm's buffer line */
export interface XTermLine {
  isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

/** Minimal interface for xterm's buffer */
export interface XTermBuffer {
  length: number;
  getLine(y: number): XTermLine | undefined;
}

/**
 * Maps a character index within a joined logical line back to buffer (x, y)
 * coordinates. Walks through the rows that were joined (tracked by joinedLines)
 * consuming each row's text length until the remaining index falls within
 * the current row.
 */
function mapStringToBuffer(
  buffer: XTermBuffer,
  joinedLines: number[],
  stringIndex: number,
): { x: number; y: number } | null {
  let remaining = stringIndex;
  for (const lineIdx of joinedLines) {
    const line = buffer.getLine(lineIdx);
    if (!line) return null;
    const text = line.translateToString(true);
    if (remaining <= text.length) {
      return { x: remaining, y: lineIdx };
    }
    remaining -= text.length;
  }
  return null;
}

/** Strips trailing non-URL characters (TUI border decoration like │, padding) */
const TRAILING_NON_URL = /[^a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
/** Strips leading non-URL characters (TUI border decoration like │, padding) */
const LEADING_NON_URL = /^[^a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;

/**
 * Checks whether the next buffer line is likely a URL continuation from
 * an application-inserted newline (e.g. ink-based TUIs like Claude Code).
 * When insideUrl=true, strips TUI border decoration (│ etc.) from line
 * boundaries before checking, so Bubble Tea dialogs don't block detection.
 */
function isLikelyUrlContinuation(
  currentLineText: string,
  nextLineText: string,
  terminalCols: number,
  insideUrl = false,
): boolean {
  // When inside a URL, strip trailing TUI decoration (│, spaces) so border
  // chars don't prevent continuation detection
  const effectiveCurrent = insideUrl
    ? currentLineText.replace(TRAILING_NON_URL, '')
    : currentLineText;
  if (!insideUrl && effectiveCurrent.length < terminalCols - 1) return false;
  const urlChars = /[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
  if (!effectiveCurrent || !urlChars.test(effectiveCurrent.slice(-1))) return false;
  // When inside a URL, strip leading TUI decoration + whitespace from next line
  const checkText = insideUrl ? nextLineText.replace(LEADING_NON_URL, '') : nextLineText;
  if (!checkText || /^\s/.test(checkText)) return false;
  if (/^[$>#]/.test(checkText)) return false;
  if (!urlChars.test(checkText[0])) return false;
  if (/^https?:\/\//i.test(checkText)) return false;
  // When inside a URL in a bordered TUI dialog, verify continuation content has
  // no internal spaces. URLs never contain literal spaces (they use %20), while
  // English text like "Press ENTER to continue" almost always does.
  if (insideUrl) {
    const contentOnly = checkText.replace(TRAILING_NON_URL, '');
    if (/\s/.test(contentOnly)) return false;
  }
  return true;
}

/**
 * Finds the start of a logical line block by looking upward from the given
 * line index, following both isWrapped chains and the column-saturation
 * heuristic for application-inserted newlines.
 */
function findLogicalLineStart(
  buffer: XTermBuffer,
  lineIndex: number,
  cols: number,
): number {
  let start = lineIndex;

  // Follow isWrapped chain upward
  while (start > 0 && buffer.getLine(start)?.isWrapped) {
    start--;
  }

  // Heuristic: continue upward for app-wrapped lines
  let heuristic = 0;
  while (start > 0 && heuristic < MAX_URL_CONTINUATION_ROWS) {
    const prevLine = buffer.getLine(start - 1);
    if (!prevLine) break;
    const prevText = prevLine.translateToString(true);
    const currLine = buffer.getLine(start);
    if (!currLine) break;
    const currText = currLine.translateToString(true);
    const midUrl = /https?:\/\/[^\s]*$/.test(prevText);
    if (!isLikelyUrlContinuation(prevText, currText, cols, midUrl)) break;
    start--;
    heuristic++;
    // Also follow isWrapped chain upward from this heuristic line
    while (start > 0 && buffer.getLine(start)?.isWrapped) {
      start--;
    }
  }

  return start;
}

export interface TerminalLinkController extends IDisposable {
  hasLinkAt(column: number, viewportRow: number): boolean;
  activateLinkAt(column: number, viewportRow: number): boolean;
}

function linksForBufferLine(terminal: XTerm, y: number): ILink[] | undefined {
  const buffer = terminal.buffer.active as unknown as XTermBuffer;
  const cols = terminal.cols;
  const lineIndex = y - 1;
  const line = buffer.getLine(lineIndex);
  if (!line) return undefined;

  const startIdx = findLogicalLineStart(buffer, lineIndex, cols);
  const joinedLines: number[] = [startIdx];
  const startLine = buffer.getLine(startIdx);
  if (!startLine) return undefined;
  let fullText = startLine.translateToString(true);
  let nextIdx = startIdx + 1;

  while (nextIdx < buffer.length) {
    const nextLine = buffer.getLine(nextIdx);
    if (!nextLine?.isWrapped) break;
    fullText += nextLine.translateToString(true);
    joinedLines.push(nextIdx);
    nextIdx++;
  }

  let heuristicCount = 0;
  while (nextIdx < buffer.length && heuristicCount < MAX_URL_CONTINUATION_ROWS) {
    const nextLine = buffer.getLine(nextIdx);
    if (!nextLine) break;
    const nextText = nextLine.translateToString(true);
    const lastLine = buffer.getLine(joinedLines[joinedLines.length - 1]);
    if (!lastLine) break;
    const cleanedForCheck = fullText.replace(TRAILING_NON_URL, '');
    const midUrl = /https?:\/\/[^\s]*$/.test(cleanedForCheck);
    if (!isLikelyUrlContinuation(lastLine.translateToString(true), nextText, cols, midUrl)) break;
    fullText = midUrl
      ? cleanedForCheck + nextText.replace(LEADING_NON_URL, '').replace(TRAILING_NON_URL, '')
      : fullText + nextText;
    joinedLines.push(nextIdx);
    nextIdx++;
    heuristicCount++;
    while (nextIdx < buffer.length) {
      const wrapped = buffer.getLine(nextIdx);
      if (!wrapped?.isWrapped) break;
      fullText += wrapped.translateToString(true);
      joinedLines.push(nextIdx);
      nextIdx++;
    }
  }

  const links: ILink[] = [];
  const urlRegex = /https?:\/\/[^\s"'<>]+/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(fullText)) !== null) {
    const startPos = mapStringToBuffer(buffer, joinedLines, match.index);
    const endPos = mapStringToBuffer(buffer, joinedLines, match.index + match[0].length);
    if (!startPos || !endPos || lineIndex < startPos.y || lineIndex > endPos.y) continue;
    links.push({
      range: {
        start: { x: startPos.x + 1, y: startPos.y + 1 },
        end: { x: endPos.x, y: endPos.y + 1 },
      },
      text: match[0],
      activate: (event: MouseEvent, text: string) => {
        if (isTouchDevice() || event.ctrlKey || event.metaKey) {
          window.open(text, '_blank', 'noopener');
        }
      },
    });
  }
  return links.length > 0 ? links : undefined;
}

function linkContains(link: ILink, column: number, bufferRow: number): boolean {
  const { start, end } = link.range;
  if (bufferRow < start.y || bufferRow > end.y) return false;
  if (start.y === end.y) return column >= start.x && column <= end.x;
  if (bufferRow === start.y) return column >= start.x;
  if (bufferRow === end.y) return column <= end.x;
  return true;
}

/**
 * Register multiline URL detection and expose the same links to Herdr's
 * browser-owned hardware and touch pointer paths.
 */
export function registerMultiLineLinkProvider(terminal: XTerm): TerminalLinkController {
  const disposable = terminal.registerLinkProvider({
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
      callback(linksForBufferLine(terminal, y));
    },
  });
  const linkAt = (column: number, viewportRow: number): ILink | undefined => {
    const bufferRow = terminal.buffer.active.viewportY + viewportRow;
    return linksForBufferLine(terminal, bufferRow)?.find(link => linkContains(link, column, bufferRow));
  };
  return {
    dispose: () => disposable.dispose(),
    hasLinkAt: (column, viewportRow) => linkAt(column, viewportRow) !== undefined,
    activateLinkAt: (column, viewportRow) => {
      const link = linkAt(column, viewportRow);
      if (!link) return false;
      window.open(link.text, '_blank', 'noopener');
      return true;
    },
  };
}
