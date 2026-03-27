import { createStore, produce } from 'solid-js/store';
import { createSignal } from 'solid-js';
import type { TerminalConnectionState } from '../types';
import { getTerminalWebSocketUrl } from '../api/client';
import type { Terminal } from '@xterm/xterm';
import { logger } from '../lib/logger';
import {
  WS_RETRY_DELAY_MS,
  WS_RETRYABLE_CLOSE_CODES,
  WS_CONTAINER_STOPPED_CODE,
} from '../lib/constants';
import {
  registerUrlDetectionDeps,
  startUrlDetection as _startUrlDetection,
  stopUrlDetection as _stopUrlDetection,
  getLastUrlFromBuffer as _getLastUrlFromBuffer,
  isActionableUrl as _isActionableUrl,
} from './terminal-url-detection';
import {
  registerLayoutDeps,
  registerFitAddon as _registerFitAddon,
  unregisterFitAddon as _unregisterFitAddon,
  triggerLayoutResize as _triggerLayoutResize,
  getLayoutChangeCounter,
  clearFitAddons,
  cleanupFitAddonsByPrefix,
  refitAllTerminalsExported as _refitAllTerminals,
} from './terminal-layout';

const textDecoder = new TextDecoder();

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

/**
 * Remove all entries from a Map whose keys start with `prefix`, optionally
 * calling `teardown` on each value before deletion (L14: extracted helper).
 */
export function cleanupMapByPrefix<T>(map: Map<string, T>, prefix: string, teardown?: (value: T) => void): void {
  for (const key of [...map.keys()]) {
    if (key.startsWith(prefix)) {
      if (teardown) {
        teardown(map.get(key)!);
      }
      map.delete(key);
    }
  }
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

// Write batching — coalesce rapid WebSocket messages into a single terminal.write()
// at 30fps (every ~33ms). At 60fps each frame triggers a render pass with layout
// invalidation; halving to 30fps cuts renderRows style recalcs roughly in half
// during burst output while keeping latency imperceptible (~33ms vs ~16ms).
const WRITE_FLUSH_INTERVAL_MS = 33;
const writeBuffers = new Map<string, string[]>();
const pendingFlushes = new Map<string, number>();

// Fix 18: Programmatic scroll suppression counter.
// Prevents post-write scroll corrections from triggering the onScroll reset
// detector, which caused a feedback loop during scrollback trimming.
//
// Root cause: xterm's Viewport._sync() calls setScrollDimensions() before
// setScrollPosition(). During dimension update, ScrollState clamps scrollTop
// to (scrollHeight - height), which can temporarily set it to 0. This clamped
// value leaks as an onScroll event that the detector misidentifies as a
// browser focus reset. The suppression counter tells the detector to ignore
// scroll events caused by our own corrections.
const scrollSuppressionCounts = new Map<string, number>();

function beginProgrammaticScroll(key: string): void {
  scrollSuppressionCounts.set(key, (scrollSuppressionCounts.get(key) || 0) + 1);
}

function endProgrammaticScroll(key: string): void {
  const count = scrollSuppressionCounts.get(key) || 0;
  if (count <= 1) scrollSuppressionCounts.delete(key);
  else scrollSuppressionCounts.set(key, count - 1);
}

function isProgrammaticScrollSuppressed(sessionId: string, terminalId: string): boolean {
  return (scrollSuppressionCounts.get(makeKey(sessionId, terminalId)) || 0) > 0;
}

function flushWriteBuffer(key: string, terminal: Terminal): void {
  pendingFlushes.delete(key);
  const buffer = writeBuffers.get(key);
  if (!buffer || buffer.length === 0) return;

  const beforeBaseY = terminal.buffer.active.baseY;
  const beforeY = terminal.buffer.active.viewportY;
  const wasAtBottom = beforeY >= beforeBaseY;
  const beforeDistFromBottom = beforeBaseY - beforeY;
  const data = buffer.join('');
  buffer.length = 0;

  // Fix 19: Bottom-following correction moved to onScroll handler (useTerminal.ts)
  // where it runs synchronously BEFORE render, eliminating one-frame jitter.
  // Write callback now only handles scrolled-up user distance correction.
  // Fix 18 suppression counter still active for scrolled-up corrections.
  terminal.write(data, () => {
    // Bottom-followers are handled by onScroll (Fix 19) — skip here
    if (wasAtBottom) return;

    // Scrolled-up user: check if trim shifted position
    const afterBaseY = terminal.buffer.active.baseY;
    const afterY = terminal.buffer.active.viewportY;
    const afterDistFromBottom = afterBaseY - afterY;
    const drift = Math.abs(afterDistFromBottom - beforeDistFromBottom);
    if (drift > 5) {
      const targetY = Math.max(0, afterBaseY - beforeDistFromBottom);
      const delta = targetY - afterY;
      if (delta !== 0) {
        beginProgrammaticScroll(key);
        terminal.scrollLines(delta);
        queueMicrotask(() => endProgrammaticScroll(key));
      }
    }
  });
}

function scheduleWrite(key: string, terminal: Terminal, data: string): void {
  let buffer = writeBuffers.get(key);
  if (!buffer) {
    buffer = [];
    writeBuffers.set(key, buffer);
  }
  buffer.push(data);

  if (!pendingFlushes.has(key)) {
    const timerId = window.setTimeout(() => flushWriteBuffer(key, terminal), WRITE_FLUSH_INTERVAL_MS);
    pendingFlushes.set(key, timerId);
  }
}

function cancelPendingFlush(key: string): void {
  const timerId = pendingFlushes.get(key);
  if (timerId !== undefined) {
    clearTimeout(timerId);
    pendingFlushes.delete(key);
  }
  writeBuffers.delete(key);
}

// L26: FitAddon management and layout resize delegated to terminal-layout.ts
// Register layout module dependencies at module init
registerLayoutDeps(
  () => terminals,
  () => connections,
);

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
 * @param manual - Optional flag indicating user-created terminal tab (appends ?manual=1 to WS URL)
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

  // Whether this terminal has ever successfully connected (for dead container detection).

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
      setRetryMessage(sessionId, terminalId, `Reconnecting... (attempt ${attemptNumber})`);
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
        messageData = textDecoder.decode(event.data);
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

      scheduleWrite(key, terminal, messageData);
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

      // Server-authoritative: container is definitively not running (4503 from DO).
      // Don't retry — session status will be updated by KV polling or is already stopped.
      if (event.code === WS_CONTAINER_STOPPED_CODE) {
        logger.info(`[Terminal ${key}] Container stopped (4503)`);
        setConnectionState(sessionId, terminalId, 'disconnected');
        setRetryMessage(sessionId, terminalId, 'Session stopped');
        return;
      }

      // Retry on retryable close codes (flat delay, no limit).
      // Network errors (1006) just retry — KV polling handles session status.
      if (WS_RETRYABLE_CLOSE_CODES.has(event.code) && !signal.aborted) {
        logger.warn(`[Terminal ${key}] Retrying connection, attempt ${attemptNumber + 1}, code=${event.code}`);
        const timeout = setTimeout(() => {
          attemptConnection(attemptNumber + 1);
        }, WS_RETRY_DELAY_MS);
        retryTimeouts.set(key, timeout);
        return;
      }

      // Non-retryable close (normal closure, etc.)
      setConnectionState(sessionId, terminalId, 'disconnected');
      setRetryMessage(sessionId, terminalId, null);
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
    cancelPendingFlush(key);

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

  // Cancel any buffered writes and clear scroll suppression
  cancelPendingFlush(key);
  scrollSuppressionCounts.delete(key);

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

  // Send kill message before disconnecting so the server kills the PTY immediately
  const ws = connections.get(key);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'kill' }));
  }

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

  // Disconnect all WebSocket connections for this session (handles abort + input disposable cleanup)
  for (const key of [...connections.keys()]) {
    if (key.startsWith(prefix)) {
      const terminalId = key.slice(prefix.length);
      disconnect(sessionId, terminalId);
    }
  }

  // L14: Use cleanupMapByPrefix for remaining auxiliary Maps
  cleanupMapByPrefix(terminals, prefix, (terminal) => terminal.dispose());
  cleanupFitAddonsByPrefix(prefix);
  cleanupMapByPrefix(abortControllers, prefix, (controller) => controller.abort());
  cleanupMapByPrefix(inputDisposables, prefix, (disposable) => disposable.dispose());
  cleanupMapByPrefix(pendingFlushes, prefix, (rafId) => clearTimeout(rafId));
  cleanupMapByPrefix(writeBuffers, prefix);

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

  // Cancel all pending write flushes
  for (const rafId of pendingFlushes.values()) {
    clearTimeout(rafId);
  }
  pendingFlushes.clear();
  writeBuffers.clear();

  // Abort all retry loops
  for (const controller of abortControllers.values()) {
    controller.abort();
  }
  abortControllers.clear();

  clearFitAddons();
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

// L26: URL detection delegated to terminal-url-detection.ts
// Reactive signals for detected URLs (kept here for terminalStore API compat)
const [authUrl, setAuthUrl] = createSignal<string | null>(null);
const [normalUrl, setNormalUrl] = createSignal<string | null>(null);

// Register URL detection module dependencies at module init
registerUrlDetectionDeps(
  (sessionId: string, terminalId: string) => getTerminal(sessionId, terminalId),
  setAuthUrl,
  setNormalUrl,
);

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
 * Reconnect terminals that are in 'disconnected' state (e.g. after the
 * dashboard scheduled disconnect fired).  Connected terminals are left as-is.
 *
 * @param activeSessionId - If provided, only reconnect terminals belonging to
 *   this session. This prevents auto-starting containers for OTHER sessions
 *   whose terminals are still in the map from a previous view. Without this
 *   filter, `container.fetch()` on a stopped DO auto-starts its container
 *   (SDK `containerFetch` line 525), causing phantom containers.
 */
export function reconnectDisconnectedTerminals(activeSessionId?: string): void {
  for (const [key] of terminals) {
    const [sessionId, terminalId] = key.split(':');
    if (activeSessionId && sessionId !== activeSessionId) continue;
    if (getConnectionState(sessionId, terminalId) === 'disconnected') {
      logger.info(`[Terminal ${key}] Disconnected, triggering reconnect`);
      reconnect(sessionId, terminalId);
    }
  }
}

/**
 * Reconnect terminals that are in 'disconnected' OR 'connecting' state.
 * More aggressive than reconnectDisconnectedTerminals — also rescues
 * terminals stuck in a retry loop (state === 'connecting') after the browser
 * tab was backgrounded long enough for the retry timers to stall.
 */
export function reconnectOnVisibilityReturn(activeSessionId?: string): void {
  for (const [key] of terminals) {
    const [sessionId, terminalId] = key.split(':');
    if (activeSessionId && sessionId !== activeSessionId) continue;
    const state = getConnectionState(sessionId, terminalId);
    if (state === 'disconnected' || state === 'connecting') {
      logger.info(`[Terminal ${key}] ${state}, triggering reconnect (visibility return)`);
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

  // Cancel all pending write flushes
  for (const rafId of pendingFlushes.values()) {
    clearTimeout(rafId);
  }
  pendingFlushes.clear();
  writeBuffers.clear();

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
    logger.warn('[Terminal] Scheduled disconnect firing — closing all WebSocket connections');
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
    return getLayoutChangeCounter();
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

  // FitAddon management for layout changes (L26: delegated to terminal-layout.ts)
  registerFitAddon: _registerFitAddon,
  unregisterFitAddon: _unregisterFitAddon,
  triggerLayoutResize: _triggerLayoutResize,

  // Fix 18: Scroll suppression query for onScroll detector
  isProgrammaticScrollSuppressed,

  // URL detection (L26: delegated to terminal-url-detection.ts)
  setDetectedUrl: (url: string | null) => {
    if (url && _isActionableUrl(url)) { setAuthUrl(url); setNormalUrl(null); }
    else if (url) { setAuthUrl(null); setNormalUrl(url); }
    else { setAuthUrl(null); setNormalUrl(null); }
  },
  startUrlDetection: _startUrlDetection,
  stopUrlDetection: _stopUrlDetection,
  getLastUrlFromBuffer: _getLastUrlFromBuffer,
  isActionableUrl: _isActionableUrl,
};
