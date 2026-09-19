/** Fixed authenticated host API for explicit restricted upload and receipt reads. */
import type { OperatorSyncFile, OperatorSyncReceipt } from './operator-sync.js';

export interface OperatorSyncCoordinator {
  upload(request: { operationId: string; requestDigest: string; files: OperatorSyncFile[] }): Promise<OperatorSyncReceipt>;
  status(operationId: string): Promise<OperatorSyncReceipt | null>;
}
export interface OperatorSyncHttpResult { status: number; headers: Record<string, string>; body: string }

const PREFIX = '/internal/operator/sync/';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
function result(status: number, value: unknown): OperatorSyncHttpResult {
  return { status, headers: HEADERS, body: JSON.stringify(value) };
}
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && value !== 'manifest.json'
    && !/[\\%\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function parseRequest(body?: Uint8Array): { operationId: string; requestDigest: string; files: OperatorSyncFile[] } {
  if (!body || body.byteLength > 64 * 1024) throw new Error(body && body.byteLength > 64 * 1024 ? 'oversized' : 'invalid');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(body)); } catch { throw new Error('invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  const request = value as Record<string, unknown>;
  if (Object.keys(request).length !== 3 || typeof request.operationId !== 'string' || !ID.test(request.operationId)
    || typeof request.requestDigest !== 'string' || !DIGEST.test(request.requestDigest)
    || !Array.isArray(request.files) || request.files.length > 128) throw new Error('invalid');
  let total = 0;
  const paths = new Set<string>();
  const files = request.files.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid');
    const file = item as Record<string, unknown>;
    if (Object.keys(file).length !== 3 || !validPath(file.path) || paths.has(file.path)
      || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > 8 * 1024 * 1024
      || typeof file.sha256 !== 'string' || !DIGEST.test(file.sha256)) throw new Error('invalid');
    paths.add(file.path);
    total += file.size as number;
    if (total > 8 * 1024 * 1024) throw new Error('invalid');
    return { path: file.path, size: file.size as number, sha256: file.sha256 };
  });
  return { operationId: request.operationId, requestDigest: request.requestDigest, files };
}

export class OperatorSyncHttpController {
  constructor(private readonly coordinator: OperatorSyncCoordinator) {}
  async handle(input: { method: string; pathname: string; query?: URLSearchParams; body?: Uint8Array }): Promise<OperatorSyncHttpResult | null> {
    if (input.pathname !== '/internal/bisync-trigger' && !input.pathname.startsWith(PREFIX)) return null;
    if (input.query && [...input.query.keys()].length > 0) {
      return result(400, { error: 'Invalid sync request', code: 'SYNC_REQUEST_INVALID' });
    }
    if (input.body && input.body.byteLength > 64 * 1024) return result(413, { error: 'Request body too large', code: 'REQUEST_TOO_LARGE' });
    try {
      if (input.pathname === '/internal/bisync-trigger') {
        if (input.method !== 'POST') return result(405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return result(200, await this.coordinator.upload(parseRequest(input.body)));
      }
      const match = input.pathname.match(/^\/internal\/operator\/sync\/operations\/([A-Za-z0-9_-]{1,128})$/);
      if (match) {
        if (input.method !== 'GET') return result(405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
        const receipt = await this.coordinator.status(match[1]);
        return receipt ? result(200, receipt) : result(404, { error: 'Sync operation not found', code: 'SYNC_NOT_FOUND' });
      }
      return result(404, { error: 'Unknown sync operation', code: 'SYNC_ROUTE_NOT_FOUND' });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (message === 'oversized') return result(413, { error: 'Request body too large', code: 'REQUEST_TOO_LARGE' });
      if (message === 'invalid' || message.includes('invalid operator sync')) {
        return result(400, { error: 'Invalid sync request', code: 'SYNC_REQUEST_INVALID' });
      }
      if (errorCode === 'ENOENT') {
        return result(409, { error: 'Sync output is unavailable', code: 'SYNC_OUTPUT_NOT_FOUND' });
      }
      if (message.includes('owned output size mismatch') || message.includes('operator sync file mismatch')) {
        return result(409, { error: 'Sync output does not match its declaration', code: 'SYNC_OUTPUT_MISMATCH' });
      }
      if (message.includes('operator sync state unavailable')) {
        return result(503, { error: 'Sync state is unavailable', code: 'SYNC_STATE_FAILED' });
      }
      if (message.includes('conflict')) return result(409, { error: 'Sync operation conflict', code: 'SYNC_CONFLICT' });
      if (message.includes('unknown')) return result(202, { status: 'unknown', code: 'SYNC_OUTCOME_UNKNOWN' });
      if (message.includes('expired')) return result(403, { error: 'Sync authority expired', code: 'SYNC_AUTHORITY_EXPIRED' });
      return result(500, { error: 'Sync operation failed', code: 'SYNC_OPERATION_FAILED' });
    }
  }
}
