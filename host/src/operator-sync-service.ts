/** Parent-only startup composition for the restricted explicit sync service. */
import type { OperatorSyncHttpController } from './operator-sync-http.js';

export function createOperatorSyncService(_options: {
  serializedConfig?: string;
  allowedRoot: string;
  bucket?: string;
  rcloneConfig: string;
  run?: (command: string, args: readonly string[], bytes: Uint8Array) => Promise<number>;
}): OperatorSyncHttpController | undefined {
  throw new Error('Not implemented');
}
