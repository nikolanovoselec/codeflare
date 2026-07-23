import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

const FIRE_AND_FORGET_METHODS = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']);

export type ApprovalOperation = 'edit' | 'write' | 'bash' | 'unknown';

export interface ApprovalManifest {
  readonly id: string;
  readonly expiresAt: number;
  readonly operation?: ApprovalOperation;
  readonly canonicalTarget?: string;
  readonly baseHash?: string;
  readonly resultHash?: string;
  readonly previewId?: string;
  readonly nonce?: string;
  readonly toolName?: string;
  readonly createdAt?: number;
  readonly preview?:
    | Readonly<{ kind: 'diff'; path: string; diff: string; beforeSha256: string; afterSha256: string }>
    | Readonly<{ kind: 'bash'; command: string; cwd: string }>
    | Readonly<{ kind: 'generic'; toolName: string; input: unknown }>;
}

export interface ApprovalHost {
  loadManifest(opaqueId: string): Promise<string>;
  openDiff(manifest: ApprovalManifest): Promise<void>;
  confirm(manifest: ApprovalManifest): Promise<boolean>;
}

export interface PiExtensionUiRequest {
  readonly type: 'extension_ui_request';
  readonly id: string;
  readonly method: string;
  readonly title?: string;
  readonly message?: string;
}

export interface PiExtensionUiResponse {
  readonly type: 'extension_ui_response';
  readonly id: string;
  readonly confirmed: boolean;
}

export type ApprovalBridgeErrorCode =
  | 'UNSUPPORTED_UI_REQUEST'
  | 'INVALID_APPROVAL_ID'
  | 'INVALID_MANIFEST'
  | 'EXPIRED_APPROVAL';

export class ApprovalBridgeError extends Error {
  readonly code: ApprovalBridgeErrorCode;

  constructor(code: ApprovalBridgeErrorCode) {
    super(`Pi approval bridge error: ${code}`);
    this.name = 'ApprovalBridgeError';
    this.code = code;
  }
}

export class ApprovalBridge {
  readonly #host: ApprovalHost;
  readonly #pending = new Set<string>();
  readonly #consumed = new Set<string>();
  readonly #consumedOrder: string[] = [];

  constructor(host: ApprovalHost) {
    this.#host = host;
  }

  async handlePiRequest(
    request: PiExtensionUiRequest,
    signal?: AbortSignal,
  ): Promise<PiExtensionUiResponse | undefined> {
    if (!validRpcId(request.id)) throw new ApprovalBridgeError('INVALID_APPROVAL_ID');
    if (FIRE_AND_FORGET_METHODS.has(request.method)) return undefined;
    if (request.method !== 'confirm') throw new ApprovalBridgeError('UNSUPPORTED_UI_REQUEST');
    const approvalReference = parseApprovalReference(request.message);
    if (!approvalReference) throw new ApprovalBridgeError('INVALID_APPROVAL_ID');
    const { approvalId, manifestDigest } = approvalReference;
    if (this.#pending.has(approvalId) || this.#consumed.has(approvalId)) {
      throw new ApprovalBridgeError('INVALID_APPROVAL_ID');
    }

    this.#pending.add(approvalId);
    try {
      if (signal?.aborted) return this.#consume(approvalId, request.id, false);
      const loaded = await raceWithAbort(this.#loadAndValidate(approvalId, manifestDigest), signal);
      if (loaded.cancelled) return this.#consume(approvalId, request.id, false);
      const manifest = loaded.value;
      if (manifest.expiresAt < Date.now()) throw new ApprovalBridgeError('EXPIRED_APPROVAL');
      const previewed = await raceWithAbort(this.#host.openDiff(manifest), signal);
      if (previewed.cancelled) return this.#consume(approvalId, request.id, false);
      const decision = await raceWithAbort(this.#host.confirm(manifest), signal);
      return this.#consume(approvalId, request.id, decision.cancelled ? false : decision.value);
    } finally {
      this.#pending.delete(approvalId);
    }
  }

  #consume(approvalId: string, requestId: string, confirmed: boolean): PiExtensionUiResponse {
    this.#consumed.add(approvalId);
    this.#consumedOrder.push(approvalId);
    while (this.#consumedOrder.length > 4_096) {
      const expired = this.#consumedOrder.shift();
      if (expired) this.#consumed.delete(expired);
    }
    return { type: 'extension_ui_response', id: requestId, confirmed };
  }

  async #loadAndValidate(approvalId: string, expectedDigest: string): Promise<ApprovalManifest> {
    let content: string;
    try {
      content = await this.#host.loadManifest(approvalId);
    } catch {
      throw new ApprovalBridgeError('INVALID_MANIFEST');
    }
    if (createHash('sha256').update(content).digest('hex') !== expectedDigest) {
      throw new ApprovalBridgeError('INVALID_MANIFEST');
    }
    let manifest: ApprovalManifest;
    try {
      manifest = JSON.parse(content) as ApprovalManifest;
    } catch {
      throw new ApprovalBridgeError('INVALID_MANIFEST');
    }
    if (!validManifest(manifest, approvalId)) throw new ApprovalBridgeError('INVALID_MANIFEST');
    return manifest;
  }
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
  if (!signal) return { cancelled: false, value: await operation };
  if (signal.aborted) return { cancelled: true };
  let abort = (): void => undefined;
  const cancelled = new Promise<{ cancelled: true }>((resolve) => {
    abort = () => resolve({ cancelled: true });
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([
      operation.then((value) => ({ cancelled: false as const, value })),
      cancelled,
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function validRpcId(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function validApprovalId(value: string | undefined): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(value);
}

function parseApprovalReference(value: string | undefined): { approvalId: string; manifestDigest: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const separator = value.lastIndexOf(':');
  if (separator < 1) return undefined;
  const approvalId = value.slice(0, separator);
  const manifestDigest = value.slice(separator + 1);
  if (!validApprovalId(approvalId) || !sha256(manifestDigest)) return undefined;
  return { approvalId, manifestDigest: manifestDigest.toLowerCase() };
}

function validManifest(value: ApprovalManifest, expectedId: string): boolean {
  if (!value || value.id !== expectedId || !Number.isSafeInteger(value.expiresAt)) return false;
  if (value.preview) {
    if (!bounded(value.toolName, 256) || !Number.isSafeInteger(value.createdAt) ||
      Number(value.createdAt) > value.expiresAt || !hashOrNonce(value.nonce)) return false;
    if (value.preview.kind === 'diff') {
      return workspacePath(value.preview.path) && bounded(value.preview.diff, 1024 * 1024) &&
        sha256(value.preview.beforeSha256) && sha256(value.preview.afterSha256);
    }
    if (value.preview.kind === 'bash') {
      return bounded(value.preview.command, 64 * 1024) && value.preview.cwd === '/home/user/workspace';
    }
    if (value.preview.kind === 'generic') {
      return bounded(value.preview.toolName, 256) && serializesWithin(value.preview.input, 64 * 1024);
    }
    return false;
  }
  return typeof value.operation === 'string' && bounded(value.canonicalTarget, 4_096) &&
    bounded(value.baseHash, 128) && bounded(value.resultHash, 128) && bounded(value.previewId, 256) &&
    bounded(value.nonce, 256);
}

function bounded(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function hashOrNonce(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{64}|[0-9a-f-]{32,36})$/i.test(value);
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function workspacePath(value: unknown): value is string {
  if (!bounded(value, 4_096) || !isAbsolute(value)) return false;
  const root = '/home/user/workspace';
  const rel = relative(root, resolve(value));
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

function serializesWithin(value: unknown, maxBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= maxBytes;
  } catch {
    return false;
  }
}
