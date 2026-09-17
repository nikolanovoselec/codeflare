/**
 * Independent storage evidence verification
 * Parent-established scope and reader contracts precede manifest validation and byte verification.
 * The reader must be owner-scoped and bounded before buffering. The parent must seal writes before
 * recording durability; this verifier performs no upload, delete, receipt mutation or shutdown.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import { z } from 'zod';
import { ValidationError } from '../lib/error-types';

/** Parent-established operation scope; never accept an agent-selected bucket or prefix. */
export interface OperatorSyncExpectation {
  activityId: string;
  sessionId: string;
  operationId: string;
  requestDigest: string;
  policyDigest: string;
  manifestDigest: string;
  prefix: string;
  deadline: number;
}

/** Adapter must enforce maxBytes while reading, before materializing the object. */
export type OperatorSyncReader = (key: string, maxBytes: number) => Promise<Uint8Array | null>;

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

function canonicalPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024
    && !/[\\%\x00-\x1f\x7f]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  activityId: identity,
  sessionId: identity,
  operationId: identity,
  requestDigest: digest,
  policyDigest: digest,
  files: z.array(z.strictObject({
    path: z.string().refine(path => canonicalPath(path) && path !== 'manifest.json'),
    size: z.number().int().min(0).max(MAX_OUTPUT_BYTES),
    sha256: digest,
  })).max(128),
}).refine(manifest => new Set(manifest.files.map(file => file.path)).size === manifest.files.length
  && manifest.files.reduce((total, file) => total + file.size, 0) <= MAX_OUTPUT_BYTES);

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * REQ-OPERATOR-024: Independently verify stored manifest/file bytes, not an upload
 * signal or timestamp. The parent authorizes the owner-scoped reader and selects
 * the exact operation prefix/digests. It must seal the operation against further
 * writes before treating these facts as durable completion. This function performs
 * no upload, deletion, retry or receipt mutation, and never trusts a child bucket.
 * Reader implementations own bounded transport/cancellation; authority is checked
 * before each read and after hashing. Errors never reflect output or credentials.
 */
export async function verifyOperatorSync(
  expected: OperatorSyncExpectation,
  read: OperatorSyncReader,
): Promise<{ manifestDigest: string; filesVerified: number; bytesVerified: number }> {
  const checkAuthority = () => {
    if (!Number.isFinite(expected.deadline) || Date.now() >= expected.deadline) throw new Error('Expired authority');
  };
  try {
    checkAuthority();
    if (!expected.prefix.endsWith('/') || !canonicalPath(expected.prefix.slice(0, -1))
      || !digest.safeParse(expected.manifestDigest).success) throw new Error('Invalid operation scope');
    const stored = await read(`${expected.prefix}manifest.json`, MAX_MANIFEST_BYTES);
    if (!stored || stored.byteLength > MAX_MANIFEST_BYTES) throw new Error('Missing or oversized manifest');
    const manifestBytes = Uint8Array.from(stored);
    if (await sha256(manifestBytes) !== expected.manifestDigest) throw new Error('Manifest integrity mismatch');
    checkAuthority();
    const manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(manifestBytes)));
    if (manifest.activityId !== expected.activityId || manifest.sessionId !== expected.sessionId
      || manifest.operationId !== expected.operationId || manifest.requestDigest !== expected.requestDigest
      || manifest.policyDigest !== expected.policyDigest) throw new Error('Manifest scope mismatch');

    let bytesVerified = 0;
    for (const file of manifest.files) {
      checkAuthority();
      const bytes = await read(`${expected.prefix}${file.path}`, file.size);
      if (!bytes || bytes.byteLength !== file.size || await sha256(bytes) !== file.sha256) {
        throw new Error('Output integrity mismatch');
      }
      checkAuthority();
      bytesVerified += file.size;
    }
    return { manifestDigest: expected.manifestDigest, filesVerified: manifest.files.length, bytesVerified };
  } catch {
    throw new ValidationError('Operator sync evidence verification failed');
  }
}
