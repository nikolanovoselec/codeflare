import { onMount, onCleanup, createEffect, createSignal, createMemo } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminalStore } from '../stores/terminal';
import { sessionStore } from '../stores/session';
import { logger } from '../lib/logger';
import { isTouchDevice, isVirtualKeyboardOpen, getKeyboardHeight, enableVirtualKeyboardOverlay, disableVirtualKeyboardOverlay, resetKeyboardStateIfStale, forceResetKeyboardState, isSamsungBrowser } from '../lib/mobile';
import { attachSwipeGestures } from '../lib/touch-gestures';
import { registerMultiLineLinkProvider } from '../lib/terminal-link-provider';
import { setupMobileInput } from '../lib/terminal-mobile-input';
import { loadSettings } from '../lib/settings';
import { getIframeInput } from '../lib/xterm-internals';
import { hasRecentScrollIntent, clearScrollIntent } from '../lib/terminal-scroll-intent';

/** DECTCEM (DEC Text Cursor Enable Mode) — the CSI parameter for cursor show/hide sequences */
export const DECTCEM_CURSOR_PARAM = 25;

/** Debounce delay before refitting terminal after virtual keyboard height changes on mobile */
export const KEYBOARD_REFIT_DEBOUNCE_MS = 150;

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
  let scrollDropDisposable: { dispose: () => void } | undefined;
  let scrollIntentCleanup: (() => void) | undefined;

  const [dimensions, setDimensions] = createSignal({ cols: 80, rows: 24 });
  const [terminalInstance, setTerminalInstance] = createSignal<Terminal | undefined>(undefined);

  const retryMessage = createMemo(() => terminalStore.getRetryMessage(props.sessionId, props.terminalId));
  const connectionState = createMemo(() => terminalStore.getConnectionState(props.sessionId, props.terminalId));
  const isInitializing = createMemo(() => sessionStore.isSessionInitializing(props.sessionId));
  const initProgress = createMemo(() => sessionStore.getInitProgressForSession(props.sessionId));

  function setContainerRef(el: HTMLDivElement) {
    containerEl = el;
  }

  function initializeTerminal(container: HTMLDivElement): { termBg: string } {
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
      scrollback: 400,
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
        term.open(container);
      } finally {
        document.createElement = origCreateElement;
      }
    } else {
      term.open(container);
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
    if (!containerEl) return;

    const { termBg } = initializeTerminal(containerEl);
    // initializeTerminal guarantees term and fitAddon are set
    const t = term!;
    const fa = fitAddon!;

    if (isTouchDevice()) {
      setupMobileTerminal();
    }

    // Fix 13: Scroll-reset detector for ALL devices.
    // Catches the browser focus-validation bug that snaps viewport to position 0.
    // CSS overflow:hidden on .xterm-viewport is the primary defense; this detector
    // is belt-and-suspenders for resets from any source.
    //
    // Key change from Fixes 9-12: narrowed from `ydisp < ybase` to `ydisp === 0`.
    // The browser focus-reset ALWAYS goes to position 0 (scroll origin). The old
    // broad check fought legitimate scrolls (floating buttons, xterm's native
    // scrollback trimming at 10k lines) causing terminal oscillation during output.
    //
    // The old `drop > 3` heuristic (Fix 11) is removed: xterm.js natively adjusts
    // viewportY when trimming scrollback lines to keep the viewport visually stable.
    // The heuristic detected this native adjustment as an error and reversed it,
    // causing the very jump it was meant to prevent.
    {
      let wasFollowingOutput = true;
      let previousYdisp = 0;
      let previousDistFromBottom = 0;
      let lastUserScrollIntentAt = 0;
      let isCorrectingScroll = false;
      const USER_SCROLL_GRACE_MS = 150;

      const markUserScrollIntent = () => { lastUserScrollIntentAt = Date.now(); };
      const onNavKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') {
          markUserScrollIntent();
        }
      };

      containerEl.addEventListener('wheel', markUserScrollIntent, { passive: true });
      containerEl.addEventListener('pointerdown', markUserScrollIntent, { passive: true });
      containerEl.addEventListener('keydown', onNavKeyDown);

      scrollIntentCleanup = () => {
        containerEl?.removeEventListener('wheel', markUserScrollIntent);
        containerEl?.removeEventListener('pointerdown', markUserScrollIntent);
        containerEl?.removeEventListener('keydown', onNavKeyDown);
      };

      scrollDropDisposable = t.onScroll((ydisp: number) => {
        const ybase = t.buffer.active.baseY;
        const distFromBottom = ybase - ydisp;

        // Always update tracking state, even when suppressed
        if (isCorrectingScroll) {
          wasFollowingOutput = ydisp >= ybase;
          previousYdisp = ydisp;
          previousDistFromBottom = distFromBottom;
          return;
        }

        // Fix 18: Skip detection for scroll events caused by our own post-write
        // corrections in flushWriteBuffer. These are tagged with a suppression
        // counter to prevent cross-triggering feedback loops during trim.
        // Still update baselines so the next unsuppressed event compares correctly.
        if (terminalStore.isProgrammaticScrollSuppressed(props.sessionId, props.terminalId)) {
          wasFollowingOutput = ydisp >= ybase;
          previousYdisp = ydisp;
          previousDistFromBottom = distFromBottom;
          return;
        }

        const wasFollowing = wasFollowingOutput;
        wasFollowingOutput = ydisp >= ybase;

        // Fix 19: Bottom-following re-anchor in onScroll (before render).
        // xterm's onScroll fires synchronously during the parse loop, BEFORE
        // the rAF render pass. If the user was following output and got displaced
        // during scrollback trimming, correct immediately — this prevents the
        // visible one-frame jitter that occurred with the write callback approach.
        // User intent (wheel/pointerdown/keydown) is checked to avoid trapping
        // the user at the bottom when they intentionally scroll up.
        if (wasFollowing && ydisp < ybase) {
          const recentIntent = Date.now() - lastUserScrollIntentAt < USER_SCROLL_GRACE_MS
            || hasRecentScrollIntent(props.sessionId, props.terminalId, USER_SCROLL_GRACE_MS);
          if (!recentIntent) {
            isCorrectingScroll = true;
            try {
              t.scrollToBottom();
            } finally {
              isCorrectingScroll = false;
            }
            wasFollowingOutput = true;
            previousYdisp = t.buffer.active.viewportY;
            previousDistFromBottom = t.buffer.active.baseY - t.buffer.active.viewportY;
            return;
          }
        }

        // Fix 16: When virtual keyboard is open, skip all scroll correction.
        // The terminal is in bottom-anchored mode — the write callback handles
        // scrollToBottom(). Any scroll corrections here fight with the keyboard
        // effect and write callback, causing visible oscillation.
        if (isTouchDevice() && isVirtualKeyboardOpen()) {
          previousYdisp = ydisp;
          previousDistFromBottom = distFromBottom;
          return;
        }

        const recentLocalIntent = Date.now() - lastUserScrollIntentAt < USER_SCROLL_GRACE_MS;
        const recentExternalIntent = hasRecentScrollIntent(
          props.sessionId, props.terminalId, USER_SCROLL_GRACE_MS
        );
        const recentUserIntent = recentLocalIntent || recentExternalIntent;

        // Fix 15: Distance-based scroll reset detection.
        //
        // Previous fixes (13-14) checked `ydisp === 0` to detect browser focus resets.
        // This false-positived during scrollback trimming: xterm legitimately decrements
        // ydisp as old lines are removed, eventually reaching 0. Fix 14 misidentified
        // this as a browser bug and applied wrong corrections (scrollLines with absolute
        // position instead of delta), pinning users at the top.
        //
        // The correct invariant is distance-from-bottom. During normal scrollback
        // trimming, distance stays roughly constant (both baseY and ydisp shift together).
        // During a browser focus reset, ydisp snaps to 0 while baseY stays large,
        // causing distance to jump dramatically.
        //
        // Detection: ydisp dropped to 0 AND distance-from-bottom changed by >20 lines
        // from the previous state. This cannot happen during normal trimming (distance
        // changes by at most 1-2 lines per trim) but always happens during a browser
        // focus reset (distance jumps from ~0 to baseY).
        const distanceDrift = Math.abs(distFromBottom - previousDistFromBottom);
        const suspiciousReset =
          !recentUserIntent &&
          ydisp === 0 &&
          previousYdisp > 20 &&
          ybase > 20 &&
          distanceDrift > 20;

        if (suspiciousReset) {
          isCorrectingScroll = true;
          const restoreDistance = wasFollowing ? 0 : previousDistFromBottom;
          queueMicrotask(() => {
            try {
              const currentBaseY = t.buffer.active.baseY;
              const currentY = t.buffer.active.viewportY;
              if (currentBaseY <= 0) return;
              const targetY = Math.max(0, currentBaseY - restoreDistance);
              const delta = targetY - currentY;
              if (delta !== 0) {
                t.scrollLines(delta);
              } else if (restoreDistance === 0) {
                t.scrollToBottom();
              }
            } finally {
              isCorrectingScroll = false;
            }
          });
        }

        previousYdisp = ydisp;
        previousDistFromBottom = distFromBottom;
      });
    }

    terminalStore.setTerminal(props.sessionId, props.terminalId, t);
    terminalStore.registerFitAddon(props.sessionId, props.terminalId, fa);
    setTerminalInstance(t);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!fitAddon || !containerEl || !term) return;
        if (containerEl.clientHeight === 0) return;
        fitAddon.fit();
        setDimensions({ cols: term.cols, rows: term.rows });
      });
    });

    // Resize observer
    resizeObserver = new ResizeObserver(() => {
      const shouldResize = props.active || props.alwaysObserveResize;
      if (fitAddon && shouldResize) {
        if (kbDebounceTimer !== null) return;
        requestAnimationFrame(() => {
          if (!fitAddon || !term || !containerEl || kbDebounceTimer !== null) return;
          if (containerEl.clientHeight === 0) return;
          const wasBottom = isAtBottom(term);
          fitAddon.fit();
          // Fix 16: ResizeObserver should NOT call scrollToBottom() when keyboard
          // is open. The keyboard height change effect (leading + trailing edge)
          // already handles fit + scrollToBottom during keyboard animation.
          // Having RO also scroll creates oscillation from competing scroll calls.
          // Only scroll on desktop/keyboard-closed when user was following output.
          if (!isTouchDevice() || !isVirtualKeyboardOpen()) {
            if (wasBottom) {
              term.scrollToBottom();
            }
          }
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

    bufferChangeDisposable = t.buffer.onBufferChange((buf) => {
      isAlternateBuffer = buf.type === 'alternate';
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
        if (term?.element && currentFont) {
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
    if (!term || !fitAddon) return;
    if (!(props.active || props.alwaysObserveResize)) return;

    // Leading edge: immediate fit on first REAL keyboard change (height > 0).
    // Skip the initial mount-time run (kbHeight=0) — the onMount double-rAF
    // handles that. queueMicrotask ensures we run after all SolidJS effects in
    // this batch (including the padding-bottom DOM update) but before the
    // browser's rendering pipeline (layout, ResizeObserver, rAF, paint).
    if (kbDebounceTimer === null && kbHeight > 0) {
      queueMicrotask(() => {
        if (!fitAddon || !term || !containerEl) return;
        if (containerEl.clientHeight === 0) return;
        fitAddon.fit();
        // Read signal at execution time — not the stale closure capture
        if (isVirtualKeyboardOpen()) {
          term.scrollToBottom();
        }
        setDimensions({ cols: term.cols, rows: term.rows });
      });
    }

    // Trailing edge: debounced fit after keyboard animation settles.
    // Sends PTY resize message only here to avoid flooding the server
    // with intermediate dimensions during the ~300ms animation.
    if (kbDebounceTimer !== null) clearTimeout(kbDebounceTimer);
    kbDebounceTimer = setTimeout(() => {
      kbDebounceTimer = null;
      if (!fitAddon || !term || !containerEl) return;
      if (containerEl.clientHeight === 0) return;
      fitAddon.fit();
      // Read signal at execution time — not the stale closure capture
      if (isVirtualKeyboardOpen()) {
        term.scrollToBottom();
      }
      setDimensions({ cols: term.cols, rows: term.rows });
      terminalStore.resize(props.sessionId, props.terminalId, term.cols, term.rows);
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

    if (shouldConnect && term && !cleanup) {
      logger.debug(`[Terminal ${props.sessionId}:${props.terminalId}] Connecting WebSocket (stage: ${stage || 'running'})`);
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
        if (fitAddon && term && containerEl && containerEl.clientHeight > 0) {
          const wasBottom = isAtBottom(term);
          fitAddon.fit();
          if (wasBottom) term.scrollToBottom();
        }
      });

      // Fix 1: Samsung back-button keyboard dismiss detection via focusout.
      // Samsung doesn't fire geometrychange when back button dismisses keyboard.
      let focusoutHandler: (() => void) | undefined;
      if (isSamsungBrowser) {
        const inputEl = term ? getIframeInput(term) || term.textarea : undefined;
        if (inputEl) {
          focusoutHandler = () => {
            if (isVirtualKeyboardOpen()) forceResetKeyboardState();
          };
          inputEl.addEventListener('focusout', focusoutHandler);
        }
      }

      onCleanup(() => {
        if (focusoutHandler) {
          const inputEl = term ? getIframeInput(term) || term.textarea : undefined;
          inputEl?.removeEventListener('focusout', focusoutHandler);
        }
        const iframeInput = term ? getIframeInput(term) : undefined;
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
        if (!fitAddon || !term || !containerEl) return;
        if (containerEl.clientHeight === 0) return;
        const wasBottom = isAtBottom(term);
        fitAddon.fit();
        // First activation: always scroll to bottom so user sees the prompt.
        // Subsequent activations: only if user was already following output,
        // or if the mobile keyboard is open (user expects to see the prompt).
        if (!hasInitialScrolled || wasBottom || (isTouchDevice() && isVirtualKeyboardOpen())) {
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
          if (!fitAddon || !term || !containerEl) return;
          if (containerEl.clientHeight === 0) return;
          const wasBottom = isAtBottom(term);
          fitAddon.fit();
          if (wasBottom) term.scrollToBottom();
          term.refresh(0, term.rows - 1);
          terminalStore.resize(props.sessionId, props.terminalId, term.cols, term.rows);
        });
      });
    }
  });

  onCleanup(() => {
    cleanup?.();
    cleanupGestures?.();
    scrollIntentCleanup?.();
    scrollDropDisposable?.dispose();
    clearScrollIntent(props.sessionId, props.terminalId);
    bufferChangeDisposable?.dispose();
    cursorHideDisposable?.dispose();
    cursorShowDisposable?.dispose();
    resizeObserver?.disconnect();
    terminalStore.stopUrlDetection();
    terminalStore.unregisterFitAddon(props.sessionId, props.terminalId);
    if (handleContextMenu) containerEl?.removeEventListener('contextmenu', handleContextMenu);
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
