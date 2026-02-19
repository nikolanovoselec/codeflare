import { onMount, onCleanup, createEffect, createSignal, createMemo } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminalStore } from '../stores/terminal';
import { sessionStore } from '../stores/session';
import { logger } from '../lib/logger';
import { isTouchDevice, isVirtualKeyboardOpen, getKeyboardHeight, enableVirtualKeyboardOverlay, disableVirtualKeyboardOverlay, resetKeyboardStateIfStale, forceResetKeyboardState } from '../lib/mobile';
import { attachSwipeGestures } from '../lib/touch-gestures';
import { registerMultiLineLinkProvider } from '../lib/terminal-link-provider';
import { setupMobileInput } from '../lib/terminal-mobile-input';

export interface UseTerminalOptions {
  sessionId: string;
  terminalId: string;
  sessionName?: string;
  active: boolean;
  alwaysObserveResize?: boolean;
  hideInitProgress?: boolean;
  onError?: (error: string) => void;
  onInitComplete?: () => void;
}

export interface UseTerminalResult {
  containerRef: (el: HTMLDivElement) => void;
  terminal: () => Terminal | undefined;
  dimensions: () => { cols: number; rows: number };
  retryMessage: () => string | null;
  connectionState: () => string;
  isInitializing: () => boolean;
  initProgress: () => ReturnType<typeof sessionStore.getInitProgressForSession>;
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
  let kbDebouncePending = false;
  let handleContextMenu: ((e: MouseEvent) => void) | undefined;

  const [dimensions, setDimensions] = createSignal({ cols: 80, rows: 24 });
  const [terminalInstance, setTerminalInstance] = createSignal<Terminal | undefined>(undefined);

  const retryMessage = createMemo(() => terminalStore.getRetryMessage(props.sessionId, props.terminalId));
  const connectionState = createMemo(() => terminalStore.getConnectionState(props.sessionId, props.terminalId));
  const isInitializing = createMemo(() => sessionStore.isSessionInitializing(props.sessionId));
  const initProgress = createMemo(() => sessionStore.getInitProgressForSession(props.sessionId));

  function setContainerRef(el: HTMLDivElement) {
    containerEl = el;
  }

  onMount(() => {
    if (!containerEl) return;

    const rootStyle = getComputedStyle(document.documentElement);
    const termBg = rootStyle.getPropertyValue('--color-terminal-theme-bg').trim() || '#1a2332';
    const termBlack = rootStyle.getPropertyValue('--color-terminal-theme-black').trim() || '#1a2332';
    const termBrightBlack = rootStyle.getPropertyValue('--color-terminal-theme-bright-black').trim() || '#627088';

    term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'block',
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Monaco, 'Courier New', 'Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Sans Symbols 2', 'Segoe UI Symbol', 'Apple Symbols', monospace",
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: termBg,
        foreground: '#e4e4f0',
        cursor: 'transparent',
        cursorAccent: 'transparent',
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
      scrollback: 10000,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    registerMultiLineLinkProvider(term);

    // Open terminal - on mobile, swap xterm's textarea for a password input to disable IME
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
        term.open(containerEl);
      } finally {
        document.createElement = origCreateElement;
      }
    } else {
      term.open(containerEl);
    }

    // Disable xterm's internal Viewport touch handlers on mobile.
    // xterm manually manipulates scrollTop on touchmove which fights with
    // native browser scrolling (CSS touch-action: pan-y). No-op them so
    // only native scroll + our swipe gestures handle touch.
    if (isTouchDevice()) {
      const viewport = (term as any)._core?.viewport;
      if (viewport) {
        viewport.handleTouchStart = () => {};
        viewport.handleTouchMove = () => true; // return true = don't cancel event
      }
    }

    if (isTouchDevice()) {
      const mobileCleanup = setupMobileInput(term, props, {
        refreshCursorLine: () => {
          term?.refresh(term.buffer.active.cursorY, term.buffer.active.cursorY);
        },
      });
      onCleanup(mobileCleanup);
    }

    // Disable mobile IME composition
    const textarea = term.textarea;
    if (textarea) {
      textarea.setAttribute('autocomplete', 'off');
      textarea.setAttribute('autocorrect', 'off');
      textarea.setAttribute('autocapitalize', 'off');
      textarea.setAttribute('spellcheck', 'false');
      textarea.setAttribute('inputmode', 'text');
      textarea.setAttribute('enterkeyhint', 'enter');
      (textarea.style as any).webkitUserModify = 'read-write-plaintext-only';
      textarea.setAttribute('data-gramm', 'false');
      textarea.setAttribute('data-gramm_editor', 'false');
      textarea.setAttribute('data-enable-grammarly', 'false');
    }

    // Ctrl+C/V key handler
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
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
      return true;
    });

    // Right-click to paste (like a real terminal).
    // navigator.clipboard.readText() requires 'clipboard-read' permission.
    // Some browsers revoke the transient activation after the first async call,
    // causing subsequent right-click pastes to silently fail. We re-query the
    // permission state and re-request if needed, and always refocus the terminal.
    handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      // Stop xterm's own contextmenu handler from running — it calls
      // moveTextAreaUnderMouseCursor + textarea.select() which can
      // interfere with clipboard read on subsequent right-clicks.
      e.stopPropagation();
      if (!term) return;
      // Focus textarea so clipboard read has a focused editable context
      term.textarea?.focus({ preventScroll: true });
      navigator.clipboard.readText().then((text) => {
        if (text && term) {
          term.paste(text);
          term.textarea?.focus({ preventScroll: true });
        }
      }).catch(() => {
        // Permission denied or not available
      });
    };
    containerEl.addEventListener('contextmenu', handleContextMenu, true);

    terminalStore.setTerminal(props.sessionId, props.terminalId, term);
    terminalStore.registerFitAddon(props.sessionId, props.terminalId, fitAddon);
    setTerminalInstance(term);

    requestAnimationFrame(() => {
      if (!fitAddon || !containerEl || !term) return;
      fitAddon.fit();
      setDimensions({ cols: term.cols, rows: term.rows });
    });

    // Resize observer
    resizeObserver = new ResizeObserver(() => {
      const shouldResize = props.active || props.alwaysObserveResize;
      if (fitAddon && shouldResize) {
        if (kbDebouncePending) return;
        requestAnimationFrame(() => {
          if (!fitAddon || !term || kbDebouncePending) return;
          fitAddon.fit();
          const cols = term.cols;
          const rows = term.rows;
          setDimensions({ cols, rows });
          terminalStore.resize(props.sessionId, props.terminalId, cols, rows);
        });
      }
    });
    resizeObserver.observe(containerEl);

    // Cursor visibility tracking
    const origCursorColor = '#d97706';
    let isAlternateBuffer = false;
    let isCursorHidden = false;

    const applyCursorVisibility = () => {
      if (!term) return;
      if (isAlternateBuffer || isCursorHidden) {
        term.options.theme = { ...term.options.theme, cursor: 'transparent', cursorAccent: 'transparent' };
      } else {
        term.options.theme = { ...term.options.theme, cursor: origCursorColor, cursorAccent: termBg };
      }
    };

    bufferChangeDisposable = term.buffer.onBufferChange((buf) => {
      isAlternateBuffer = buf.type === 'alternate';
      applyCursorVisibility();
    });

    cursorHideDisposable = term.parser.registerCsiHandler(
      { prefix: '?', final: 'l' },
      (params) => {
        if (params[0] === 25) { isCursorHidden = true; applyCursorVisibility(); }
        return false;
      },
    );
    cursorShowDisposable = term.parser.registerCsiHandler(
      { prefix: '?', final: 'h' },
      (params) => {
        if (params[0] === 25) { isCursorHidden = false; applyCursorVisibility(); }
        return false;
      },
    );

    cleanupGestures = attachSwipeGestures(containerEl, term, isVirtualKeyboardOpen);

    // Font loading fix
    if (document.fonts) {
      const currentFont = term.options.fontFamily;
      document.fonts.ready.then(() => {
        if (term && currentFont) {
          term.options.fontFamily = currentFont;
          fitAddon?.fit();
        }
      });
    }
  });

  // Virtual keyboard scroll lock
  createEffect(() => {
    if (!containerEl || !isTouchDevice()) return;
    const kbOpen = isVirtualKeyboardOpen();
    const viewport = containerEl.querySelector('.xterm-viewport') as HTMLElement | null;
    if (!viewport) return;
    viewport.style.overflowY = kbOpen ? 'hidden' : '';
    onCleanup(() => { viewport.style.overflowY = ''; });
  });

  // Refit on keyboard height change
  createEffect(() => {
    const kbHeight = getKeyboardHeight();
    if (!isTouchDevice()) return;
    if (!term || !fitAddon) return;
    if (!(props.active || props.alwaysObserveResize)) return;

    kbDebouncePending = true;
    const timer = setTimeout(() => {
      kbDebouncePending = false;
      if (!fitAddon || !term) return;
      fitAddon.fit();
      term.scrollToBottom();
      setDimensions({ cols: term.cols, rows: term.rows });
      terminalStore.resize(props.sessionId, props.terminalId, term.cols, term.rows);
      window.scrollTo(0, 0);
    }, 150);
    onCleanup(() => clearTimeout(timer));
  });

  // Connect WebSocket after init completes
  createEffect(() => {
    const initializing = isInitializing();
    if (!initializing && term && !cleanup) {
      logger.debug(`[Terminal ${props.sessionId}:${props.terminalId}] Session ready, connecting WebSocket`);
      // Look up tab to check if it was manually created (user clicked "+")
      const terminals = sessionStore.getTerminalsForSession(props.sessionId);
      const tab = terminals?.tabs.find(t => t.id === props.terminalId);
      cleanup = terminalStore.connect(props.sessionId, props.terminalId, term, props.onError, tab?.manual);
      terminalStore.startUrlDetection(props.sessionId, props.terminalId);
    }
  });

  // Keyboard lifecycle for mobile
  createEffect(() => {
    if (props.active && isTouchDevice()) {
      resetKeyboardStateIfStale();
      enableVirtualKeyboardOverlay();
      requestAnimationFrame(() => {
        if (fitAddon && term) fitAddon.fit();
      });

      onCleanup(() => {
        const iframeInput = (term as any)?.__iframeInput as HTMLInputElement | undefined;
        if (iframeInput) iframeInput.blur();
        disableVirtualKeyboardOverlay();
        forceResetKeyboardState();
      });
    }
  });

  // Active state changes + cursor bugfix
  createEffect(() => {
    if (props.active && fitAddon && term) {
      requestAnimationFrame(() => {
        if (!fitAddon || !term) return;
        fitAddon.fit();
        if (!isTouchDevice() || !hasInitialScrolled) {
          term.scrollToBottom();
          hasInitialScrolled = true;
        }
        term.refresh(0, term.rows - 1);
        if (!isTouchDevice()) term.focus();
        terminalStore.resize(props.sessionId, props.terminalId, term.cols, term.rows);
      });
    }
  });

  // Refit after init overlay hides
  createEffect(() => {
    const initializing = isInitializing();
    if (!initializing && fitAddon && term && props.active) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!fitAddon || !term) return;
          fitAddon.fit();
          term.scrollToBottom();
          term.refresh(0, term.rows - 1);
          terminalStore.resize(props.sessionId, props.terminalId, term.cols, term.rows);
        });
      });
    }
  });

  onCleanup(() => {
    cleanup?.();
    cleanupGestures?.();
    bufferChangeDisposable?.dispose();
    cursorHideDisposable?.dispose();
    cursorShowDisposable?.dispose();
    resizeObserver?.disconnect();
    terminalStore.stopUrlDetection();
    terminalStore.unregisterFitAddon(props.sessionId, props.terminalId);
    if (handleContextMenu) containerEl?.removeEventListener('contextmenu', handleContextMenu, true);
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
