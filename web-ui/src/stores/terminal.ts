import { createStore, produce } from 'solid-js/store';
import { createSignal } from 'solid-js';
import type { TerminalConnectionState } from '../types';
import { getTerminalWebSocketUrl } from '../api/client';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { logger } from '../lib/logger';
import {
  MAX_WS_RETRIES,
  WS_RETRY_DELAY_MS,
  CSS_TRANSITION_DELAY_MS,
  WS_CLOSE_ABNORMAL,
  URL_CHECK_INTERVAL_MS,
  ACTIONABLE_URL_PATTERNS,
} from '../lib/constants';

// Callback for process-name messages (avoids circular import with session store)
let onProcessName: ((sessionId: string, terminalId: string, processName: string) => void) | null = null;

/** Register callback for process-name control messages (called by session store) */
export function registerProcessNameCallback(
  cb: (sessionId: string, terminalId: string, processName: string) => void
): void {
  onProcessName = cb;
}

// Helper to create compound key from sessionId and terminalId
function makeKey(sessionId: string, terminalId: string): string {
  return `${sessionId}:${terminalId}`;
}

// Use plain objects to store references (Solid.js stores don't track Map mutations well)
const [state, setState] = createStore<{
  connectionStates: Record<string, TerminalConnectionState>;
  retryMessages: Record<string, string>;
}>({
  connectionStates: {},
  retryMessages: {},
});

// External storage for WebSocket and Terminal instances (keyed by sessionId:terminalId)
const connections = new Map<string, WebSocket>();
const terminals = new Map<string, Terminal>();
const retryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const abortControllers = new Map<string, AbortController>();

// Bug 1 fix: Store inputDisposable outside the connect function to properly clean up
const inputDisposables = new Map<string, { dispose: () => void }>();

// Store fitAddon references for triggering resize on layout change
const fitAddons = new Map<string, FitAddon>();

// Signal to trigger global terminal resize (incremented when tiling layout changes)
const [layoutChangeCounter, setLayoutChangeCounter] = createSignal(0);

// Refit all registered terminals (fit + send resize to PTY + refresh)
function refitAllTerminals(): void {
  for (const [key, fitAddon] of fitAddons) {
    try {
      fitAddon.fit();
      const terminal = terminals.get(key);
      if (terminal) {
        const cols = terminal.cols;
        const rows = terminal.rows;
        // Send resize to PTY
        const ws = connections.get(key);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
        // Force full terminal refresh to fix garbling/colors in apps like htop
        terminal.scrollToBottom();
        terminal.refresh(0, terminal.rows - 1);
      }
    } catch (err) {
      logger.warn(`[Terminal ${key}] Failed to refit on layout change:`, err);
    }
  }
}

// Trigger all terminals to refit (called when tiling layout changes)
function triggerLayoutResize(): void {
  setLayoutChangeCounter((c) => c + 1);

  // Primary refit: catches simple/fast layout changes (e.g., tabbed <-> 2-split)
  setTimeout(() => {
    requestAnimationFrame(() => refitAllTerminals());
  }, CSS_TRANSITION_DELAY_MS);

  // Secondary refit: catches complex grid restructuring (e.g., 4-grid <-> 3-split)
  // where the browser may not have completed CSS grid relayout by the primary pass
  setTimeout(() => {
    requestAnimationFrame(() => refitAllTerminals());
  }, CSS_TRANSITION_DELAY_MS * 4);
}

// Register a fitAddon for a terminal (for layout change handling)
function registerFitAddon(sessionId: string, terminalId: string, fitAddon: FitAddon): void {
  const key = makeKey(sessionId, terminalId);
  fitAddons.set(key, fitAddon);
}

// Unregister a fitAddon
function unregisterFitAddon(sessionId: string, terminalId: string): void {
  const key = makeKey(sessionId, terminalId);
  fitAddons.delete(key);
}

// Get connection state
function getConnectionState(sessionId: string, terminalId: string): TerminalConnectionState {
  const key = makeKey(sessionId, terminalId);
  return state.connectionStates[key] || 'disconnected';
}

// Get retry message (for UI display)
function getRetryMessage(sessionId: string, terminalId: string): string | null {
  const key = makeKey(sessionId, terminalId);
  return state.retryMessages[key] || null;
}

// Set connection state
function setConnectionState(
  sessionId: string,
  terminalId: string,
  connectionState: TerminalConnectionState
): void {
  const key = makeKey(sessionId, terminalId);
  setState(
    produce((s) => {
      s.connectionStates[key] = connectionState;
    })
  );
}

// Set retry message
function setRetryMessage(sessionId: string, terminalId: string, message: string | null): void {
  const key = makeKey(sessionId, terminalId);
  setState(
    produce((s) => {
      if (message === null) {
        delete s.retryMessages[key];
      } else {
        s.retryMessages[key] = message;
      }
    })
  );
}

// Store terminal instance
function setTerminal(sessionId: string, terminalId: string, terminal: Terminal): void {
  const key = makeKey(sessionId, terminalId);
  terminals.set(key, terminal);
}

// Get terminal instance
function getTerminal(sessionId: string, terminalId: string): Terminal | undefined {
  const key = makeKey(sessionId, terminalId);
  return terminals.get(key);
}

/**
 * Connect to terminal WebSocket with retry logic.
 *
 * Uses an AbortController (stored in module-level map) to cancel stale retry loops.
 * When a new connect() or disconnect() is called for the same key, the previous
 * controller is aborted, ensuring only one retry loop exists per terminal at a time.
 *
 * @param sessionId - The session ID to connect to
 * @param terminalId - The terminal tab ID within the session
 * @param terminal - The xterm.js Terminal instance
 * @param onError - Optional callback for error reporting
 * @returns Cleanup function to cancel connection and dispose resources
 */
function connect(
  sessionId: string,
  terminalId: string,
  terminal: Terminal,
  onError?: (error: string) => void,
  manual?: boolean
): () => void {
  const key = makeKey(sessionId, terminalId);

  // Close existing connection if any
  disconnect(sessionId, terminalId);

  terminals.set(key, terminal);

  // Bug 1 fix: Dispose any existing input handler before creating a new one
  const existingDisposable = inputDisposables.get(key);
  if (existingDisposable) {
    logger.debug(`[Terminal ${key}] Disposing existing input handler`);
    existingDisposable.dispose();
    inputDisposables.delete(key);
  }

  // Abort any previous retry loop for this key and create a new controller
  const previousController = abortControllers.get(key);
  if (previousController) {
    previousController.abort();
  }
  const controller = new AbortController();
  const signal = controller.signal;
  abortControllers.set(key, controller);

  // Attempt connection with retries
  function attemptConnection(attemptNumber: number): void {
    if (signal.aborted) return;

    // Clear any existing retry timeout
    const existingTimeout = retryTimeouts.get(key);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      retryTimeouts.delete(key);
    }

    setConnectionState(sessionId, terminalId, 'connecting');

    if (attemptNumber > 1) {
      setRetryMessage(sessionId, terminalId, `Connecting... (attempt ${attemptNumber}/${MAX_WS_RETRIES})`);
    } else {
      setRetryMessage(sessionId, terminalId, 'Connecting...');
    }

    const url = getTerminalWebSocketUrl(sessionId, terminalId, manual);
    const ws = new WebSocket(url);

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      if (signal.aborted) {
        ws.close();
        return;
      }
      logger.debug(`[Terminal ${key}] WebSocket opened`);
      setConnectionState(sessionId, terminalId, 'connected');
      setRetryMessage(sessionId, terminalId, null);

      // Bug 1 fix: Dispose any existing input handler before creating a new one
      const existingDisposable = inputDisposables.get(key);
      if (existingDisposable) {
        logger.debug(`[Terminal ${key}] Disposing existing input handler in onopen`);
        existingDisposable.dispose();
        inputDisposables.delete(key);
      }

      // Set up terminal input handler on successful connection
      // Send RAW data directly to PTY (no JSON wrapping)
      const inputDisposable = terminal.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);  // Raw terminal input
        }
      });

      // Bug 1 fix: Store inputDisposable in the external Map for proper cleanup
      inputDisposables.set(key, inputDisposable);
      logger.debug(`[Terminal ${key}] Created new input handler`);

      // Bug 5 fix: Send initial resize to sync PTY dimensions with xterm.js
      // Without this, PTY starts with default 80x24 but xterm.js may have different dimensions
      // causing garbled/duplicated text until user manually resizes window
      const cols = terminal.cols;
      const rows = terminal.rows;
      if (cols > 0 && rows > 0) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        logger.debug(`[Terminal ${key}] Sent initial resize: ${cols}x${rows}`);
      }

    };

    function handleWebSocketMessage(event: MessageEvent): void {
      if (signal.aborted) return;

      // Server sends RAW terminal data - write directly to xterm
      let messageData: string;
      if (event.data instanceof ArrayBuffer) {
        messageData = new TextDecoder().decode(event.data);
      } else if (typeof event.data === 'string') {
        messageData = event.data;
      } else {
        logger.warn('Unknown message type:', typeof event.data);
        return;
      }

      // Check for JSON control messages from server (restore, process-name)
      // Server control messages always start with {"type": — raw PTY output never does
      if (messageData.startsWith('{"type":')) {
        try {
          const msg = JSON.parse(messageData);
          if (msg.type === 'restore') {
            if (msg.state) {
              terminal.reset();
              terminal.write(msg.state);
              terminal.scrollToBottom();
              terminal.refresh(0, terminal.rows - 1);
            }
            return;
          }
          if (msg.type === 'process-name' && msg.processName) {
            logger.debug(`[Terminal ${key}] Process name: ${msg.processName}`);
            onProcessName?.(sessionId, terminalId, msg.processName);
            return;
          }
        } catch {
          // Not JSON, write as raw data
        }
      }

      terminal.write(messageData);
    }

    function handleWebSocketClose(event: CloseEvent): void {
      if (signal.aborted) return;

      logger.warn(`[Terminal ${key}] WS CLOSED: code=${event.code}, reason="${event.reason}", state=${getConnectionState(sessionId, terminalId)}`);
      connections.delete(key);

      // Intentional disconnect from dashboard — do not reconnect
      if (event.reason === 'dashboard-disconnect') {
        setConnectionState(sessionId, terminalId, 'disconnected');
        return;
      }

      // Retry on abnormal closure if we haven't exhausted attempts
      if (event.code === WS_CLOSE_ABNORMAL && attemptNumber < MAX_WS_RETRIES && !signal.aborted) {
        logger.warn(`[Terminal ${key}] Retrying connection, attempt ${attemptNumber + 1}/${MAX_WS_RETRIES}, code=${event.code}`);
        const timeout = setTimeout(() => {
          attemptConnection(attemptNumber + 1);
        }, WS_RETRY_DELAY_MS);
        retryTimeouts.set(key, timeout);
        return;
      }

      // Max retries exhausted or non-abnormal close
      const wasNeverConnected = getConnectionState(sessionId, terminalId) === 'connecting';
      logger.warn(`[Terminal ${key}] Max retries reached or normal close, giving up`);
      setConnectionState(sessionId, terminalId, wasNeverConnected ? 'error' : 'disconnected');
      setRetryMessage(sessionId, terminalId, null);
      onError?.(wasNeverConnected
        ? 'Failed to connect to terminal after multiple attempts'
        : 'Connection lost. Click reconnect to try again.');
    }

    ws.onmessage = handleWebSocketMessage;

    ws.onerror = (event) => {
      logger.error(`[Terminal ${key}] WS ERROR`, event);
    };

    ws.onclose = handleWebSocketClose;

    connections.set(key, ws);
  }

  // Start first connection attempt
  attemptConnection(1);

  // Return cleanup function
  return () => {
    controller.abort();

    // Bug 1 fix: Dispose input handler from the external Map
    const disposable = inputDisposables.get(key);
    if (disposable) {
      disposable.dispose();
      inputDisposables.delete(key);
    }

    // Clear any pending retry
    const timeout = retryTimeouts.get(key);
    if (timeout) {
      clearTimeout(timeout);
      retryTimeouts.delete(key);
    }

    disconnect(sessionId, terminalId);
  };
}

// Disconnect from terminal
function disconnect(sessionId: string, terminalId: string): void {
  const key = makeKey(sessionId, terminalId);

  // Abort any in-flight retry loops for this key (THE BUG FIX)
  const controller = abortControllers.get(key);
  if (controller) {
    controller.abort();
    abortControllers.delete(key);
  }

  // Bug 1 fix: Dispose input handler before closing WebSocket
  const disposable = inputDisposables.get(key);
  if (disposable) {
    logger.debug(`[Terminal ${key}] Disposing input handler in disconnect`);
    disposable.dispose();
    inputDisposables.delete(key);
  }

  const ws = connections.get(key);
  if (ws) {
    ws.close();
    connections.delete(key);
  }
  setConnectionState(sessionId, terminalId, 'disconnected');
}

// Send resize event to terminal
function resize(sessionId: string, terminalId: string, cols: number, rows: number): void {
  const key = makeKey(sessionId, terminalId);
  const ws = connections.get(key);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
}

// Check if connected
function isConnected(sessionId: string, terminalId: string): boolean {
  return getConnectionState(sessionId, terminalId) === 'connected';
}

// Dispose terminal and connection
function dispose(sessionId: string, terminalId: string): void {
  const key = makeKey(sessionId, terminalId);
  disconnect(sessionId, terminalId);
  const terminal = terminals.get(key);
  if (terminal) {
    terminal.dispose();
    terminals.delete(key);
  }
}

// Dispose ALL terminals for a session (called when session stops/deletes)
function disposeSession(sessionId: string): void {
  const prefix = `${sessionId}:`;

  // Find and dispose all terminals for this session
  for (const key of [...connections.keys()]) {
    if (key.startsWith(prefix)) {
      const terminalId = key.slice(prefix.length);
      disconnect(sessionId, terminalId);
    }
  }

  for (const key of [...terminals.keys()]) {
    if (key.startsWith(prefix)) {
      const terminal = terminals.get(key);
      if (terminal) {
        terminal.dispose();
      }
      terminals.delete(key);
    }
  }

  // Clean up auxiliary Maps (mirrors disposeAll pattern)
  for (const key of [...fitAddons.keys()]) {
    if (key.startsWith(prefix)) {
      fitAddons.delete(key);
    }
  }

  for (const key of [...abortControllers.keys()]) {
    if (key.startsWith(prefix)) {
      const controller = abortControllers.get(key);
      if (controller) {
        controller.abort();
      }
      abortControllers.delete(key);
    }
  }

  for (const key of [...inputDisposables.keys()]) {
    if (key.startsWith(prefix)) {
      const disposable = inputDisposables.get(key);
      if (disposable) {
        disposable.dispose();
      }
      inputDisposables.delete(key);
    }
  }

  // Clean up state
  setState(produce((s) => {
    for (const key of Object.keys(s.connectionStates)) {
      if (key.startsWith(prefix)) {
        delete s.connectionStates[key];
      }
    }
    for (const key of Object.keys(s.retryMessages)) {
      if (key.startsWith(prefix)) {
        delete s.retryMessages[key];
      }
    }
  }));
}

// Dispose all terminals and connections
function disposeAll(): void {
  for (const key of connections.keys()) {
    const [sessionId, terminalId] = key.split(':');
    disconnect(sessionId, terminalId);
  }
  for (const [, terminal] of terminals) {
    terminal.dispose();
  }
  terminals.clear();

  // Clear auxiliary Maps that live outside the reactive store
  for (const disposable of inputDisposables.values()) {
    disposable.dispose();
  }
  inputDisposables.clear();

  for (const timeout of retryTimeouts.values()) {
    clearTimeout(timeout);
  }
  retryTimeouts.clear();

  // Abort all retry loops
  for (const controller of abortControllers.values()) {
    controller.abort();
  }
  abortControllers.clear();

  fitAddons.clear();
}

// Reconnect to terminal WebSocket
function reconnect(sessionId: string, terminalId: string, onError?: (error: string) => void): (() => void) | null {
  const key = makeKey(sessionId, terminalId);
  const terminal = terminals.get(key);
  if (!terminal) {
    logger.error(`Cannot reconnect: no terminal for ${key}`);
    return null;
  }

  // Clear any existing retry timeout
  const existingTimeout = retryTimeouts.get(key);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
    retryTimeouts.delete(key);
  }

  // Close existing connection and reconnect
  disconnect(sessionId, terminalId);
  return connect(sessionId, terminalId, terminal, onError);
}

// Send input text to a terminal's WebSocket connection
export function sendInputToTerminal(sessionId: string, terminalId: string, text: string): boolean {
  const key = makeKey(sessionId, terminalId);
  const ws = connections.get(key);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(text);
    return true;
  }
  return false;
}

// ─── URL Detection ───────────────────────────────────────────────────────────

/** Strips trailing non-URL characters (TUI border decoration like │, padding) */
const TRAILING_NON_URL = /[^a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
/** Strips leading non-URL characters (TUI border decoration like │, padding) */
const LEADING_NON_URL = /^[^a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/;

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
  const urlChars = /[a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/;
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

function getLastUrlFromBuffer(term: Terminal): string | null {
  const buffer = (term as any).buffer?.active;
  if (!buffer) return null;

  const cols: number = term.cols || 80;
  const rows: number = term.rows || 24;
  const urlRegex = /https?:\/\/[^\s"'<>]+/g;
  let lastUrl: string | null = null;
  // Only scan visible viewport ±3 lines
  const viewportY: number = buffer.viewportY ?? Math.max(0, buffer.length - rows);
  const startLine = Math.max(0, viewportY - 3);
  const endLine = Math.min(buffer.length, viewportY + rows + 3);

  let i = startLine;
  while (i < endLine) {
    const line = buffer.getLine(i);
    if (!line) { i++; continue; }
    if (line.isWrapped) { i++; continue; }

    let fullText = line.translateToString(true);
    let j = i + 1;
    while (j < endLine) {
      const nextLine = buffer.getLine(j);
      if (!nextLine?.isWrapped) break;
      fullText += nextLine.translateToString(true);
      j++;
    }

    let heuristicCount = 0;
    while (j < endLine && heuristicCount < 10) {
      const nextLine = buffer.getLine(j);
      if (!nextLine) break;
      const nextText = nextLine.translateToString(true);
      const lastPhysicalLine = buffer.getLine(j - 1)!.translateToString(true);
      // Strip trailing TUI decoration (│, padding) before checking if we're mid-URL
      const cleanedForCheck = fullText.replace(TRAILING_NON_URL, '');
      const midUrl = /https?:\/\/[^\s]*$/.test(cleanedForCheck);
      if (!isLikelyUrlContinuation(lastPhysicalLine, nextText, cols, midUrl)) break;
      if (midUrl) {
        // Strip TUI border decoration from join points
        fullText = cleanedForCheck;
        fullText += nextText.replace(LEADING_NON_URL, '').replace(TRAILING_NON_URL, '');
      } else {
        fullText += nextText;
      }
      j++;
      heuristicCount++;
      while (j < endLine) {
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

/** Returns true if the URL matches any pattern in ACTIONABLE_URL_PATTERNS */
function isActionableUrl(url: string): boolean {
  return ACTIONABLE_URL_PATTERNS.some((pattern) => pattern.test(url));
}

// Reactive signals for detected URLs
const [authUrl, setAuthUrl] = createSignal<string | null>(null);
const [normalUrl, setNormalUrl] = createSignal<string | null>(null);

/** Classify a detected URL into auth vs normal and update signals */
function setDetectedUrl(url: string | null): void {
  if (url && isActionableUrl(url)) {
    setAuthUrl(url);
    setNormalUrl(null);
  } else if (url) {
    setAuthUrl(null);
    setNormalUrl(url);
  } else {
    setAuthUrl(null);
    setNormalUrl(null);
  }
}

let urlDetectionInterval: ReturnType<typeof setInterval> | null = null;

function startUrlDetection(sessionId: string, terminalId: string): void {
  stopUrlDetection();
  urlDetectionInterval = setInterval(() => {
    const term = getTerminal(sessionId, terminalId);
    const url = term ? getLastUrlFromBuffer(term) : null;
    setDetectedUrl(url);
  }, URL_CHECK_INTERVAL_MS);
}

function stopUrlDetection(): void {
  if (urlDetectionInterval) {
    clearInterval(urlDetectionInterval);
    urlDetectionInterval = null;
  }
  setDetectedUrl(null);
}

// ─── Scheduled Disconnect & Reconnection (Dashboard Sleep Support) ───────────
//
// When the user navigates to the dashboard we schedule a full WebSocket
// disconnect after a grace period.  If the user returns to the terminal view
// before the timer fires, the disconnect is cancelled.  If the timer fires,
// all WS connections are closed so the Container DO can go fully idle.
// The existing reconnect logic (SerializeAddon state restore) handles
// reconnection when the user eventually returns.
//
// Cloudflare's runtime handles protocol-level WebSocket keepalive automatically
// for Durable Object/Container connections, so no application-level ping/pong
// is needed.

// Module-scope timer ID for the scheduled disconnect
let disconnectTimerId: ReturnType<typeof setTimeout> | null = null;

/**
 * Reconnect any terminals that are in 'disconnected' state (e.g. after the
 * dashboard scheduled disconnect fired).  Connected terminals are left as-is.
 */
export function reconnectDisconnectedTerminals(): void {
  for (const [key] of terminals) {
    const [sessionId, terminalId] = key.split(':');
    if (getConnectionState(sessionId, terminalId) === 'disconnected') {
      logger.info(`[Terminal ${key}] Disconnected, triggering reconnect`);
      reconnect(sessionId, terminalId);
    }
  }
}

/**
 * Close all WebSocket connections with a normal close code (1000).
 * Clears connection entries, input disposables, and retry state for every
 * connection — but leaves Terminal instances intact so the UI can trigger
 * reconnect later.
 */
function disconnectAll(): void {
  for (const [key, ws] of connections) {
    // Dispose input handler before closing
    const disposable = inputDisposables.get(key);
    if (disposable) {
      disposable.dispose();
      inputDisposables.delete(key);
    }

    logger.debug(`[Terminal ${key}] Disconnecting (dashboard scheduled disconnect)`);
    ws.close(1000, 'dashboard-disconnect');
  }
  connections.clear();

  // Clear pending retries — we intentionally disconnected
  for (const timeout of retryTimeouts.values()) {
    clearTimeout(timeout);
  }
  retryTimeouts.clear();

  // Abort all retry loops
  for (const controller of abortControllers.values()) {
    controller.abort();
  }
  abortControllers.clear();

  // Mark all connections as disconnected in the reactive store
  setState(produce((s) => {
    for (const key of Object.keys(s.connectionStates)) {
      s.connectionStates[key] = 'disconnected';
    }
    // Clear retry messages
    for (const key of Object.keys(s.retryMessages)) {
      delete s.retryMessages[key];
    }
  }));
}

/**
 * Schedule a full WebSocket disconnect after `delayMs` milliseconds.
 * Calling this again before the timer fires replaces the previous timer.
 */
export function scheduleDisconnect(delayMs: number): void {
  cancelScheduledDisconnect();
  disconnectTimerId = setTimeout(() => {
    disconnectTimerId = null;
    logger.info('[Terminal] Scheduled disconnect firing — closing all WebSocket connections');
    disconnectAll();
  }, delayMs);
  logger.debug(`[Terminal] Scheduled disconnect in ${delayMs}ms`);
}

/**
 * Cancel a previously scheduled disconnect (e.g. user returned to terminal view).
 */
export function cancelScheduledDisconnect(): void {
  if (disconnectTimerId !== null) {
    clearTimeout(disconnectTimerId);
    disconnectTimerId = null;
    logger.debug('[Terminal] Scheduled disconnect cancelled');
  }
}

// Export store and actions
export const terminalStore = {
  // State accessors
  getConnectionState,
  getRetryMessage,
  getTerminal,
  isConnected,

  // URL detection signals
  get authUrl() {
    return authUrl();
  },
  get normalUrl() {
    return normalUrl();
  },

  // Layout change signal (for reactive resize in tiled mode)
  get layoutChangeCounter() {
    return layoutChangeCounter();
  },

  // Actions
  setTerminal,
  connect,
  disconnect,
  reconnect,
  resize,
  dispose,
  disposeSession,
  disposeAll,

  // FitAddon management for layout changes
  registerFitAddon,
  unregisterFitAddon,
  triggerLayoutResize,

  // URL detection
  setDetectedUrl,
  startUrlDetection,
  stopUrlDetection,
  getLastUrlFromBuffer,
  isActionableUrl,
};
