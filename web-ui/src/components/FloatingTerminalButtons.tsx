import { Component, Show, createSignal, createEffect, onCleanup } from 'solid-js';
import { mdiCancel, mdiKeyboardTab, mdiContentPaste, mdiContentCopy, mdiArrowExpandDown, mdiArrowExpandUp, mdiSecurity } from '@mdi/js';
import Icon from './Icon';
import { isTouchDevice, isVirtualKeyboardOpen, getKeyboardHeight } from '../lib/mobile';
import { sendTerminalKey } from '../lib/touch-gestures';
import { terminalStore } from '../stores/terminal';
import { sessionStore } from '../stores/session';
import { loadSettings } from '../lib/settings';
import { BUTTON_LABEL_VISIBLE_DURATION_MS } from '../lib/constants';
import '../styles/floating-terminal-buttons.css';

interface FloatingTerminalButtonsProps {
  showTerminal: boolean;
}

const FloatingTerminalButtons: Component<FloatingTerminalButtonsProps> = (props) => {
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
    if (loadSettings().clipboardAccess !== true) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
    } catch {
      // Clipboard read permission denied or unavailable
    }
    refocusTerminal();
  };

  const openOrCopyUrl = async (forceOpen = false) => {
    const url = terminalStore.authUrl || terminalStore.normalUrl;
    if (!url) return;
    if (forceOpen || terminalStore.authUrl) {
      // Auth URLs: open in background tab
      window.open(url, '_blank', 'noopener');
    } else {
      // Normal URLs: copy to clipboard
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
        <Show when={terminalStore.authUrl}>
          <div class="floating-btn-row">
            <span class={`floating-btn-label ${labelsVisible() ? 'visible' : ''}`}>OPEN AUTH URL</span>
            <button
              type="button"
              class="floating-terminal-btn"
              tabIndex={-1}
              onPointerDown={preventFocusSteal}
              onClick={() => openOrCopyUrl(true)}
              title="Open auth URL"
            >
              <Icon path={mdiSecurity} size={18} />
            </button>
          </div>
        </Show>
        <Show when={!terminalStore.authUrl && terminalStore.normalUrl}>
          <div class="floating-btn-row">
            <span class={`floating-btn-label ${labelsVisible() ? 'visible' : ''}`}>COPY DETECTED URL</span>
            <button
              type="button"
              class="floating-terminal-btn"
              tabIndex={-1}
              onPointerDown={preventFocusSteal}
              onClick={() => openOrCopyUrl()}
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
