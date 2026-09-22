/**
 * Concrete local-file, receipt and rclone adapters for restricted operator sync.
 * Paths and remote scope are constructor-bound; no shell, delete, sync, copy-source
 * or caller-selected bucket operation is exposed.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { OperatorSyncFile, OperatorSyncFiles, OperatorSyncReceipt, OperatorSyncStore, OperatorSyncUploader } from './operator-sync.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_STATE = 256 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const STATUS = new Set(['accepted', 'uploading', 'uploaded', 'failed', 'unknown']);

function canonicalPath(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !/[\\%\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function validateFiles(value: unknown): OperatorSyncFile[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error('Invalid operator sync receipt');
  let total = 0;
  const paths = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid operator sync receipt');
    const file = item as Record<string, unknown>;
    if (Object.keys(file).length !== 3 || typeof file.path !== 'string' || !canonicalPath(file.path)
      || paths.has(file.path) || !Number.isSafeInteger(file.size) || (file.size as number) < 0
      || (file.size as number) > MAX_BYTES || typeof file.sha256 !== 'string' || !DIGEST.test(file.sha256)) {
      throw new Error('Invalid operator sync receipt');
    }
    paths.add(file.path);
    total += file.size as number;
    if (total > MAX_BYTES) throw new Error('Invalid operator sync receipt');
    return { path: file.path, size: file.size as number, sha256: file.sha256 };
  });
}
function validateReceipt(value: unknown, operationId?: string): OperatorSyncReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operator sync receipt');
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).length !== 6 || receipt.schemaVersion !== 1
    || typeof receipt.operationId !== 'string' || !ID.test(receipt.operationId)
    || (operationId !== undefined && receipt.operationId !== operationId)
    || typeof receipt.requestDigest !== 'string' || !DIGEST.test(receipt.requestDigest)
    || typeof receipt.status !== 'string' || !STATUS.has(receipt.status)
    || (receipt.manifestDigest !== null && (typeof receipt.manifestDigest !== 'string' || !DIGEST.test(receipt.manifestDigest)))) {
    throw new Error('Invalid operator sync receipt');
  }
  return { schemaVersion: 1, operationId: receipt.operationId, requestDigest: receipt.requestDigest,
    status: receipt.status as OperatorSyncReceipt['status'], manifestDigest: receipt.manifestDigest as string | null,
    files: validateFiles(receipt.files) };
}

type OpenFile = typeof open;

export class OwnedOperatorSyncFiles implements OperatorSyncFiles {
  private readonly root: string;
  constructor(root: string, private readonly openFile: OpenFile = open) {
    if (!path.isAbsolute(root)) throw new Error('Invalid owned output root');
    this.root = path.resolve(root);
  }
  async inspect(paths: readonly string[]): Promise<OperatorSyncFile[]> {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 128 || new Set(paths).size !== paths.length) {
      throw new Error('Invalid operator sync request');
    }
    let total = 0;
    const files: OperatorSyncFile[] = [];
    for (const relativePath of paths) {
      if (!canonicalPath(relativePath)) throw new Error('Invalid operator sync request');
      const lexical = path.resolve(this.root, relativePath);
      if (!lexical.startsWith(`${this.root}${path.sep}`)) throw new Error('Invalid owned output path');
      const info = await stat(lexical);
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid operator sync request');
      total += info.size;
      if (total > MAX_BYTES) throw new Error('Invalid operator sync request');
      const bytes = await this.read(relativePath, info.size);
      files.push({ path: relativePath, size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return files;
  }
  async read(relativePath: string, expectedSize: number): Promise<Uint8Array> {
    if (!canonicalPath(relativePath) || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_BYTES) {
      throw new Error('Invalid owned output path');
    }
    const lexical = path.resolve(this.root, relativePath);
    if (!lexical.startsWith(`${this.root}${path.sep}`)) throw new Error('Invalid owned output path');
    if ((await lstat(lexical)).isSymbolicLink()) throw new Error('Owned output symlink is forbidden');
    const [canonicalRoot, canonicalFile] = await Promise.all([realpath(this.root), realpath(lexical)]);
    if (!canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error('Invalid owned output path');
    const handle = await this.openFile(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // The descriptor, not the pre-open pathname, is the read authority. A
      // parent-directory symlink swap between realpath and open can otherwise
      // redirect a same-sized output outside the activity root.
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!openedPath.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error('Invalid owned output path');
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Owned output is not a regular file');
      if (info.size !== expectedSize) throw new Error('Owned output size mismatch');
      const bytes = await handle.readFile();
      if (bytes.byteLength !== expectedSize) throw new Error('Owned output size mismatch');
      return Uint8Array.from(bytes);
    } finally {
      await handle.close();
    }
  }
}

export class FileOperatorSyncStore implements OperatorSyncStore {
  private readonly directory: string;
  constructor(directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('Invalid operator receipt directory');
    this.directory = path.resolve(directory);
  }
  async load(operationId: string): Promise<OperatorSyncReceipt | null> {
    const file = this.file(operationId);
    let info;
    try { info = await stat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || info.size > MAX_STATE) throw new Error('Operator sync receipt is too large');
    const bytes = await readFile(file);
    if (bytes.byteLength > MAX_STATE) throw new Error('Operator sync receipt is too large');
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid operator sync receipt'); }
    return validateReceipt(value, operationId);
  }
  async save(receipt: OperatorSyncReceipt): Promise<void> {
    const value = validateReceipt(receipt);
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.byteLength > MAX_STATE) throw new Error('Operator sync receipt is too large');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.file(value.operationId);
    const temporary = path.join(this.directory, `.${value.operationId}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, destination); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }
  private file(operationId: string): string {
    if (!ID.test(operationId)) throw new Error('Invalid operator sync operation');
    return path.join(this.directory, `${operationId}.json`);
  }
}

type Runner = (command: string, args: readonly string[], bytes: Uint8Array) => Promise<number>;
async function runRclone(command: string, args: readonly string[], bytes: Uint8Array): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'], shell: false });
    const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code ?? 1); });
    child.stdin.once('error', reject);
    child.stdin.end(bytes);
  });
}

export class RcloneOperatorSyncUploader implements OperatorSyncUploader {
  private readonly bucket: string;
  private readonly prefixes: readonly string[];
  private readonly configFile: string;
  private readonly run: Runner;
  constructor(options: { bucket: string; prefixes: readonly string[]; configFile: string; run?: Runner }) {
    if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(options.bucket) || options.prefixes.length < 1
      || options.prefixes.some(prefix => !canonicalPath(prefix.slice(0, -1)) || !prefix.endsWith('/'))
      || !path.isAbsolute(options.configFile)) throw new Error('Invalid operator upload scope');
    this.bucket = options.bucket;
    this.prefixes = [...options.prefixes];
    this.configFile = path.resolve(options.configFile);
    this.run = options.run ?? runRclone;
  }
  async put(operationId: string, key: string, bytes: Uint8Array): Promise<void> {
    if (!ID.test(operationId) || !this.prefixes.some(prefix => key.startsWith(prefix))
      || !canonicalPath(key) || bytes.byteLength > MAX_BYTES) {
      throw new Error('Operator upload escaped its scope');
    }
    // `--header` reaches the S3 backend. `--header-upload` is ignored by its PUT path.
    // The parent performs the trusted read, so avoid rclone's broader post-PUT HEAD.
    const code = await this.run('rclone', ['rcat', `r2:${this.bucket}/${key}`, '--config', this.configFile,
      '--size', String(bytes.byteLength), '--header', `X-Codeflare-Operator-Sync-Operation: ${operationId}`,
      '--s3-no-head'],
    Uint8Array.from(bytes));
    if (code !== 0) throw new Error('Operator upload failed');
  }
}
