/**
 * Activity state from the terminal server's /activity endpoint.
 *
 * The container DO polls this every 60s via collectMetrics(), which compares
 * lastInputAt against the configured idle timeout and stops the container when
 * it is exceeded (the SDK's own sleepAfter is pinned to 24h and is not the idle
 * mechanism; see container/index.ts).
 */
export interface ActivityState {
  readonly hasActiveConnections: boolean;
  readonly connectedClients: number;
  /**
   * Wall-clock (ms) of the last PTY KEYSTROKE - user input only. Does NOT
   * advance on terminal output, WebSocket traffic, vault/SilverBullet activity,
   * or an autonomously-working agent producing output. This is the idle
   * reference for collectMetrics; see its timestamp taxonomy. A long autonomous
   * agent run with no keystrokes therefore looks "idle" and will be stopped at
   * the configured timeout even though work is in progress.
   */
  readonly lastInputAt: number | null;
}
