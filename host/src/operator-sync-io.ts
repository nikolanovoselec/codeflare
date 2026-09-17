/**
 * Concrete local-file, receipt and rclone adapters for restricted operator sync.
 * Paths and remote scope are constructor-bound; no shell, delete, sync, copy-source
 * or caller-selected bucket operation is exposed.
 */
import type { OperatorSyncFiles, OperatorSyncReceipt, OperatorSyncStore, OperatorSyncUploader } from './operator-sync.js';

export class OwnedOperatorSyncFiles implements OperatorSyncFiles {
  constructor(_root: string) {}
  async read(_relativePath: string, _expectedSize: number): Promise<Uint8Array> { throw new Error('Not implemented'); }
}
export class FileOperatorSyncStore implements OperatorSyncStore {
  constructor(_directory: string) {}
  async load(_operationId: string): Promise<OperatorSyncReceipt | null> { throw new Error('Not implemented'); }
  async save(_receipt: OperatorSyncReceipt): Promise<void> { throw new Error('Not implemented'); }
}
export class RcloneOperatorSyncUploader implements OperatorSyncUploader {
  constructor(_options: { bucket: string; prefix: string; configFile: string;
    run?: (command: string, args: readonly string[], bytes: Uint8Array) => Promise<number> }) {}
  async put(_key: string, _bytes: Uint8Array): Promise<void> { throw new Error('Not implemented'); }
}
