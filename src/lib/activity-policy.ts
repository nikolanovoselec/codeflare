/**
 * Activity state from the terminal server's /activity endpoint.
 *
 * The container DO polls this every 60s via collectMetrics() and renews
 * sleepAfter only when lastInputAt has changed (new user input detected).
 */
export interface ActivityState {
  readonly hasActiveConnections: boolean;
  readonly connectedClients: number;
  readonly lastInputAt: number | null;
}
