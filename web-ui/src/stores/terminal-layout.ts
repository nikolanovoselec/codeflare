import { createSignal } from 'solid-js';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { CSS_TRANSITION_DELAY_MS } from '../lib/constants';
import { logger } from '../lib/logger';

/**
 * Terminal Layout module — extracted from terminal.ts (L26).
 *
 * Manages FitAddon registration and layout-change-triggered refits.
 * Uses dependency injection (registerLayoutDeps) to receive references
 * to the terminals and connections Maps from the terminal store.
 */

// ─── Dependency Injection ────────────────────────────────────────────────────

type TerminalsGetter = () => Map<string, Terminal>;
type ConnectionsGetter = () => Map<string, WebSocket>;

let getTerminals: TerminalsGetter = () => new Map();
let getConnections: ConnectionsGetter = () => new Map();

export function registerLayoutDeps(
  terminals: TerminalsGetter,
  connections: ConnectionsGetter,
): void {
  getTerminals = terminals;
  getConnections = connections;
}

// ─── FitAddon Management ─────────────────────────────────────────────────────

const fitAddons = new Map<string, FitAddon>();

function makeKey(sessionId: string, terminalId: string): string {
  return `${sessionId}:${terminalId}`;
}

export function registerFitAddon(sessionId: string, terminalId: string, fitAddon: FitAddon): void {
  fitAddons.set(makeKey(sessionId, terminalId), fitAddon);
}

export function unregisterFitAddon(sessionId: string, terminalId: string): void {
  fitAddons.delete(makeKey(sessionId, terminalId));
}

export function clearFitAddons(): void {
  fitAddons.clear();
}

export function cleanupFitAddonsByPrefix(prefix: string): void {
  for (const key of [...fitAddons.keys()]) {
    if (key.startsWith(prefix)) {
      fitAddons.delete(key);
    }
  }
}

// ─── Layout Resize ───────────────────────────────────────────────────────────

const [layoutChangeCounter, setLayoutChangeCounter] = createSignal(0);

export function getLayoutChangeCounter(): number {
  return layoutChangeCounter();
}

/** Refit all registered terminals (fit + send resize to PTY if changed).
 *  Preserves scroll position: only follows output if user was already at bottom. */
function refitAllTerminals(): void {
  const terminals = getTerminals();
  const connections = getConnections();

  for (const [key, fitAddon] of fitAddons) {
    try {
      const terminal = terminals.get(key);
      if (!terminal) {
        fitAddon.fit();
        continue;
      }

      const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      const prevCols = terminal.cols;
      const prevRows = terminal.rows;

      fitAddon.fit();

      const cols = terminal.cols;
      const rows = terminal.rows;

      // Only send resize if dimensions actually changed
      if (cols !== prevCols || rows !== prevRows) {
        const ws = connections.get(key);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      }

      // Preserve user scroll position — only follow output if already at bottom
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
    } catch (err) {
      logger.warn(`[Terminal ${key}] Failed to refit on layout change:`, err);
    }
  }
}

export function triggerLayoutResize(): void {
  setLayoutChangeCounter((c) => c + 1);

  setTimeout(() => {
    requestAnimationFrame(() => refitAllTerminals());
  }, CSS_TRANSITION_DELAY_MS);

  setTimeout(() => {
    requestAnimationFrame(() => refitAllTerminals());
  }, CSS_TRANSITION_DELAY_MS * 4);
}

export function refitAllTerminalsExported(): void {
  refitAllTerminals();
}
