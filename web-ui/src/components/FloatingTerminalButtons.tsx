import { Component, Show, createSignal, createEffect, onCleanup } from 'solid-js';
import { mdiCancel, mdiKeyboardTab, mdiContentPaste, mdiContentCopy, mdiArrowExpandDown, mdiArrowExpandUp, mdiSecurity, mdiCodeBrackets, mdiMicrophonePlus } from '@mdi/js';
import Icon from './Icon';
import { isTouchDevice, isVirtualKeyboardOpen, getKeyboardHeight } from '../lib/mobile';
import { sendTerminalKey } from '../lib/touch-gestures';
import { activateStickyCtrl, deactivateStickyCtrl, isStickyCtrlActive } from '../lib/terminal-mobile-input';
import { terminalStore } from '../stores/terminal';
import { sessionStore } from '../stores/session';
import { terminalWorkspaceStore } from '../stores/terminal-workspace';
import { markScrollIntent } from '../lib/terminal-scroll-intent';
import { loadSettings } from '../lib/settings';
import { BUTTON_LABEL_VISIBLE_DURATION_MS } from '../lib/constants';
import { getIframeInput } from '../lib/xterm-internals';
import { isSpeechSupported, isListening, startListening, stopListening, getMicPermissionState } from '../lib/speech-input';
import '../styles/floating-terminal-buttons.css';

interface FloatingTerminalButtonsProps {
  showTerminal: boolean;
}

const FloatingTerminalButtons: Component<FloatingTerminalButtonsProps> = (props) => {
  const [labelsVisible, setLabelsVisible] = createSignal(false);
  const [showLabels, setShowLabels] = createSignal(loadSettings().showButtonLabels !== false);
  const [ctrlActive, setCtrlActive] = createSignal(false);
  const [voiceActive, setVoiceActive] = createSignal(false);

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

  const getActiveTerminalTarget = () => {
    const sessionId = sessionStore.activeSessionId;
    if (sessionId) {
      const terminals = sessionStore.getTerminalsForSession(sessionId);
      const terminalId = terminals?.activeTabId || '1';
      return { sessionId, terminalId, term: terminalStore.getTerminal(sessionId, terminalId) };
    }
    const focusedPaneId = terminalWorkspaceStore.getFocusedPaneId();
    const focusedPane = terminalWorkspaceStore.getVisiblePanes().find((pane) => pane.id === focusedPaneId);
    if (!focusedPane) return null;
    return {
      sessionId: focusedPane.sessionId,
      terminalId: focusedPane.terminalId,
      term: terminalStore.getTerminal(focusedPane.sessionId, focusedPane.terminalId),
    };
  };

  const getActiveTerm = () => getActiveTerminalTarget()?.term ?? null;

  // Stop speech recognition on component unmount
  onCleanup(() => { if (isListening()) stopListening(); });

  // Prevent button from stealing focus from xterm textarea (which would dismiss keyboard)
  const preventFocusSteal = (e: MouseEvent | PointerEvent) => e.preventDefault();

  const refocusTerminal = () => {
    const term = getActiveTerm();
    // On mobile with iframe compositor jail, focus the iframe input instead
    const iframeInput = term ? getIframeInput(term) : undefined;
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
    // On first use, browser shows clipboard permission prompt. On mobile it
    // appears behind the keyboard. Dismiss keyboard so user sees it.
    try {
      const perm = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
      if (perm.state === 'prompt') {
        const iframeInput = getIframeInput(term);
        if (iframeInput) iframeInput.blur();
      }
    } catch { /* permissions API may not support clipboard-read query */ }
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
    <>
    <Show when={isTouchDevice() && props.showTerminal && isVirtualKeyboardOpen()}>
      <div class="floating-terminal-buttons" style={{ bottom: `calc(env(safe-area-inset-bottom, 0px) + ${getKeyboardHeight()}px + 10px)`, "max-height": `calc(100vh - env(safe-area-inset-bottom, 0px) - ${getKeyboardHeight()}px - 60px)` }}>
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
        <Show when={isSpeechSupported()}>
          <div class="floating-btn-row">
            <span class={`floating-btn-label ${labelsVisible() ? 'visible' : ''}`}>VOICE INPUT</span>
            <button
              type="button"
              class={`floating-terminal-btn ${voiceActive() ? 'floating-terminal-btn--active' : ''}`}
              tabIndex={-1}
              onPointerDown={preventFocusSteal}
              onClick={async () => {
                const term = getActiveTerm();
                if (!term) return;
                if (isListening()) {
                  stopListening();
                  setVoiceActive(false);
                  refocusTerminal();
                  return;
                }
                // On first use, browser shows a permission prompt. On mobile it
                // appears behind the keyboard. Dismiss keyboard so user sees it.
                const permState = await getMicPermissionState();
                if (permState === 'prompt') {
                  const iframeInput = getIframeInput(term);
                  if (iframeInput) iframeInput.blur();
                }
                const started = startListening(
                  (text) => term.input(text, false),
                  () => setVoiceActive(false),
                );
                setVoiceActive(started);
              }}
              title="Voice Input"
            >
              <Icon path={mdiMicrophonePlus} size={18} />
            </button>
          </div>
        </Show>
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
          <span class={`floating-btn-label ${labelsVisible() ? 'visible' : ''}`}>CTRL</span>
          <button
            type="button"
            class={`floating-terminal-btn ${ctrlActive() ? 'floating-terminal-btn--active' : ''}`}
            tabIndex={-1}
            onPointerDown={preventFocusSteal}
            onClick={() => {
              if (ctrlActive()) {
                deactivateStickyCtrl();
                setCtrlActive(false);
              } else {
                activateStickyCtrl(() => setCtrlActive(false));
                setCtrlActive(true);
                // Auto-deactivate after 5 seconds if no key pressed
                setTimeout(() => {
                  if (isStickyCtrlActive()) {
                    deactivateStickyCtrl();
                    setCtrlActive(false);
                  }
                }, 5000);
              }
              // Don't call refocusTerminal() here — onPointerDown already
              // prevents focus steal, and re-focusing causes a blur→focus
              // cycle on Samsung that triggers spurious keyboard events
              // which consume the sticky CTRL before the user types.
            }}
            title="CTRL"
          >
            <Icon path={mdiCodeBrackets} size={18} />
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
              const target = getActiveTerminalTarget();
              if (target?.term) {
                markScrollIntent(target.sessionId, target.terminalId);
                target.term.scrollPages(-1);
              }
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
              const target = getActiveTerminalTarget();
              if (target?.term) {
                markScrollIntent(target.sessionId, target.terminalId);
                target.term.scrollToBottom();
              }
              refocusTerminal();
            }}
            title="Scroll to Bottom"
          >
            <Icon path={mdiArrowExpandDown} size={18} />
          </button>
        </div>
      </div>
    </Show>

    {/* Desktop mic button — bottom-right corner, same style as mobile buttons */}
    <Show when={!isTouchDevice() && props.showTerminal && isSpeechSupported()}>
      <div class="floating-mic-desktop">
        <button
          type="button"
          class={`floating-terminal-btn ${voiceActive() ? 'floating-terminal-btn--active' : ''}`}
          onClick={() => {
            const term = getActiveTerm();
            if (!term) return;
            if (isListening()) {
              stopListening();
              setVoiceActive(false);
            } else {
              const started = startListening(
                (text) => term.input(text, false),
                () => setVoiceActive(false),
              );
              setVoiceActive(started);
            }
          }}
          title="Voice Input (Ctrl+Space)"
        >
          <Icon path={mdiMicrophonePlus} size={18} />
        </button>
      </div>
    </Show>
    </>
  );
};

export default FloatingTerminalButtons;
