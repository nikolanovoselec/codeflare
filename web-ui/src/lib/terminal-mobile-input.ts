import type { Terminal as XTerm } from '@xterm/xterm';
import { disableVirtualKeyboardOverlay } from './mobile';
import { logger } from './logger';

export interface MobileInputCallbacks {
  /** Called when cursor line needs a refresh */
  refreshCursorLine: () => void;
}

/**
 * Sets up mobile input handling for the terminal using an off-screen iframe
 * with an input[type=password] to capture keyboard input.
 *
 * The iframe creates a separate compositor context so Android's IME caret is
 * drawn inside the iframe's 1x1px bounds (invisible). xterm's own textarea is
 * hidden via CSS (display:none).
 *
 * Returns a cleanup function that removes event listeners, the iframe, and
 * restores focus lifecycle handlers.
 */
export function setupMobileInput(
  terminal: XTerm,
  props: { active: boolean },
  callbacks: MobileInputCallbacks,
): () => void {
  const core = (terminal as any)._core;
  if (core && typeof core._syncTextArea === 'function') {
    try {
      Object.defineProperty(core, '_syncTextArea', {
        configurable: true,
        get() { return () => {}; },
        set() { /* ignore reassignment */ },
      });
    } catch { /* already defined */ }
  }

  // Create the iframe compositor jail
  const iframe = document.createElement('iframe');
  iframe.className = 'terminal-input-iframe';
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('aria-hidden', 'true');
  // srcdoc: minimal HTML with a password input. Same-origin, no network request.
  iframe.srcdoc = `<!DOCTYPE html>
<html><head><style>
  html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
  input {
    position: absolute; top: 0; left: 0;
    width: 1px; height: 1px;
    font-size: 16px;
    border: none; outline: none; background: transparent;
    color: transparent; caret-color: transparent;
    padding: 0; margin: 0;
    -webkit-tap-highlight-color: transparent;
  }
</style></head><body>
<input id="ti" type="password" autocomplete="off" autocorrect="off"
  autocapitalize="off" spellcheck="false" inputmode="text" enterkeyhint="enter"
  aria-label="Terminal input">
</body></html>`;
  // Insert iframe into document.body for maximum compositor isolation.
  document.body.appendChild(iframe);

  let iframeInputRef: HTMLInputElement | null = null;
  let wasInputFocused = false;

  const blurIframeInput = () => {
    if (iframeInputRef && iframe.contentDocument?.activeElement === iframeInputRef) {
      wasInputFocused = true;
      iframeInputRef.blur();
    }
  };

  const restoreFocusIfNeeded = () => {
    if (wasInputFocused && iframeInputRef && !iframeInputRef.readOnly && props.active) {
      wasInputFocused = false;
      setTimeout(() => {
        if (iframeInputRef) {
          iframeInputRef.focus({ preventScroll: true });
        }
      }, 100);
    }
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      blurIframeInput();
    } else if (document.visibilityState === 'visible') {
      restoreFocusIfNeeded();
    }
  };
  const onWindowFocus = () => restoreFocusIfNeeded();
  const onPageHide = () => blurIframeInput();

  // Wait for iframe to load, then wire up event forwarding
  iframe.addEventListener('load', () => {
    const iframeDoc = iframe.contentDocument;
    if (!iframeDoc) return;
    const input = iframeDoc.getElementById('ti') as HTMLInputElement | null;
    if (!input) return;
    iframeInputRef = input;

    // Focus guard: start readOnly to prevent keyboard on session reconnect
    input.readOnly = true;
    (terminal as any).__removeFocusGuard = () => {
      if (input) input.readOnly = false;
    };
    (terminal as any).__iframeInput = input;

    // Forward keyboard events to xterm via term.input()
    let composing = false;
    let sentViaKeydown = false;

    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => {
      composing = false;
    });

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (composing) return;
      if (!terminal) return;
      sentViaKeydown = false;

      // Map functional keys to terminal sequences
      const keyMap: Record<string, string> = {
        'Enter': '\r',
        'Backspace': '\x7f',
        'Delete': '\x1b[3~',
        'Escape': '\x1b',
        'Tab': '\t',
        'ArrowUp': '\x1b[A',
        'ArrowDown': '\x1b[B',
        'ArrowRight': '\x1b[C',
        'ArrowLeft': '\x1b[D',
        'Home': '\x1b[H',
        'End': '\x1b[F',
        'PageUp': '\x1b[5~',
        'PageDown': '\x1b[6~',
      };

      const seq = keyMap[e.key];
      if (seq) {
        e.preventDefault();
        sentViaKeydown = true;
        terminal.input(seq, false);
        return;
      }

      // Ctrl+key combos
      if (e.ctrlKey && e.key.length === 1) {
        e.preventDefault();
        sentViaKeydown = true;
        const code = e.key.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) { // a-z
          // Ctrl+C with selection = copy
          if (e.key === 'c') {
            const selection = terminal.getSelection();
            if (selection) {
              navigator.clipboard.writeText(selection);
              terminal.clearSelection();
              return;
            }
          }
          // Ctrl+V = paste
          if (e.key === 'v') {
            navigator.clipboard.readText().then((text) => {
              if (text && terminal) terminal.paste(text);
            }).catch((err) => {
              logger.warn('Clipboard read failed:', err);
            });
            return;
          }
          terminal.input(String.fromCharCode(code - 96), false);
        }
        return;
      }
    });

    // 'input' event fires for character input (including IME results).
    input.addEventListener('input', () => {
      if (sentViaKeydown) {
        sentViaKeydown = false;
        input.value = '';
        return;
      }
      if (!terminal) return;
      const val = input.value;
      if (val) {
        terminal.input(val, false);
        input.value = '';
      }
    });

    // Wire up xterm's cursor rendering to the iframe input's focus state.
    const coreRef = (terminal as any)?._core;
    if (coreRef) {
      const ta = terminal?.textarea;
      if (ta) {
        ta.focus = () => {};
        ta.tabIndex = -1;
        ta.setAttribute('aria-hidden', 'true');
        ta.addEventListener('focus', (e: FocusEvent) => {
          if (e.relatedTarget === input) return;
          if (input && !input.readOnly) {
            input.focus({ preventScroll: true });
          }
        });
      }

      const cbs = coreRef._coreBrowserService;
      if (cbs) {
        Object.defineProperty(cbs, 'isFocused', {
          configurable: true,
          get: () => !!(iframe.contentDocument?.hasFocus()),
        });
      }

      input.addEventListener('focus', () => {
        if (coreRef.coreService && !coreRef.coreService.isCursorInitialized) {
          coreRef.coreService.isCursorInitialized = true;
        }
        if (typeof coreRef._handleTextAreaFocus === 'function') {
          coreRef._handleTextAreaFocus(new FocusEvent('focus'));
        }
        callbacks.refreshCursorLine();
      });

      input.addEventListener('blur', () => {
        disableVirtualKeyboardOverlay();
        if (typeof coreRef._handleTextAreaBlur === 'function') {
          coreRef._handleTextAreaBlur();
        }
        callbacks.refreshCursorLine();
      });
    } else {
      input.addEventListener('blur', () => disableVirtualKeyboardOverlay());
    }
  });

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('pagehide', onPageHide);

  // Return cleanup function
  return () => {
    wasInputFocused = false;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('pagehide', onPageHide);
    disableVirtualKeyboardOverlay();
    iframe.remove();
  };
}
