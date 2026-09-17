/** Fixed authenticated host API for explicit restricted upload and receipt reads. */
import type { OperatorSyncFile, OperatorSyncReceipt } from './operator-sync.js';

export interface OperatorSyncCoordinator {
  upload(request: { operationId: string; requestDigest: string; files: OperatorSyncFile[] }): Promise<OperatorSyncReceipt>;
  status(operationId: string): Promise<OperatorSyncReceipt | null>;
}
export interface OperatorSyncHttpResult { status: number; headers: Record<string, string>; body: string }
export class OperatorSyncHttpController {
  constructor(_coordinator: OperatorSyncCoordinator) {}
  async handle(_input: { method: string; pathname: string; query?: URLSearchParams; body?: Uint8Array }): Promise<OperatorSyncHttpResult | null> {
    throw new Error('Not implemented');
  }
}
