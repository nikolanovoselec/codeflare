import { onMount, onCleanup, createEffect, createSignal, createMemo } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminalStore } from '../stores/terminal';
import { sessionStore } from '../stores/session';
import { logger } from '../lib/logger';
import { isTouchDevice, isVirtualKeyboardOpen, getKeyboardHeight, enableVirtualKeyboardOverlay, disableVirtualKeyboardOverlay, resetKeyboardStateIfStale, forceResetKeyboardState, isFocusOnTerminalInput, isSamsungBrowser } from '../lib/mobile';
import { attachSwipeGestures, sendTerminalKey } from '../lib/touch-gestures';
import { attachHerdrMouseInput, sendHerdrTap, terminalCell } from '../lib/herdr-mouse';
import { registerMultiLineLinkProvider, type TerminalLinkController } from '../lib/terminal-link-provider';
import { isSpeechSupported, isListening, startListening, stopListening } from '../lib/speech-input';
import { focusMobileTerminal, FUNCTIONAL_KEY_MAP, setupMobileInput } from '../lib/terminal-mobile-input';
import { loadSettings } from '../lib/settings';
import { getIframeInput, scrollBufferToBottom, resyncViewportScrollState } from '../lib/xterm-internals';
import { attachWheelScrolling } from '../lib/terminal-wheel';
import { useScrollCorrection } from './useScrollCorrection';
import { agentEventDisposition, showGrantedAgentEvent } from '../lib/agent-notifications';
import { beginClipboardWrite, completeClipboardWrite, parseOsc52ClipboardWrite, retainFailedClipboardWrite, takeFailedClipboardWrite } from '../lib/osc52';
import { resolveTerminalMode, type TerminalMode } from '../types';

/** DECTCEM (DEC Text Cursor Enable Mode) — the CSI parameter for cursor show/hide sequences */
export const DECTCEM_CURSOR_PARAM = 25;

/** Debounce delay before refitting terminal after virtual keyboard height changes on mobile */
export const KEYBOARD_REFIT_DEBOUNCE_MS = 150;

export interface UseTerminalOptions {
  sessionId: string;
  terminalId: string;
  sessionName?: string;
  terminalMode?: TerminalMode;
  active: boolean;
  visible?: boolean;
  focused?: boolean;
  connect?: boolean;
  alwaysObserveResize?: boolean;
  hideInitProgress?: boolean;
  onActivate?: () => void;
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
  let cleanupWheel: (() => void) | undefined;
  let cleanupHerdrMouse: (() => void) | undefined;
  let linkController: TerminalLinkController | undefined;
  let dataDisposable: { dispose: () => void } | undefined;
  let bufferChangeDisposable: { dispose: () => void } | undefined;
  let cursorHideDisposable: { dispose: () => void } | undefined;
  let cursorShowDisposable: { dispose: () => void } | undefined;
  let notificationDisposable: { dispose: () => void } | undefined;
  let clipboardDisposable: { dispose: () => void } | undefined;
  let handleContextMenu: ((event: MouseEvent) => void) | undefined;
  let sendHerdrTouchTap: ((clientX: number, clientY: number) => void) | undefined;
  let handleVisibilityChange: (() => void) | undefined;
  let agentEventDisposable: (() => void) | undefined;
  let hasInitialScrolled = false;
  let kbDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const cancelledAgentEventIds = new Set<string>();
  const MAX_CANCELLED_AGENT_EVENT_IDS = 16;

  const [dimensions, setDimensions] = createSignal({ cols: 80, rows: 24 });
  const [terminalInstance, setTerminalInstance] = createSignal<Terminal | undefined>(undefined);

  const retryMessage = createMemo(() => terminalStore.getRetryMessage(props.sessionId, props.terminalId));
  const connectionState = createMemo(() => terminalStore.getConnectionState(props.sessionId, props.terminalId));
  const isInitializing = createMemo(() => sessionStore.isSessionInitializing(props.sessionId));
  const initProgress = createMemo(() => sessionStore.getInitProgressForSession(props.sessionId));
  const isVisible = () => props.visible ?? props.active;
  const isFocused = () => props.focused ?? props.active;
  const canConnect = () => props.connect ?? isVisible();
  const isHerdr = () => resolveTerminalMode(props.terminalMode) === 'herdr';
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
      scrollback: 5000,
      // Keystroke re-anchoring is handled by the onData listener below via
      // the BufferService. xterm's built-in path routes through the viewport's
      // clamp-vulnerable scrollToLine and can yank a diverged DOM scroll state
      // to the top of scrollback on a single keypress.
      scrollOnUserInput: false,
      // xterm >=6.1 answers CSI ?996n and (after the app enables DECSET 2031)
      // pushes CSI ?997;1n color-scheme reports on every theme change.
      // applyCursorVisibility() below reassigns options.theme on each DECTCEM
      // toggle, so a 2031-enabled TUI (Claude Code) gets flooded with reports
      // it echoes at the prompt (anthropics/claude-code#41570). Disable the
      // extension to restore xterm 6.0.0 behavior (no ?997 bytes emitted).
      vtExtensions: { colorSchemeQuery: false },
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    linkController = registerMultiLineLinkProvider(term);

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

    // Custom key handler: Herdr prefix, Shift+Enter (CSI u for Claude Code), Ctrl+C (copy), Ctrl+V (paste)
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      // Browsers reserve Ctrl+B for bookmarks. Herdr uses its canonical control
      // byte as a prefix, then receives the following action key normally.
      if (isHerdr() && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        sendTerminalKey(term!, '\x02');
        return false;
      }
      // Shift+Enter → send CSI u encoded sequence so Claude Code can distinguish
      // it from plain Enter and insert a newline instead of submitting.
      // Without this, xterm.js sends \r for both Enter and Shift+Enter.
      if (event.shiftKey && event.key === 'Enter') {
        term!.input('\x1b[13;2u', false);
        return false;
      }
      const primaryModifier = event.ctrlKey || event.metaKey;
      if (primaryModifier && event.key.toLowerCase() === 'c') {
        const selection = term!.getSelection();
        if (selection) {
          event.preventDefault();
          void navigator.clipboard.writeText(selection).then(() => term?.clearSelection()).catch(() => {});
          return false;
        }
        return true;
      }
      if (primaryModifier && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        const retained = term ? takeFailedClipboardWrite(term) : undefined;
        if (retained && term) term.paste(retained);
        else void navigator.clipboard.readText().then((text) => {
          if (text && term) term.paste(text);
        }).catch(() => {});
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

    if (!isHerdr()) {
      handleContextMenu = (event: MouseEvent) => {
        event.preventDefault();
        if (!term || loadSettings().clipboardAccess !== true) return;
        term.focus();
        void navigator.clipboard.readText().then((text) => {
          if (text && term) term.paste(text);
        }).catch(() => {});
      };
      container.addEventListener('contextmenu', handleContextMenu);
    }

    return { termBg };
  }

  function setupMobileTerminal() {
    if (!term) return;

    // Touch scrolling when keyboard is closed is handled by touch-gestures.ts
    // via scrollBufferLines() (buffer-authoritative direct buffer scroll).

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

    if (isHerdr()) {
      const screen = t.element?.querySelector<HTMLElement>('.xterm-screen');
      if (screen) {
        const send = (sequence: string) => sendTerminalKey(t, sequence);
        cleanupHerdrMouse = attachHerdrMouseInput(screen, t, send, linkController);
        sendHerdrTouchTap = (clientX, clientY) => {
          const openingMobileInput = !isVirtualKeyboardOpen();
          props.onActivate?.();
          const cell = terminalCell(screen, t, clientX, clientY);
          if (cell && linkController?.activateLinkAt(cell.column, cell.row)) return;
          sendHerdrTap(screen, t, send, clientX, clientY);
          if (openingMobileInput) send(FUNCTIONAL_KEY_MAP.End);
          focusMobileTerminal(t);
        };
      }
    }

    if (isTouchDevice()) {
      setupMobileTerminal();
    }

    if (isHerdr()) {
      handleVisibilityChange = () => {
        if (document.visibilityState !== 'visible' || !isVisible()) return;
        requestAnimationFrame(() => {
          if (!isMounted()) return;
          const mountedContainer = containerEl!;
          const mountedFitAddon = fitAddon!;
          const mountedTerm = term!;
          if (mountedContainer.clientHeight === 0) return;
          mountedFitAddon.fit();
          mountedTerm.refresh(0, mountedTerm.rows - 1);
          if (!canConnect()) return;
          if (isFocused()) terminalStore.claimResizeAuthority(props.sessionId, props.terminalId);
          terminalStore.resize(
            props.sessionId,
            props.terminalId,
            mountedTerm.cols,
            mountedTerm.rows,
          );
        });
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    // Scroll correction: detects and reverses browser focus-validation bugs that
    // snap the viewport to position 0. Cleanup is handled inside the hook via onCleanup.
    useScrollCorrection(t, containerEl, {
      sessionId: props.sessionId,
      terminalId: props.terminalId,
    });

    // Wheel scrollback navigation goes through the BufferService, mirroring
    // the touch-gesture path — the viewport's DOM-relative wheel handling can
    // resolve a diverged scroll state into a jump to the top of scrollback.
    if (!isHerdr()) cleanupWheel = attachWheelScrolling(containerEl, t);

    // Replaces xterm's scrollOnUserInput (disabled in the options above):
    // any user input while reading scrollback re-anchors to the live bottom
    // through the BufferService. onData covers every input route — hardware
    // keys, the mobile compositor jail, swipe-generated arrows, voice input.
    dataDisposable = t.onData(() => {
      const active = t.buffer.active;
      if (active.type === 'normal' && active.viewportY < active.baseY) {
        scrollBufferToBottom(t);
      }
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
              scrollBufferToBottom(mountedTerm);
            } else {
              resyncViewportScrollState(mountedTerm);
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

    // OSC 777 is consumed as terminal control output only. Browser notification
    // delivery is driven exclusively by validated host agent-event controls.
    notificationDisposable = t.parser.registerOscHandler(777, () => true);
    if (isHerdr()) {
      clipboardDisposable = t.parser.registerOscHandler(52, (data) => {
        const text = parseOsc52ClipboardWrite(data);
        const terminal = term;
        if (text === null || !terminal) return true;
        const writeId = beginClipboardWrite(terminal);
        void navigator.clipboard.writeText(text).then(
          () => completeClipboardWrite(terminal, writeId),
          () => retainFailedClipboardWrite(terminal, writeId, text),
        );
        return true;
      });
    }

    const currentAgentEventDisposition = () => {
      const sessionExists = sessionStore.sessions?.some(
        (candidate) => candidate.id === props.sessionId,
      ) ?? false;
      return agentEventDisposition({
        documentVisible: document.visibilityState === 'visible',
        windowFocused: typeof document.hasFocus === 'function' && document.hasFocus(),
        terminalView: isVisible(),
        activeSessionMatches: props.active && sessionExists,
        terminalOnePaneFocused: props.terminalId === '1' && isFocused(),
      });
    };

    agentEventDisposable = terminalStore.registerAgentEventCallback(
      props.sessionId,
      props.terminalId,
      async (message) => {
        if (message.type === 'agent-event') {
          terminalStore.submitAgentEventDisposition(
            props.sessionId,
            props.terminalId,
            message.eventId,
            currentAgentEventDisposition(),
          );
          return;
        }

        if (message.type === 'agent-event-cancelled') {
          cancelledAgentEventIds.delete(message.eventId);
          cancelledAgentEventIds.add(message.eventId);
          if (cancelledAgentEventIds.size > MAX_CANCELLED_AGENT_EVENT_IDS) {
            const oldestEventId = cancelledAgentEventIds.values().next().value;
            if (oldestEventId !== undefined) cancelledAgentEventIds.delete(oldestEventId);
          }
          return;
        }

        if (
          message.type !== 'agent-event-display-granted'
          || cancelledAgentEventIds.has(message.eventId)
        ) return;
        const session = sessionStore.sessions?.find(
          (candidate) => candidate.id === props.sessionId,
        );
        const agent = session?.agentType === 'pi'
          ? 'Pi'
          : session?.agentType === 'claude-code'
            ? 'Claude Code'
            : undefined;
        if (!session || !agent) return;
        if (currentAgentEventDisposition() === 'suppress') {
          terminalStore.submitAgentEventDisposition(
            props.sessionId,
            props.terminalId,
            message.eventId,
            'suppress',
          );
          return;
        }

        const displayed = await showGrantedAgentEvent({
          eventId: message.eventId,
          kind: message.kind,
          agent,
          sessionName: session.name,
          sessionPath: `/app/session/${props.sessionId}`,
        });
        if (!displayed || cancelledAgentEventIds.has(message.eventId)) return;
        if (currentAgentEventDisposition() === 'suppress') {
          terminalStore.submitAgentEventDisposition(
            props.sessionId,
            props.terminalId,
            message.eventId,
            'suppress',
          );
          return;
        }
        terminalStore.confirmAgentEventDisplay(
          props.sessionId,
          props.terminalId,
          message.eventId,
        );
      },
    );

    cleanupGestures = attachSwipeGestures(
      containerEl,
      t,
      isVirtualKeyboardOpen,
      isHerdr(),
      sendHerdrTouchTap,
    );

    // Font loading fix
    if (document.fonts) {
      const currentFont = t.options.fontFamily;
      document.fonts.ready.then(() => {
        if (isMounted() && containerEl!.clientHeight > 0 && term?.element && currentFont) {
          const wasBottom = isAtBottom(term);
          term.options.fontFamily = currentFont;
          fitAddon?.fit();
          if (wasBottom) scrollBufferToBottom(term);
          else resyncViewportScrollState(term);
        }
      });
    }
  });

  // xterm 6.0.0 moved scrolling from .xterm-viewport (native overflow) to
  // SmoothScrollableElement (JS-based). Touch scrolling when keyboard is closed
  // is handled by touch-gestures.ts via scrollBufferLines() — no need for
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
          scrollBufferToBottom(mountedTerm);
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
        scrollBufferToBottom(mountedTerm);
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

  // Readiness remains UI-owned until the user opens the session. That state
  // transition creates the first attachment; no hidden socket competes with OPEN.
  createEffect(() => {
    const initializing = isInitializing();

    if ((!canConnect() || initializing) && cleanup) {
      cleanup();
      cleanup = undefined;
      terminalStore.stopUrlDetection(props.sessionId, props.terminalId);
      return;
    }

    if (canConnect() && !initializing && term && !cleanup) {
      logger.debug(`[Terminal ${props.sessionId}:${props.terminalId}] Connecting WebSocket`);
      const terminals = sessionStore.getTerminalsForSession(props.sessionId);
      const tab = terminals?.tabs.find((candidate) => candidate.id === props.terminalId);
      cleanup = terminalStore.connect(
        props.sessionId,
        props.terminalId,
        term,
        props.onError,
        !isHerdr() && tab?.manual === true,
        !isHerdr(),
        isHerdr(),
      );
    }
  });

  createEffect(() => {
    const focusedTerm = terminalInstance();
    const initializing = isInitializing();
    if (!isFocused() || !canConnect() || initializing || !focusedTerm) {
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
          if (wasBottom) scrollBufferToBottom(mountedTerm);
          else resyncViewportScrollState(mountedTerm);
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
          scrollBufferToBottom(mountedTerm);
          hasInitialScrolled = true;
        } else {
          resyncViewportScrollState(mountedTerm);
        }
        mountedTerm.refresh(0, mountedTerm.rows - 1);
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
          if (wasBottom) scrollBufferToBottom(mountedTerm);
          else resyncViewportScrollState(mountedTerm);
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
    cleanupWheel?.();
    cleanupHerdrMouse?.();
    linkController?.dispose();
    dataDisposable?.dispose();
    bufferChangeDisposable?.dispose();
    cursorHideDisposable?.dispose();
    cursorShowDisposable?.dispose();
    notificationDisposable?.dispose();
    clipboardDisposable?.dispose();
    agentEventDisposable?.();
    resizeObserver?.disconnect();
    if (handleContextMenu) mountedContainer?.removeEventListener('contextmenu', handleContextMenu);
    if (handleVisibilityChange) document.removeEventListener('visibilitychange', handleVisibilityChange);
    terminalStore.stopUrlDetection(props.sessionId, props.terminalId);
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
