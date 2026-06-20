import { onMount, onCleanup, createEffect, createSignal, createMemo } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminalStore } from '../stores/terminal';
import { sessionStore } from '../stores/session';
import { logger } from '../lib/logger';
import { isTouchDevice, isVirtualKeyboardOpen, getKeyboardHeight, enableVirtualKeyboardOverlay, disableVirtualKeyboardOverlay, resetKeyboardStateIfStale, forceResetKeyboardState, isFocusOnTerminalInput, isSamsungBrowser } from '../lib/mobile';
import { attachSwipeGestures } from '../lib/touch-gestures';
import { registerMultiLineLinkProvider } from '../lib/terminal-link-provider';
import { isSpeechSupported, isListening, startListening, stopListening } from '../lib/speech-input';
import { setupMobileInput } from '../lib/terminal-mobile-input';
import { loadSettings } from '../lib/settings';
import { getIframeInput } from '../lib/xterm-internals';
import { useScrollCorrection } from './useScrollCorrection';

/** DECTCEM (DEC Text Cursor Enable Mode) — the CSI parameter for cursor show/hide sequences */
export const DECTCEM_CURSOR_PARAM = 25;

/** Debounce delay before refitting terminal after virtual keyboard height changes on mobile */
export const KEYBOARD_REFIT_DEBOUNCE_MS = 150;

export interface UseTerminalOptions {
  sessionId: string;
  terminalId: string;
  sessionName?: string;
  active: boolean;
  visible?: boolean;
  focused?: boolean;
  connect?: boolean;
  alwaysObserveResize?: boolean;
  hideInitProgress?: boolean;
  onError?: (error: string) => void;
  onInitComplete?: () => void;
}

interface UseTerminalResult {
  containerRef: (el: HTMLDivElement) => void;
  terminal: () => Terminal | undefined;
  dimensions: () => { cols: number; rows: number };
  retryMessage: () => string | null;
  connectionState: () => string;
  isInitializing: () => boolean;
  initProgress: () => ReturnType<typeof sessionStore.getInitProgressForSession>;
}

function isAtBottom(t: Terminal): boolean {
  return t.buffer.active.viewportY >= t.buffer.active.baseY;
}

export function useTerminal(props: UseTerminalOptions): UseTerminalResult {
  let containerEl: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let cleanup: (() => void) | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let cleanupGestures: (() => void) | undefined;
  let bufferChangeDisposable: { dispose: () => void } | undefined;
  let cursorHideDisposable: { dispose: () => void } | undefined;
  let cursorShowDisposable: { dispose: () => void } | undefined;
  let hasInitialScrolled = false;
  let kbDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let handleContextMenu: ((e: MouseEvent) => void) | undefined;
  let disposed = false;

  const [dimensions, setDimensions] = createSignal({ cols: 80, rows: 24 });
  const [terminalInstance, setTerminalInstance] = createSignal<Terminal | undefined>(undefined);

  const retryMessage = createMemo(() => terminalStore.getRetryMessage(props.sessionId, props.terminalId));
  const connectionState = createMemo(() => terminalStore.getConnectionState(props.sessionId, props.terminalId));
  const isInitializing = createMemo(() => sessionStore.isSessionInitializing(props.sessionId));
  const initProgress = createMemo(() => sessionStore.getInitProgressForSession(props.sessionId));
  const isVisible = () => props.visible ?? props.active;
  const isFocused = () => props.focused ?? props.active;
  const canConnect = () => props.connect ?? isVisible();
  const isMounted = () => !disposed && !!term && !!fitAddon && !!containerEl;

  function setContainerRef(el: HTMLDivElement) {
    containerEl = el;
  }

  function initializeTerminal(container: HTMLDivElement): { termBg: string } {
    const rootStyle = getComputedStyle(document.documentElement);
    const termBg = rootStyle.getPropertyValue('--color-terminal-theme-bg').trim() || '#1a2332';
    const termBlack = rootStyle.getPropertyValue('--color-terminal-theme-black').trim() || '#1a2332';
    const termBrightBlack = rootStyle.getPropertyValue('--color-terminal-theme-bright-black').trim() || '#627088';

    term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Monaco, 'Courier New', 'Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Sans Symbols 2', 'Segoe UI Symbol', 'Apple Symbols', monospace",
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: termBg,
        foreground: '#e4e4f0',
        cursor: '#e4e4f0',
        cursorAccent: '#1a2332',
        selectionBackground: '#d9770644',
        selectionForeground: '#e4e4f0',
        black: termBlack,
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e4e4f0',
        brightBlack: termBrightBlack,
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
      allowProposedApi: true,
      convertEol: true,
      scrollback: 1000,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    registerMultiLineLinkProvider(term);

    // Open terminal - on mobile, swap xterm's textarea for a password input
    // to suppress autocorrect at OS level. Voice input uses Web Speech API
    // (speech-input.ts), completely decoupled from the keyboard input.
    if (isTouchDevice()) {
      const origCreateElement = document.createElement;
      document.createElement = function(tagName: string, options?: ElementCreationOptions) {
        if (tagName.toLowerCase() === 'textarea') {
          const input = origCreateElement.call(document, 'input', options);
          input.setAttribute('type', 'password');
          input.focus = () => {};
          return input;
        }
        return origCreateElement.call(document, tagName, options);
      };
      try {
        term.open(container);
      } finally {
        document.createElement = origCreateElement;
      }
    } else {
      term.open(container);
    }

    // Suppress autocorrect/autocapitalize/spellcheck on the input element.
    // Uses attributes instead of type="password" to preserve voice input.
    const textarea = term.textarea;
    if (textarea) {
      textarea.setAttribute('autocomplete', 'off');
      textarea.setAttribute('autocorrect', 'off');
      textarea.setAttribute('autocapitalize', 'off');
      textarea.setAttribute('spellcheck', 'false');
      textarea.setAttribute('inputmode', 'text');
      textarea.setAttribute('enterkeyhint', 'enter');
      textarea.setAttribute('aria-autocomplete', 'none');
      textarea.style.setProperty('-webkit-user-modify', 'read-write-plaintext-only');
      textarea.setAttribute('data-gramm', 'false');
      textarea.setAttribute('data-gramm_editor', 'false');
      textarea.setAttribute('data-enable-grammarly', 'false');
    }

    // Custom key handler: Shift+Enter (CSI u for Claude Code), Ctrl+C (copy), Ctrl+V (paste)
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      // Shift+Enter → send CSI u encoded sequence so Claude Code can distinguish
      // it from plain Enter and insert a newline instead of submitting.
      // Without this, xterm.js sends \r for both Enter and Shift+Enter.
      if (event.shiftKey && event.key === 'Enter') {
        term!.input('\x1b[13;2u', false);
        return false;
      }
      if (event.ctrlKey && event.key === 'c') {
        const selection = term!.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
          term!.clearSelection();
          return false;
        }
        return true;
      }
      if (event.ctrlKey && event.key === 'v') {
        return false;
      }
      // Ctrl+Space → toggle voice input via Web Speech API
      if (event.ctrlKey && event.key === ' ' && isSpeechSupported()) {
        if (isListening()) {
          stopListening();
        } else {
          startListening((text) => term!.input(text, false));
        }
        return false;
      }
      return true;
    });

    // Right-click to paste (like a real terminal).
    // MUST use bubbling phase (not capture) and MUST NOT stopPropagation —
    // xterm.js needs its own contextmenu handler to run first to manage
    // internal textarea focus. Without that, Chrome's clipboard readText()
    // silently fails on subsequent calls (document focus state broken).
    handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (!term) return;
      if (loadSettings().clipboardAccess !== true) return;
      term.focus();
      navigator.clipboard.readText().then((text) => {
        if (text && term) {
          term.paste(text);
        }
      }).catch(() => {
        // Permission denied or not available
      });
    };
    container.addEventListener('contextmenu', handleContextMenu);

    return { termBg };
  }

  function setupMobileTerminal() {
    if (!term) return;

    // xterm 6.0.0: touch scrolling when keyboard is closed is handled by
    // touch-gestures.ts via terminal.scrollLines() (direct buffer scroll).

    const mobileCleanup = setupMobileInput(term, props, {
      refreshCursorLine: () => {
        term?.refresh(term.buffer.active.cursorY, term.buffer.active.cursorY);
      },
    });
    onCleanup(mobileCleanup);
  }

  onMount(() => {
    if (!containerEl || disposed) return;

    const { termBg } = initializeTerminal(containerEl);
    // initializeTerminal guarantees term and fitAddon are set
    const t = term!;
    const fa = fitAddon!;

    if (isTouchDevice()) {
      setupMobileTerminal();
    }

    // Scroll correction: detects and reverses browser focus-validation bugs that
    // snap the viewport to position 0. Cleanup is handled inside the hook via onCleanup.
    useScrollCorrection(t, containerEl, {
      sessionId: props.sessionId,
      terminalId: props.terminalId,
    });

    terminalStore.setTerminal(props.sessionId, props.terminalId, t);
    terminalStore.registerFitAddon(props.sessionId, props.terminalId, fa);
    setTerminalInstance(t);

    // Fit xterm to container once layout is stable. On mobile (especially
    // Samsung Internet), the container may report clientHeight === 0 during
    // initial mount if the flex layout hasn't resolved yet. Retry with rAF
    // polling instead of giving up — the ResizeObserver backup may not fire
    // if props.active is false during the initializing phase.
    let fitRetries = 0;
    const MAX_FIT_RETRIES = 20; // ~330ms at 60fps
    function tryFit() {
      if (!isMounted()) return;
      const mountedContainer = containerEl!;
      const mountedFitAddon = fitAddon!;
      const mountedTerm = term!;
      if (mountedContainer.clientHeight === 0) {
        if (fitRetries++ < MAX_FIT_RETRIES) {
          requestAnimationFrame(tryFit);
        }
        return;
      }
      mountedFitAddon.fit();
      setDimensions({ cols: mountedTerm.cols, rows: mountedTerm.rows });
    }
    requestAnimationFrame(() => requestAnimationFrame(tryFit));

    // Resize observer
    resizeObserver = new ResizeObserver(() => {
      const shouldResize = canConnect() && (isVisible() || props.alwaysObserveResize);
      if (fitAddon && shouldResize) {
        if (kbDebounceTimer !== null) return;
        requestAnimationFrame(() => {
          if (!isMounted() || kbDebounceTimer !== null) return;
          const mountedContainer = containerEl!;
          const mountedFitAddon = fitAddon!;
          const mountedTerm = term!;
          if (mountedContainer.clientHeight === 0) return;
          const wasBottom = isAtBottom(mountedTerm);
          mountedFitAddon.fit();
          // Fix 16: ResizeObserver should NOT call scrollToBottom() when keyboard
          // is open. The keyboard height change effect (leading + trailing edge)
          // already handles fit + scrollToBottom during keyboard animation.
          // Having RO also scroll creates oscillation from competing scroll calls.
          // Only scroll on desktop/keyboard-closed when user was following output.
          if (!isTouchDevice() || !isVirtualKeyboardOpen()) {
            if (wasBottom) {
              mountedTerm.scrollToBottom();
            }
          }
          const cols = mountedTerm.cols;
          const rows = mountedTerm.rows;
          setDimensions({ cols, rows });
          if (isFocused()) terminalStore.claimResizeAuthority(props.sessionId, props.terminalId);
          terminalStore.resize(props.sessionId, props.terminalId, cols, rows);
        });
      }
    });
    resizeObserver.observe(containerEl);

    // Cursor visibility tracking
    const origCursorColor = '#d97706';
    let isCursorHidden = false;

    const applyCursorVisibility = () => {
      if (!term || disposed) return;
      // Always keep cursor visible — CLI apps (Copilot, Claude Code, Codex)
      // in alternate buffer mode need xterm's cursor layer. Hiding it caused
      // invisible cursors in newer CLI versions that rely on it.
      if (isCursorHidden) {
        term.options.theme = { ...term.options.theme, cursor: 'transparent', cursorAccent: 'transparent' };
      } else {
        term.options.theme = { ...term.options.theme, cursor: origCursorColor, cursorAccent: termBg };
      }
    };

    bufferChangeDisposable = t.buffer.onBufferChange(() => {
      applyCursorVisibility();
    });

    cursorHideDisposable = t.parser.registerCsiHandler(
      { prefix: '?', final: 'l' },
      (params) => {
        if (params[0] === DECTCEM_CURSOR_PARAM) { isCursorHidden = true; applyCursorVisibility(); }
        return false;
      },
    );
    cursorShowDisposable = t.parser.registerCsiHandler(
      { prefix: '?', final: 'h' },
      (params) => {
        if (params[0] === DECTCEM_CURSOR_PARAM) { isCursorHidden = false; applyCursorVisibility(); }
        return false;
      },
    );

    cleanupGestures = attachSwipeGestures(containerEl, t, isVirtualKeyboardOpen);

    // Font loading fix
    if (document.fonts) {
      const currentFont = t.options.fontFamily;
      document.fonts.ready.then(() => {
        if (isMounted() && term?.element && currentFont) {
          const wasBottom = isAtBottom(term);
          term.options.fontFamily = currentFont;
          fitAddon?.fit();
          if (wasBottom) term.scrollToBottom();
        }
      });
    }
  });

  // xterm 6.0.0 moved scrolling from .xterm-viewport (native overflow) to
  // SmoothScrollableElement (JS-based). Touch scrolling when keyboard is closed
  // is handled by touch-gestures.ts via terminal.scrollLines() — no need for
  // pointer-events or overflow-y tricks on viewport/scrollable-element.

  // Refit on keyboard height change — leading + trailing edge pattern.
  //
  // Problem: When the keyboard opens, padding-bottom increases instantly (SolidJS
  // reactive binding), shrinking the terminal container. But if fit() is delayed
  // (debounced), xterm's canvas stays at the old (larger) dimensions for ~150ms.
  // During this gap the canvas overflows the container, hiding the prompt behind
  // the keyboard and causing a visible content jump when fit() finally fires.
  //
  // Solution: Call fit() + scrollToBottom() immediately via queueMicrotask on the
  // FIRST keyboard height change (leading edge). The microtask runs after SolidJS
  // has applied the padding-bottom DOM update but before the browser paints —
  // eliminating the visual gap. Subsequent height changes during the keyboard
  // animation are debounced (trailing edge) to avoid excessive refitting.
  // The PTY resize message is only sent on the trailing edge.
  createEffect(() => {
    const kbHeight = getKeyboardHeight();
    const _kbOpen = isVirtualKeyboardOpen();
    if (!isTouchDevice()) return;
    if (!isMounted()) return;
    if (!(canConnect() && (isVisible() || props.alwaysObserveResize))) return;

    // Leading edge: immediate fit on first REAL keyboard change (height > 0).
    // Skip the initial mount-time run (kbHeight=0) — the onMount double-rAF
    // handles that. queueMicrotask ensures we run after all SolidJS effects in
    // this batch (including the padding-bottom DOM update) but before the
    // browser's rendering pipeline (layout, ResizeObserver, rAF, paint).
    if (kbDebounceTimer === null && kbHeight > 0) {
      queueMicrotask(() => {
        if (!isMounted()) return;
        const mountedContainer = containerEl!;
        const mountedFitAddon = fitAddon!;
        const mountedTerm = term!;
        if (mountedContainer.clientHeight === 0) return;
        mountedFitAddon.fit();
        // Read signal at execution time — not the stale closure capture
        if (isVirtualKeyboardOpen()) {
          mountedTerm.scrollToBottom();
        }
        setDimensions({ cols: mountedTerm.cols, rows: mountedTerm.rows });
      });
    }

    // Trailing edge: debounced fit after keyboard animation settles.
    // Sends PTY resize message only here to avoid flooding the server
    // with intermediate dimensions during the ~300ms animation.
    if (kbDebounceTimer !== null) clearTimeout(kbDebounceTimer);
    kbDebounceTimer = setTimeout(() => {
      kbDebounceTimer = null;
      if (!isMounted()) return;
      const mountedContainer = containerEl!;
      const mountedFitAddon = fitAddon!;
      const mountedTerm = term!;
      if (mountedContainer.clientHeight === 0) return;
      mountedFitAddon.fit();
      // Read signal at execution time — not the stale closure capture
      if (isVirtualKeyboardOpen()) {
        mountedTerm.scrollToBottom();
      }
      setDimensions({ cols: mountedTerm.cols, rows: mountedTerm.rows });
      if (isFocused()) terminalStore.claimResizeAuthority(props.sessionId, props.terminalId);
      terminalStore.resize(props.sessionId, props.terminalId, mountedTerm.cols, mountedTerm.rows);
    }, KEYBOARD_REFIT_DEBOUNCE_MS);
    onCleanup(() => {
      if (kbDebounceTimer !== null) {
        clearTimeout(kbDebounceTimer);
        kbDebounceTimer = null;
      }
    });
  });

  // Connect WebSocket: at mounting stage during init (agent loads in background),
  // or immediately when session is already running (e.g. tab switch, page reload).
  createEffect(() => {
    const initializing = isInitializing();
    const stage = initProgress()?.stage;
    // Terminal server is up at 'mounting' or 'ready' — safe to connect WS
    const shouldConnect = !initializing || stage === 'mounting' || stage === 'ready';

    if ((!canConnect() || !shouldConnect) && cleanup) {
      cleanup();
      cleanup = undefined;
      terminalStore.stopUrlDetection(props.sessionId, props.terminalId);
      return;
    }

    if (canConnect() && shouldConnect && term && !cleanup) {
      logger.debug(`[Terminal ${props.sessionId}:${props.terminalId}] Connecting WebSocket (stage: ${stage || 'running'})`);
      const terminals = sessionStore.getTerminalsForSession(props.sessionId);
      const tab = terminals?.tabs.find(t => t.id === props.terminalId);
      cleanup = terminalStore.connect(props.sessionId, props.terminalId, term, props.onError, tab?.manual);
    }
  });

  createEffect(() => {
    const focusedTerm = terminalInstance();
    const initializing = isInitializing();
    const stage = initProgress()?.stage;
    const shouldConnect = !initializing || stage === 'mounting' || stage === 'ready';
    if (!isFocused() || !canConnect() || !shouldConnect || !focusedTerm) {
      terminalStore.clearPendingResizeAuthority(props.sessionId, props.terminalId);
      return;
    }
    terminalStore.claimResizeAuthority(props.sessionId, props.terminalId);
    terminalStore.startUrlDetection(props.sessionId, props.terminalId);
    if (!isTouchDevice()) focusedTerm.focus();
    if (focusedTerm.cols > 0 && focusedTerm.rows > 0) {
      terminalStore.resize(props.sessionId, props.terminalId, focusedTerm.cols, focusedTerm.rows);
    }
    onCleanup(() => {
      terminalStore.clearPendingResizeAuthority(props.sessionId, props.terminalId);
      terminalStore.stopUrlDetection(props.sessionId, props.terminalId);
    });
  });

  // Keyboard lifecycle for mobile
  createEffect(() => {
    if (isFocused() && isTouchDevice()) {
      resetKeyboardStateIfStale();
      enableVirtualKeyboardOverlay();
      requestAnimationFrame(() => {
        if (!isMounted()) return;
        const mountedContainer = containerEl!;
        const mountedFitAddon = fitAddon!;
        const mountedTerm = term!;
        if (mountedContainer.clientHeight > 0) {
          const wasBottom = isAtBottom(mountedTerm);
          mountedFitAddon.fit();
          if (wasBottom) mountedTerm.scrollToBottom();
        }
      });

      // Fix 1: Samsung back-button keyboard dismiss detection via focusout.
      // Samsung doesn't fire geometrychange when back button dismisses keyboard.
      let focusoutHandler: (() => void) | undefined;
      let focusoutDeferTimer: ReturnType<typeof setTimeout> | null = null;
      if (isSamsungBrowser) {
        const inputEl = term ? getIframeInput(term) || term.textarea : undefined;
        if (inputEl) {
          focusoutHandler = () => {
            // Defer one tick so the focus transition settles, then tell a real
            // back-button dismiss (focus left the terminal) from a pane-to-pane
            // handoff (focus moved to a sibling terminal input — keep keyboard).
            focusoutDeferTimer = setTimeout(() => {
              focusoutDeferTimer = null;
              if (isFocusOnTerminalInput()) return;
              if (isVirtualKeyboardOpen()) forceResetKeyboardState();
            }, 0);
          };
          inputEl.addEventListener('focusout', focusoutHandler);
        }
      }

      onCleanup(() => {
        if (focusoutHandler) {
          const inputEl = term ? getIframeInput(term) || term.textarea : undefined;
          inputEl?.removeEventListener('focusout', focusoutHandler);
        }
        if (focusoutDeferTimer !== null) { clearTimeout(focusoutDeferTimer); focusoutDeferTimer = null; }
        // Focus moving to a sibling terminal pane is a handoff, not an exit:
        // keep the shared virtual-keyboard state so the newly focused pane stays
        // in keyboard mode. Tear down only when focus has left the terminal
        // (true exit / unmount is covered here and by the iframe-removal cleanup).
        if (isFocusOnTerminalInput()) return;
        const iframeInput = term ? getIframeInput(term) : undefined;
        if (iframeInput) iframeInput.blur();
        disableVirtualKeyboardOverlay();
        forceResetKeyboardState();
      });
    }
  });

  // Active state changes + cursor bugfix
  createEffect(() => {
    if (isVisible() && fitAddon && term) {
      requestAnimationFrame(() => {
        if (!isMounted()) return;
        const mountedContainer = containerEl!;
        const mountedFitAddon = fitAddon!;
        const mountedTerm = term!;
        if (mountedContainer.clientHeight === 0) return;
        const wasBottom = isAtBottom(mountedTerm);
        mountedFitAddon.fit();
        // First activation: always scroll to bottom so user sees the prompt.
        // Subsequent activations: only if user was already following output,
        // or if the mobile keyboard is open (user expects to see the prompt).
        if (!hasInitialScrolled || wasBottom || (isTouchDevice() && isVirtualKeyboardOpen())) {
          mountedTerm.scrollToBottom();
          hasInitialScrolled = true;
        }
        mountedTerm.refresh(0, mountedTerm.rows - 1);
        if (isFocused() && !isTouchDevice()) mountedTerm.focus();
        if (canConnect()) {
          if (isFocused()) terminalStore.claimResizeAuthority(props.sessionId, props.terminalId);
          terminalStore.resize(props.sessionId, props.terminalId, mountedTerm.cols, mountedTerm.rows);
        }
      });
    }
  });

  // Refit after init overlay hides
  createEffect(() => {
    const initializing = isInitializing();
    if (!initializing && fitAddon && term && isVisible()) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!isMounted()) return;
          const mountedContainer = containerEl!;
          const mountedFitAddon = fitAddon!;
          const mountedTerm = term!;
          if (mountedContainer.clientHeight === 0) return;
          const wasBottom = isAtBottom(mountedTerm);
          mountedFitAddon.fit();
          if (wasBottom) mountedTerm.scrollToBottom();
          mountedTerm.refresh(0, mountedTerm.rows - 1);
          if (canConnect()) {
            if (isFocused()) terminalStore.claimResizeAuthority(props.sessionId, props.terminalId);
            terminalStore.resize(props.sessionId, props.terminalId, mountedTerm.cols, mountedTerm.rows);
          }
        });
      });
    }
  });

  onCleanup(() => {
    disposed = true;
    const mountedContainer = containerEl;
    if (kbDebounceTimer !== null) {
      clearTimeout(kbDebounceTimer);
      kbDebounceTimer = null;
    }
    cleanup?.();
    cleanupGestures?.();
    bufferChangeDisposable?.dispose();
    cursorHideDisposable?.dispose();
    cursorShowDisposable?.dispose();
    resizeObserver?.disconnect();
    terminalStore.stopUrlDetection(props.sessionId, props.terminalId);
    if (handleContextMenu) mountedContainer?.removeEventListener('contextmenu', handleContextMenu);
    term = undefined;
    fitAddon = undefined;
    containerEl = undefined;
    setTerminalInstance(undefined);
    terminalStore.disposeLocalTerminal(props.sessionId, props.terminalId);
  });

  return {
    containerRef: setContainerRef,
    terminal: terminalInstance,
    dimensions,
    retryMessage,
    connectionState,
    isInitializing,
    initProgress,
  };
}
