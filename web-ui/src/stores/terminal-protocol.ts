/**
 * Pure terminal wire-protocol helpers (REQ-TERM-019 / REQ-TERM-020), extracted
 * from the terminal store so frame classification and reconnect pacing are
 * unit-testable without a live WebSocket or the store's connection state.
 */
import { WS_RECONNECT_BASE_MS, WS_RECONNECT_MAX_MS } from '../lib/constants';

export type AgentEventKind = 'input-required' | 'task-completed' | 'task-failed';

export type AgentEventControlMessage =
  | { readonly type: 'agent-event'; readonly eventId: string; readonly kind: AgentEventKind }
  | { readonly type: 'agent-event-display-granted'; readonly eventId: string; readonly kind: AgentEventKind }
  | { readonly type: 'agent-event-cancelled'; readonly eventId: string };

// Discriminated result of inspecting a single WebSocket frame.
// Server control messages always start with {"type": — raw PTY output never does.
export type ControlMessage =
  | { kind: 'restore'; state: string | undefined }
  | { kind: 'process-name'; processName: string }
  | { kind: 'agent-event'; message: AgentEventControlMessage | undefined }
  | { kind: 'raw' };

const AGENT_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_EVENT_KINDS = new Set<AgentEventKind>([
  'input-required',
  'task-completed',
  'task-failed',
]);

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function parseAgentEventControl(value: Record<string, unknown>): AgentEventControlMessage | undefined {
  if (typeof value.eventId !== 'string' || !AGENT_EVENT_ID_PATTERN.test(value.eventId)) {
    return undefined;
  }
  if (value.type === 'agent-event-cancelled') {
    return hasOnlyKeys(value, ['type', 'eventId'])
      ? { type: value.type, eventId: value.eventId }
      : undefined;
  }
  if (
    (value.type === 'agent-event' || value.type === 'agent-event-display-granted')
    && hasOnlyKeys(value, ['type', 'eventId', 'kind'])
    && typeof value.kind === 'string'
    && AGENT_EVENT_KINDS.has(value.kind as AgentEventKind)
  ) {
    return { type: value.type, eventId: value.eventId, kind: value.kind as AgentEventKind };
  }
  return undefined;
}

/**
 * Classify a raw WebSocket frame as a server control message or raw terminal data.
 *
 * Pure (no side effects) so it can be unit-tested without a live WebSocket.
 * A frame is a control message only if it both starts with the `{"type":`
 * discriminator AND parses as JSON with a recognized `type`. A recognized
 * `restore` frame is always consumed (kind 'restore') even with no/empty
 * state — matching the original handler, which returned early on `type ===
 * 'restore'` and only conditionally rendered when `state` was present. A
 * `process-name` frame requires a non-empty `processName`. Recognized agent
 * event types are always consumed, but expose a message only after exact
 * field, event-ID, and kind validation. Everything else — raw PTY bytes,
 * malformed JSON, or unknown control types — is `raw`, which the caller
 * writes verbatim to the terminal.
 */
export function parseControlMessage(messageData: string): ControlMessage {
  if (!messageData.startsWith('{"type":')) {
    return { kind: 'raw' };
  }
  try {
    const msg = JSON.parse(messageData);
    if (msg.type === 'restore') {
      return { kind: 'restore', state: msg.state };
    }
    if (msg.type === 'process-name' && msg.processName) {
      return { kind: 'process-name', processName: msg.processName };
    }
    if (
      msg.type === 'agent-event'
      || msg.type === 'agent-event-display-granted'
      || msg.type === 'agent-event-cancelled'
    ) {
      return { kind: 'agent-event', message: parseAgentEventControl(msg) };
    }
  } catch {
    // Not JSON, fall through to raw
  }
  return { kind: 'raw' };
}

/**
 * Equal-jitter exponential backoff for WebSocket reconnect (REQ-TERM-020 AC3).
 * raw = min(MAX, BASE * 2^(attempt-1)); returns raw scaled to 50–100% (jitter)
 * so multiple panes de-correlate. `attempt` is 1-based; `rand` is injectable for
 * deterministic tests. Worst-case settles at the MAX cap (~4 attempts/min),
 * keeping a stuck pane well under the per-user WS connect budget.
 */
export function reconnectBackoffMs(attempt: number, rand: () => number = Math.random): number {
  const raw = Math.min(WS_RECONNECT_MAX_MS, WS_RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (0.5 + rand() * 0.5));
}
