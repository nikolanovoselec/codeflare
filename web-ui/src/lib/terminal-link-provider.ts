import type { Terminal as XTerm, ILink, IDisposable } from '@xterm/xterm';
import { isTouchDevice } from './mobile';

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

/**
 * Checks whether the next buffer line is likely a URL continuation from
 * an application-inserted newline (e.g. ink-based TUIs like Claude Code).
 */
function isLikelyUrlContinuation(
  currentLineText: string,
  nextLineText: string,
  terminalCols: number,
): boolean {
  if (currentLineText.length < terminalCols - 1) return false;
  const urlChars = /[a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/;
  if (!urlChars.test(currentLineText.slice(-1))) return false;
  if (!nextLineText || /^\s/.test(nextLineText)) return false;
  if (/^[$>#]/.test(nextLineText)) return false;
  if (!urlChars.test(nextLineText[0])) return false;
  if (/^https?:\/\//i.test(nextLineText)) return false;
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
  while (start > 0 && heuristic < 10) {
    const prevLine = buffer.getLine(start - 1);
    if (!prevLine) break;
    const prevText = prevLine.translateToString(true);
    const currLine = buffer.getLine(start);
    if (!currLine) break;
    const currText = currLine.translateToString(true);
    if (!isLikelyUrlContinuation(prevText, currText, cols)) break;
    start--;
    heuristic++;
    // Also follow isWrapped chain upward from this heuristic line
    while (start > 0 && buffer.getLine(start)?.isWrapped) {
      start--;
    }
  }

  return start;
}

/**
 * Registers a custom ILinkProvider that reconstructs logical lines from
 * isWrapped buffer rows AND applies a column-saturation heuristic for
 * application-inserted newlines. This replaces the WebLinksAddon to
 * correctly detect URLs that span multiple terminal rows.
 *
 * For each line, it looks both UP and DOWN to find the full logical block,
 * ensuring URLs are clickable on every line they span — not just the first.
 */
export function registerMultiLineLinkProvider(terminal: XTerm): IDisposable {
  const urlRegex = /https?:\/\/[^\s"'<>]+/g;

  return terminal.registerLinkProvider({
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
      const buffer = terminal.buffer.active as unknown as XTermBuffer;
      const cols = terminal.cols;
      const lineIndex = y - 1; // xterm passes 1-based line numbers
      const line = buffer.getLine(lineIndex);
      if (!line) { callback(undefined); return; }

      // Find the start of the logical block by looking upward
      const startIdx = findLogicalLineStart(buffer, lineIndex, cols);

      // Track which buffer lines were joined, for coordinate mapping
      const joinedLines: number[] = [startIdx];

      // Build full text downward: isWrapped + heuristic expansion
      const startLine = buffer.getLine(startIdx);
      if (!startLine) { callback(undefined); return; }
      let fullText = startLine.translateToString(true);
      let nextIdx = startIdx + 1;

      // Phase 1: Join isWrapped continuation rows
      while (nextIdx < buffer.length) {
        const nextLine = buffer.getLine(nextIdx);
        if (!nextLine?.isWrapped) break;
        fullText += nextLine.translateToString(true);
        joinedLines.push(nextIdx);
        nextIdx++;
      }

      // Phase 2: Heuristic expansion for application-inserted newlines
      let heuristicCount = 0;
      while (nextIdx < buffer.length && heuristicCount < 10) {
        const nextLine = buffer.getLine(nextIdx);
        if (!nextLine) break;
        const nextText = nextLine.translateToString(true);
        const lastLineIdx = joinedLines[joinedLines.length - 1];
        const lastLine = buffer.getLine(lastLineIdx);
        if (!lastLine) break;
        const lastLineText = lastLine.translateToString(true);
        if (!isLikelyUrlContinuation(lastLineText, nextText, cols)) break;
        fullText += nextText;
        joinedLines.push(nextIdx);
        nextIdx++;
        heuristicCount++;
        // Also consume any isWrapped lines following this heuristic line
        while (nextIdx < buffer.length) {
          const wrapped = buffer.getLine(nextIdx);
          if (!wrapped?.isWrapped) break;
          fullText += wrapped.translateToString(true);
          joinedLines.push(nextIdx);
          nextIdx++;
        }
      }

      // Find all URLs in the joined text
      const links: ILink[] = [];
      urlRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = urlRegex.exec(fullText)) !== null) {
        const url = match[0];
        const matchStart = match.index;
        const matchEnd = matchStart + url.length;

        const startPos = mapStringToBuffer(buffer, joinedLines, matchStart);
        const endPos = mapStringToBuffer(buffer, joinedLines, matchEnd);
        if (!startPos || !endPos) continue;

        // Only return links that intersect with the requested line
        const linkStartY = startPos.y;
        const linkEndY = endPos.y;
        if (lineIndex < linkStartY || lineIndex > linkEndY) continue;

        links.push({
          range: {
            start: { x: startPos.x + 1, y: startPos.y + 1 },
            end: { x: endPos.x, y: endPos.y + 1 },
          },
          text: url,
          activate: (event: MouseEvent, text: string) => {
            if (isTouchDevice() || event.ctrlKey || event.metaKey) {
              window.open(text, '_blank', 'noopener');
            }
          },
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  });
}
