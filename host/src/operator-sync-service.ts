/** Parent-only startup composition for the restricted explicit sync service. */
import path from 'node:path';
import { OperatorSyncService, type OperatorSyncFile, type OperatorSyncReceipt } from './operator-sync.js';
import { OperatorSyncHttpController, type OperatorSyncCoordinator } from './operator-sync-http.js';
import { FileOperatorSyncStore, OwnedOperatorSyncFiles, RcloneOperatorSyncUploader } from './operator-sync-io.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
function canonicalPrefix(value: unknown): value is string {
  return typeof value === 'string' && value.length > 1 && value.length <= 2048 && value.endsWith('/')
    && !/[\\%\x00-\x1f\x7f]/.test(value)
    && value.slice(0, -1).split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
interface Config {
  schemaVersion: 1;
  activityId: string;
  sessionId: string;
  policyDigest: string;
  root: string;
  remotePrefix: string;
  deadline: number;
}
function parseConfig(serialized: string, allowedRoot: string): Config {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error('Invalid operator sync configuration'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operator sync configuration');
  const config = value as Record<string, unknown>;
  const boundary = path.resolve(allowedRoot);
  const activityId = typeof config.activityId === 'string' ? config.activityId : '';
  const expectedRoot = path.join(boundary, activityId, 'output');
  if (Object.keys(config).length !== 7 || config.schemaVersion !== 1 || !ID.test(activityId)
    || typeof config.sessionId !== 'string' || !ID.test(config.sessionId)
    || typeof config.policyDigest !== 'string' || !DIGEST.test(config.policyDigest)
    || typeof config.root !== 'string' || !path.isAbsolute(config.root) || path.resolve(config.root) !== expectedRoot
    || !canonicalPrefix(config.remotePrefix) || typeof config.deadline !== 'number'
    || !Number.isFinite(config.deadline) || config.deadline <= 0) throw new Error('Invalid operator sync configuration');
  return { schemaVersion: 1, activityId, sessionId: config.sessionId, policyDigest: config.policyDigest,
    root: expectedRoot, remotePrefix: config.remotePrefix, deadline: config.deadline };
}

class ConfiguredCoordinator implements OperatorSyncCoordinator {
  private readonly store: FileOperatorSyncStore;
  private readonly files: OwnedOperatorSyncFiles;
  private readonly uploader: RcloneOperatorSyncUploader;
  constructor(private readonly config: Config, options: { bucket: string; rcloneConfig: string;
    run?: (command: string, args: readonly string[], bytes: Uint8Array) => Promise<number> }) {
    this.store = new FileOperatorSyncStore(path.join(config.root, '..', '.codeflare/sync-receipts'));
    this.files = new OwnedOperatorSyncFiles(config.root);
    this.uploader = new RcloneOperatorSyncUploader({ bucket: options.bucket, prefix: config.remotePrefix,
      configFile: options.rcloneConfig, ...(options.run ? { run: options.run } : {}) });
  }
  upload(request: { operationId: string; requestDigest: string; files: OperatorSyncFile[] }): Promise<OperatorSyncReceipt> {
    return new OperatorSyncService({ activityId: this.config.activityId, sessionId: this.config.sessionId,
      policyDigest: this.config.policyDigest, root: this.config.root,
      remotePrefix: `${this.config.remotePrefix}${request.operationId}/`, deadline: this.config.deadline,
      store: this.store, files: this.files, uploader: this.uploader }).upload(request);
  }
  status(operationId: string): Promise<OperatorSyncReceipt | null> { return this.store.load(operationId); }
}

export function createOperatorSyncService(options: {
  serializedConfig?: string;
  allowedRoot: string;
  bucket?: string;
  rcloneConfig: string;
  run?: (command: string, args: readonly string[], bytes: Uint8Array) => Promise<number>;
}): OperatorSyncHttpController | undefined {
  if (!options.serializedConfig) return undefined;
  if (!options.bucket) throw new Error('Invalid operator sync configuration');
  const config = parseConfig(options.serializedConfig, options.allowedRoot);
  return new OperatorSyncHttpController(new ConfiguredCoordinator(config, {
    bucket: options.bucket, rcloneConfig: options.rcloneConfig, ...(options.run ? { run: options.run } : {}),
  }));
}
