/**
 * Restricted explicit-output upload orchestration for one operator session.
 * Parent configuration fixes owner/activity/session/policy/root/remote prefix;
 * requests can only declare bounded canonical files and stable operation IDs.
 * This service never bisyncs, deletes, chooses a bucket or proves durability.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

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
  /** Implementation must reject symlinks and paths outside its configured root. */
  read(relativePath: string, expectedSize: number): Promise<Uint8Array>;
}
export interface OperatorSyncUploader {
  /** Exact object put only; implementations must not expose sync/delete/copy. */
  put(key: string, bytes: Uint8Array): Promise<void>;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_FILES = 128;
const MAX_BYTES = 8 * 1024 * 1024;

function canonicalPath(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && value !== 'manifest.json'
    && !/[\\%\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function validateFiles(files: OperatorSyncFile[]): OperatorSyncFile[] {
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error('Invalid operator sync request');
  let total = 0;
  const paths = new Set<string>();
  const validated = files.map(file => {
    if (!file || !canonicalPath(file.path) || paths.has(file.path)
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES
      || !DIGEST.test(file.sha256)) throw new Error('Invalid operator sync request');
    paths.add(file.path);
    total += file.size;
    return { path: file.path, size: file.size, sha256: file.sha256 };
  });
  if (total > MAX_BYTES) throw new Error('Invalid operator sync request');
  return validated;
}

export class OperatorSyncService {
  private readonly activityId: string;
  private readonly sessionId: string;
  private readonly policyDigest: string;
  private readonly filePrefix: string;
  private readonly manifestPrefix: string;
  private readonly deadline: number;
  private readonly store: OperatorSyncStore;
  private readonly files: OperatorSyncFiles;
  private readonly uploader: OperatorSyncUploader;

  constructor(options: { activityId: string; sessionId: string; policyDigest: string; root: string;
    filePrefix: string; manifestPrefix: string; deadline: number; store: OperatorSyncStore;
    files: OperatorSyncFiles; uploader: OperatorSyncUploader }) {
    if (!ID.test(options.activityId) || !ID.test(options.sessionId) || !DIGEST.test(options.policyDigest)
      || !path.isAbsolute(options.root) || !options.filePrefix.endsWith('/') || !options.manifestPrefix.endsWith('/')
      || !canonicalPath(options.filePrefix.slice(0, -1)) || !canonicalPath(options.manifestPrefix.slice(0, -1))
      || !Number.isFinite(options.deadline)) {
      throw new Error('Invalid operator sync configuration');
    }
    this.activityId = options.activityId;
    this.sessionId = options.sessionId;
    this.policyDigest = options.policyDigest;
    this.filePrefix = options.filePrefix;
    this.manifestPrefix = options.manifestPrefix;
    this.deadline = options.deadline;
    this.store = options.store;
    this.files = options.files;
    this.uploader = options.uploader;
  }

  async upload(request: { operationId: string; requestDigest: string; files: OperatorSyncFile[] }): Promise<OperatorSyncReceipt> {
    if (!ID.test(request.operationId) || !DIGEST.test(request.requestDigest)) throw new Error('Invalid operator sync request');
    const files = validateFiles(request.files);
    let existing: OperatorSyncReceipt | null;
    try { existing = await this.store.load(request.operationId); }
    catch { throw new Error('Operator sync state unavailable'); }
    if (existing) {
      if (existing.requestDigest !== request.requestDigest || JSON.stringify(existing.files) !== JSON.stringify(files)) {
        throw new Error('Operator sync operation conflict');
      }
      if (existing.status === 'uploaded' || existing.status === 'failed') return existing;
      if (existing.status !== 'unknown') {
        const unknown = { ...existing, status: 'unknown' as const };
        await this.persist(unknown);
      }
      throw new Error('Operator sync outcome is unknown');
    }
    this.checkAuthority();
    let receipt: OperatorSyncReceipt = { schemaVersion: 1, operationId: request.operationId,
      requestDigest: request.requestDigest, status: 'accepted', manifestDigest: null, files };
    await this.persist(receipt);

    const local = new Map<string, Uint8Array>();
    try {
      for (const file of files) {
        this.checkAuthority();
        const bytes = Uint8Array.from(await this.files.read(file.path, file.size));
        if (bytes.byteLength !== file.size || hash(bytes) !== file.sha256) throw new Error('Operator sync file mismatch');
        local.set(file.path, bytes);
      }
    } catch (error) {
      receipt = { ...receipt, status: 'failed' };
      await this.persist(receipt);
      throw error;
    }

    const manifest = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1,
      activityId: this.activityId, sessionId: this.sessionId, operationId: request.operationId,
      requestDigest: request.requestDigest, policyDigest: this.policyDigest, files }));
    if (manifest.byteLength > 64 * 1024) {
      receipt = { ...receipt, status: 'failed' };
      await this.persist(receipt);
      throw new Error('Operator sync manifest is too large');
    }
    receipt = { ...receipt, status: 'uploading' };
    await this.persist(receipt);
    try {
      for (const file of files) {
        this.checkAuthority();
        await this.uploader.put(`${this.filePrefix}${file.path}`, local.get(file.path)!);
      }
      this.checkAuthority();
      await this.uploader.put(`${this.manifestPrefix}${request.operationId}/manifest.json`, manifest);
    } catch {
      receipt = { ...receipt, status: 'unknown' };
      await this.persist(receipt);
      throw new Error('Operator sync outcome is unknown');
    }
    receipt = { ...receipt, status: 'uploaded', manifestDigest: hash(manifest) };
    await this.persist(receipt);
    return receipt;
  }

  private async persist(receipt: OperatorSyncReceipt): Promise<void> {
    try { await this.store.save(receipt); }
    catch { throw new Error('Operator sync state unavailable'); }
  }

  private checkAuthority(): void {
    if (Date.now() >= this.deadline) throw new Error('Operator sync authority expired');
  }
}
