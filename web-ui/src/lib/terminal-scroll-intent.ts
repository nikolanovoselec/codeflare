/**
 * Keyed scroll intent registry for signaling user-initiated scroll actions
 * from UI components outside the terminal container DOM tree (e.g. floating buttons).
 *
 * The scroll-drop detector in useTerminal.ts listens for wheel/pointerdown/keydown
 * on containerEl to suppress false corrections. But floating buttons live in a separate
 * DOM subtree, so their clicks never register as user intent on containerEl. This module
 * provides an explicit intent signal that the detector also checks.
 */

const intentByKey = new Map<string, number>();

function makeKey(sessionId: string, terminalId: string): string {
  return `${sessionId}:${terminalId}`;
}

/**
 * Mark that a user-initiated scroll action is about to happen for a specific terminal.
 * Call this BEFORE calling scrollPages(), scrollToBottom(), scrollLines(), etc.
 * from any UI component outside the terminal container.
 */
export function markScrollIntent(sessionId: string, terminalId: string): void {
  intentByKey.set(makeKey(sessionId, terminalId), Date.now());
}

/**
 * Check whether a recent scroll intent was registered for a terminal.
 */
export function hasRecentScrollIntent(
  sessionId: string,
  terminalId: string,
  windowMs: number
): boolean {
  const ts = intentByKey.get(makeKey(sessionId, terminalId)) ?? 0;
  return Date.now() - ts < windowMs;
}

/**
 * Clear scroll intent for a terminal (e.g. on dispose).
 */
export function clearScrollIntent(sessionId: string, terminalId: string): void {
  intentByKey.delete(makeKey(sessionId, terminalId));
}
