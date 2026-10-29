/**
 * Bridge for sending plugin actions from the client to the server.
 *
 * The IntentRenderer renders intent trees with action descriptors. When
 * the user triggers an action (e.g. clicks a button), the renderer
 * needs to send a `plugin_action` message back to the server.
 *
 * This module exposes a `setSender(fn)` hook called by the dashboard's
 * useWebSocket hook once the WebSocket is open. Slot consumers route
 * their IntentRenderer's `send` callback through `sendPluginAction`,
 * which dispatches via the registered sender.
 *
 * Lives in dashboard-plugin-runtime to avoid a circular import with the
 * client package.
 *
 * See change: adopt-server-driven-intent-rendering.
 */

export interface PluginActionMessage {
  type: "plugin_action";
  pluginId: string;
  sessionId: string | null;
  action: string;
  payload?: Record<string, unknown>;
}

type Sender = (msg: PluginActionMessage) => void;

let currentSender: Sender | null = null;

/** Register the WebSocket sender. Called from useWebSocket on connect. */
export function setSender(sender: Sender | null): void {
  currentSender = sender;
}

/**
 * Send a `plugin_action` to the server. Called by slot consumers when an
 * action descriptor inside an intent is triggered. No-op if no sender is
 * registered (e.g. disconnected).
 */
export function sendPluginAction(
  pluginId: string,
  sessionId: string | null,
  action: string,
  payload: unknown,
): void {
  if (!currentSender) return;
  currentSender({
    type: "plugin_action",
    pluginId,
    sessionId,
    action,
    payload: payload as Record<string, unknown> | undefined,
  });
}
