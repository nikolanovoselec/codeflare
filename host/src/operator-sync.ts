/**
 * Restricted explicit-output upload orchestration for one operator session.
 * Parent configuration fixes owner/activity/session/policy/root/remote prefix;
 * requests can only declare bounded canonical files and stable operation IDs.
 * This service never bisyncs, deletes, chooses a bucket or proves durability.
 */
export interface OperatorSyncFile { path: string; size: number; sha256: string }
export interface OperatorSyncReceipt {
  schemaVersion: 1;
  operationId: string;
  requestDigest: string;
  status: 'accepted' | 'uploading' | 'uploaded' | 'failed' | 'unknown';
  manifestDigest: string | null;
  files: OperatorSyncFile[];
}
export interface OperatorSyncStore {
  load(operationId: string): Promise<OperatorSyncReceipt | null>;
  save(receipt: OperatorSyncReceipt): Promise<void>;
}
export interface OperatorSyncFiles {
  read(relativePath: string, expectedSize: number): Promise<Uint8Array>;
}
export interface OperatorSyncUploader {
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export class OperatorSyncService {
  constructor(_options: { activityId: string; sessionId: string; policyDigest: string; root: string;
    remotePrefix: string; deadline: number; store: OperatorSyncStore; files: OperatorSyncFiles; uploader: OperatorSyncUploader }) {}
  async upload(_request: { operationId: string; requestDigest: string; files: OperatorSyncFile[] }): Promise<OperatorSyncReceipt> {
    throw new Error('Not implemented');
  }
}
