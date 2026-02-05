import { Component, Show, createSignal, createEffect, onCleanup } from 'solid-js';
import { mdiCancel, mdiKeyboardTab, mdiContentPaste, mdiContentCopy, mdiArrowExpandDown, mdiArrowExpandUp } from '@mdi/js';
import Icon from './Icon';
import { isTouchDevice, isVirtualKeyboardOpen, getKeyboardHeight } from '../lib/mobile';
import { sendTerminalKey } from '../lib/touch-gestures';
import { terminalStore } from '../stores/terminal';
import { sessionStore } from '../stores/session';
import { loadSettings } from '../lib/settings';
import { BUTTON_LABEL_VISIBLE_DURATION_MS, URL_CHECK_INTERVAL_MS } from '../lib/constants';
import '../styles/floating-terminal-buttons.css';

/**
 * Checks whether the next buffer line is likely a URL continuation from
 * an application-inserted newline (e.g. ink-based TUIs like Claude Code).
 * Returns true only when the current line fills the terminal width and
 * the next line starts with URL-valid characters.
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

function getLastUrlFromBuffer(term: any): string | null {
  const buffer = term.buffer?.active;
  if (!buffer) return null;

  const cols: number = term.cols || 80;
  const urlRegex = /https?:\/\/[^\s"'<>]+/g;
  let lastUrl: string | null = null;
  const startLine = Math.max(0, buffer.length - 200);

  let i = startLine;
  while (i < buffer.length) {
    const line = buffer.getLine(i);
    if (!line) { i++; continue; }
    // Skip wrapped continuation lines — they'll be joined from the master line
    if (line.isWrapped) { i++; continue; }

    // Phase 1: Join isWrapped continuation rows
    let fullText = line.translateToString(true);
    let j = i + 1;
    while (j < buffer.length) {
      const nextLine = buffer.getLine(j);
      if (!nextLine?.isWrapped) break;
      fullText += nextLine.translateToString(true);
      j++;
    }

    // Phase 2: Heuristic expansion for application-inserted newlines
    // (e.g. ink TUI wrapping long URLs with explicit newlines, isWrapped=false)
    let heuristicCount = 0;
    while (j < buffer.length && heuristicCount < 10) {
      const nextLine = buffer.getLine(j);
      if (!nextLine) break;
      const nextText = nextLine.translateToString(true);
      // Use last physical buffer row for heuristic (matches Terminal.tsx approach)
      const lastPhysicalLine = buffer.getLine(j - 1)!.translateToString(true);
      if (!isLikelyUrlContinuation(lastPhysicalLine, nextText, cols)) break;
      fullText += nextText;
      j++;
      heuristicCount++;
      // Also consume any isWrapped lines following this heuristic line
      while (j < buffer.length) {
        const wrapped = buffer.getLine(j);
        if (!wrapped?.isWrapped) break;
        fullText += wrapped.translateToString(true);
        j++;
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

interface FloatingTerminalButtonsProps {
  showTerminal: boolean;
}

const FloatingTerminalButtons: Component<FloatingTerminalButtonsProps> = (props) => {
  const [hasUrl, setHasUrl] = createSignal(false);
  const [labelsVisible, setLabelsVisible] = createSignal(false);
  const [showLabels, setShowLabels] = createSignal(loadSettings().showButtonLabels !== false);

  // Show labels for 3 seconds each time the floating buttons appear
  createEffect(() => {
    const visible = isTouchDevice() && props.showTerminal && isVirtualKeyboardOpen();
    // Re-read setting each time keyboard opens so mid-session toggle takes effect
    if (visible) setShowLabels(loadSettings().showButtonLabels !== false);
    if (visible && showLabels()) {
      setLabelsVisible(true);
      const timer = setTimeout(() => setLabelsVisible(false), BUTTON_LABEL_VISIBLE_DURATION_MS);
      onCleanup(() => clearTimeout(timer));
    } else {
      setLabelsVisible(false);
    }
  });

  const getActiveTerm = () => {
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) return null;
    const terminals = sessionStore.getTerminalsForSession(sessionId);
    const terminalId = terminals?.activeTabId || '1';
    return terminalStore.getTerminal(sessionId, terminalId);
  };

  // Periodically check for URLs in the terminal buffer
  const urlCheckInterval = setInterval(() => {
    const term = getActiveTerm();
    setHasUrl(term ? !!getLastUrlFromBuffer(term) : false);
  }, URL_CHECK_INTERVAL_MS);
  onCleanup(() => clearInterval(urlCheckInterval));

  // Prevent button from stealing focus from xterm textarea (which would dismiss keyboard)
  const preventFocusSteal = (e: MouseEvent | PointerEvent) => e.preventDefault();

  const refocusTerminal = () => {
    const term = getActiveTerm();
    // On mobile with iframe compositor jail, focus the iframe input instead
    const iframeInput = (term as any)?.__iframeInput as HTMLInputElement | undefined;
    if (iframeInput) {
      iframeInput.focus({ preventScroll: true });
    } else {
      term?.textarea?.focus({ preventScroll: true });
    }
  };

  const sendKey = (sequence: string) => {
    const term = getActiveTerm();
    if (term) {
      sendTerminalKey(term, sequence);
      refocusTerminal();
    }
  };

  const pasteFromClipboard = async () => {
    const term = getActiveTerm();
    if (!term) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
    } catch {
      // Clipboard read permission denied or unavailable
    }
    refocusTerminal();
  };

  const copyLastUrl = async () => {
    const term = getActiveTerm();
    if (!term) return;
    const url = getLastUrlFromBuffer(term);
    if (url) {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Clipboard API may fail silently on some mobile browsers
      }
    }
    refocusTerminal();
  };

  return (
    <Show when={isTouchDevice() && props.showTerminal && isVirtualKeyboardOpen()}>
      <div class="floating-terminal-buttons" style={{ bottom: `calc(env(safe-area-inset-bottom, 0px) + ${getKeyboardHeight()}px + 10px)` }}>
        <Show when={hasUrl()}>
          <div class="floating-btn-row">
            <span class={`floating-btn-label ${labelsVisible() ? 'visible' : ''}`}>COPY DETECTED URL</span>
            <button
              type="button"
              class="floating-terminal-btn"
              tabIndex={-1}
              onPointerDown={preventFocusSteal}
              onClick={copyLastUrl}
              title="Copy URL"
            >
              <Icon path={mdiContentCopy} size={18} />
            </button>
          </div>
        </Show>
        <div class="floating-btn-row">
          <span class={`floating-btn-label ${labelsVisible() ? 'visible' : ''}`}>PASTE</span>
          <button
            type="button"
            class="floating-terminal-btn"
            tabIndex={-1}
            onPointerDown={preventFocusSteal}
            onClick={pasteFromClipboard}
            title="Paste"
          >
            <Icon path={mdiContentPaste} size={18} />
          </button>
        </div>
        <div class="floating-btn-row">
          <span class={`floating-btn-label ${labelsVisible() ? 'visible' : ''}`}>TAB</span>
          <button
            type="button"
            class="floating-terminal-btn"
            tabIndex={-1}
            onPointerDown={preventFocusSteal}
            onClick={() => sendKey('\t')}
            title="TAB"
          >
            <Icon path={mdiKeyboardTab} size={18} />
          </button>
        </div>
        <div class="floating-btn-row">
          <span class={`floating-btn-label ${labelsVisible() ? 'visible' : ''}`}>ESCAPE / CANCEL</span>
          <button
            type="button"
            class="floating-terminal-btn"
            tabIndex={-1}
            onPointerDown={preventFocusSteal}
            onClick={() => sendKey('\x1b')}
            title="ESC"
          >
            <Icon path={mdiCancel} size={18} />
          </button>
        </div>
        <div class="floating-btn-row">
          <span class={`floating-btn-label ${labelsVisible() ? 'visible' : ''}`}>PAGE UP</span>
          <button
            type="button"
            class="floating-terminal-btn"
            tabIndex={-1}
            onPointerDown={preventFocusSteal}
            onClick={() => {
              const term = getActiveTerm();
              if (term) term.scrollPages(-1);
              refocusTerminal();
            }}
            title="Page Up"
          >
            <Icon path={mdiArrowExpandUp} size={18} />
          </button>
        </div>
        <div class="floating-btn-row">
          <span class={`floating-btn-label ${labelsVisible() ? 'visible' : ''}`}>SCROLL TO BOTTOM</span>
          <button
            type="button"
            class="floating-terminal-btn"
            tabIndex={-1}
            onPointerDown={preventFocusSteal}
            onClick={() => {
              const term = getActiveTerm();
              if (term) term.scrollToBottom();
              refocusTerminal();
            }}
            title="Scroll to Bottom"
          >
            <Icon path={mdiArrowExpandDown} size={18} />
          </button>
        </div>
      </div>
    </Show>
  );
};

export default FloatingTerminalButtons;
