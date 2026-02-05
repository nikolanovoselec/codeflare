import { createStore, produce } from 'solid-js/store';
import { createSignal } from 'solid-js';
import type { TerminalConnectionState } from '../types';
import { getTerminalWebSocketUrl } from '../api/client';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { logger } from '../lib/logger';
import {
  MAX_CONNECTION_RETRIES,
  CONNECTION_RETRY_DELAY_MS,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAY_MS,
  CSS_TRANSITION_DELAY_MS,
  WS_CLOSE_ABNORMAL,
  WS_PING_INTERVAL_MS,
  WS_WATCHDOG_TIMEOUT_MS,
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

// Bug 1 fix: Store inputDisposable outside the connect function to properly clean up
const inputDisposables = new Map<string, { dispose: () => void }>();

// Bug 2 fix: Track reconnection attempts for dropped connections
const reconnectAttempts = new Map<string, number>();

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
 * Structure analysis (Phase 3 refactoring review):
 * - Uses nested `attemptConnection()` function for retry handling (appropriate since it
 *   needs closure over `cancelled` flag and `key` variable)
 * - WebSocket event handlers (onopen, onmessage, onerror, onclose) are self-contained
 * - Retry logic in onclose is well-commented and handles multiple scenarios:
 *   1. Initial connection retries (MAX_CONNECTION_RETRIES attempts)
 *   2. Reconnection for dropped connections (MAX_RECONNECT_ATTEMPTS)
 * - Returns cleanup function for proper resource disposal
 *
 * Further extraction not warranted because:
 * - Extracting `attemptConnection()` to module level would require passing many parameters
 * - WebSocket event handlers need closure over `ws`, `cancelled`, `terminal`, etc.
 * - Current structure is clear and well-documented
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
  onError?: (error: string) => void
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

  // Reset reconnection attempts on fresh connect
  reconnectAttempts.delete(key);

  let cancelled = false;
  let lastDataTime = Date.now();
  let watchdogInterval: ReturnType<typeof setInterval> | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  // Attempt connection with retries
  function attemptConnection(attemptNumber: number): void {
    if (cancelled) return;

    // Clear any existing retry timeout
    const existingTimeout = retryTimeouts.get(key);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      retryTimeouts.delete(key);
    }

    setConnectionState(sessionId, terminalId, 'connecting');

    if (attemptNumber > 1) {
      setRetryMessage(sessionId, terminalId, `Connecting... (attempt ${attemptNumber}/${MAX_CONNECTION_RETRIES})`);
    } else {
      setRetryMessage(sessionId, terminalId, 'Connecting...');
    }

    const url = getTerminalWebSocketUrl(sessionId, terminalId);
    const ws = new WebSocket(url);

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      if (cancelled) {
        ws.close();
        return;
      }
      logger.debug(`[Terminal ${key}] WebSocket opened`);
      setConnectionState(sessionId, terminalId, 'connected');
      setRetryMessage(sessionId, terminalId, null);

      // Bug 1 fix: Reset reconnection attempts on successful connection
      reconnectAttempts.delete(key);

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

      // Application-level ping: send {type:"ping"} every 25s.
      // Server responds with {type:"pong"} which arrives as onmessage, updating lastDataTime.
      // This keeps idle connections alive across the full pipeline:
      //   browser -> Cloudflare edge -> Worker -> Container -> server.js -> pong back
      // Without this, the 45s watchdog kills idle terminals because server-side
      // protocol pings (ws.ping()) are invisible to the browser WebSocket API.
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, WS_PING_INTERVAL_MS);

      // Watchdog: if no data received for 45s, assume connection is dead and reconnect.
      // Now works correctly because application-level pong responses update lastDataTime.
      if (watchdogInterval) clearInterval(watchdogInterval);
      watchdogInterval = setInterval(() => {
        const idleMs = Date.now() - lastDataTime;
        if (idleMs > WS_WATCHDOG_TIMEOUT_MS) {
          logger.warn(`[Terminal ${key}] Watchdog: no data for ${Math.floor(idleMs / 1000)}s, closing WS to trigger reconnect`);
          if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }
          ws.close();
        }
      }, WS_WATCHDOG_TIMEOUT_MS);
    };

    function handleWebSocketMessage(event: MessageEvent): void {
      if (cancelled) return;
      lastDataTime = Date.now();

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

      // Check for JSON control messages from server (pong, restore, process-name)
      // Server control messages always start with {"type": — raw PTY output never does
      if (messageData.startsWith('{"type":')) {
        try {
          const msg = JSON.parse(messageData);
          if (msg.type === 'pong') {
            return;
          }
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
      if (cancelled) return;

      // Clear intervals on close (will be re-created on reconnect)
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
      if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }

      const lastDataAge = Math.floor((Date.now() - lastDataTime) / 1000);
      logger.warn(`[Terminal ${key}] WS CLOSED: code=${event.code}, reason="${event.reason}", lastDataAge=${lastDataAge}s, state=${getConnectionState(sessionId, terminalId)}`);
      connections.delete(key);

      // WS_CLOSE_ABNORMAL (1006) = abnormal closure (connection failed)
      // Retry if we haven't exhausted attempts and connection was never successfully established
      const wasNeverConnected = getConnectionState(sessionId, terminalId) === 'connecting';
      const shouldRetry = wasNeverConnected && attemptNumber < MAX_CONNECTION_RETRIES && event.code === WS_CLOSE_ABNORMAL;

      if (shouldRetry) {
        logger.warn(`[Terminal ${key}] Retrying initial connection, attempt ${attemptNumber + 1}/${MAX_CONNECTION_RETRIES}, code=${event.code}`);
        const timeout = setTimeout(() => {
          attemptConnection(attemptNumber + 1);
        }, CONNECTION_RETRY_DELAY_MS);
        retryTimeouts.set(key, timeout);
        return;
      }

      // Reconnection logic - used for both:
      // 1. Dropped connections (was connected, now disconnected)
      // 2. Exhausted initial retries (gives extra attempts for slow container wake-up)
      const currentReconnectAttempts = reconnectAttempts.get(key) || 0;

      if (currentReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const nextAttempt = currentReconnectAttempts + 1;
        reconnectAttempts.set(key, nextAttempt);

        const reason = wasNeverConnected ? 'Initial retries exhausted' : 'Connection dropped';
        logger.warn(`[Terminal ${key}] ${reason}, reconnecting (attempt ${nextAttempt}/${MAX_RECONNECT_ATTEMPTS}), code=${event.code}`);
        setConnectionState(sessionId, terminalId, 'connecting');
        setRetryMessage(sessionId, terminalId, `Reconnecting... (attempt ${nextAttempt}/${MAX_RECONNECT_ATTEMPTS})`);

        const timeout = setTimeout(() => {
          if (!cancelled) {
            attemptConnection(1);
          }
        }, RECONNECT_DELAY_MS);
        retryTimeouts.set(key, timeout);
      } else {
        logger.warn(`[Terminal ${key}] Max reconnection attempts reached, giving up`);
        setConnectionState(sessionId, terminalId, wasNeverConnected ? 'error' : 'disconnected');
        setRetryMessage(sessionId, terminalId, null);
        reconnectAttempts.delete(key);
        onError?.(wasNeverConnected
          ? 'Failed to connect to terminal after multiple attempts'
          : 'Connection lost. Click reconnect to try again.');
      }
    }

    ws.onmessage = handleWebSocketMessage;

    ws.onerror = (event) => {
      const lastDataAge = Math.floor((Date.now() - lastDataTime) / 1000);
      logger.error(`[Terminal ${key}] WS ERROR: lastDataAge=${lastDataAge}s`, event);
    };

    ws.onclose = handleWebSocketClose;

    connections.set(key, ws);
  }

  // Start first connection attempt
  attemptConnection(1);

  // Return cleanup function
  return () => {
    cancelled = true;

    // Clear ping and watchdog intervals
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }

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

    // Clear reconnection attempts
    reconnectAttempts.delete(key);

    disconnect(sessionId, terminalId);
  };
}

// Disconnect from terminal
function disconnect(sessionId: string, terminalId: string): void {
  const key = makeKey(sessionId, terminalId);

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

  for (const key of [...reconnectAttempts.keys()]) {
    if (key.startsWith(prefix)) {
      reconnectAttempts.delete(key);
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

  reconnectAttempts.clear();
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

// Export store and actions
export const terminalStore = {
  // State accessors
  getConnectionState,
  getRetryMessage,
  getTerminal,
  isConnected,

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
};
