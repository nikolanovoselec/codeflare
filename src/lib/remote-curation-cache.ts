import type { Env } from '../types';
import { readBoundedResponse } from './bounded-stream';
import { createR2Client, getR2Url } from './r2-client';

const MAX_ACTIVE_POINTER_BYTES = 16 * 1024;

interface ManagedReleaseSelection {
  schemaVersion: 1;
  enabled: true;
  repository: string;
  repositoryId: number;
  publicKeyHex: string;
  publicKeyFingerprint: string;
  configFingerprint: string;
  cacheBucketName: string;
}

export interface ActiveManagedRelease {
  schemaVersion: 1;
  seedAbi: 1;
  sequence: number;
  digest: string;
  repositoryId: number;
  releaseId: number;
  releaseTag: string;
  sourceCommit: string;
  runtimeDependencyHash: string;
  activatedAt: string;
  selection?: ManagedReleaseSelection;
}

export interface ManagedReleaseCache {
  putImmutable(key: string, bytes: Uint8Array): Promise<void>;
  hasRelease?(digest: string): Promise<boolean>;
  readActive(): Promise<{ pointer: ActiveManagedRelease; etag: string } | undefined>;
  createActive(pointer: ActiveManagedRelease): Promise<boolean>;
  replaceActive(pointer: ActiveManagedRelease, etag: string): Promise<boolean>;
}

function sameSelection(
  left: ManagedReleaseSelection | undefined,
  right: ManagedReleaseSelection | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.schemaVersion === right.schemaVersion
    && left.enabled === right.enabled
    && left.repository === right.repository
    && left.repositoryId === right.repositoryId
    && left.publicKeyHex === right.publicKeyHex
    && left.publicKeyFingerprint === right.publicKeyFingerprint
    && left.configFingerprint === right.configFingerprint
    && left.cacheBucketName === right.cacheBucketName;
}

function sameRelease(left: ActiveManagedRelease, right: ActiveManagedRelease): boolean {
  return left.sequence === right.sequence
    && left.digest === right.digest
    && left.repositoryId === right.repositoryId
    && left.releaseId === right.releaseId
    && left.releaseTag === right.releaseTag
    && left.sourceCommit === right.sourceCommit
    && left.runtimeDependencyHash === right.runtimeDependencyHash
    && sameSelection(left.selection, right.selection);
}

function resolveAgainstCurrent(
  candidate: ActiveManagedRelease,
  current: ActiveManagedRelease,
): ActiveManagedRelease | undefined {
  if (current.runtimeDependencyHash !== candidate.runtimeDependencyHash) return undefined;
  if (current.sequence > candidate.sequence) return current;
  if (current.sequence === candidate.sequence) {
    if (!sameRelease(current, candidate)) {
      throw new Error('Managed release has the same sequence with conflicting identity or content');
    }
    return current;
  }
  return undefined;
}

function parseActivePointer(value: unknown): ActiveManagedRelease {
  if (!value || typeof value !== 'object') throw new Error('Managed release active pointer is invalid');
  const pointer = value as Record<string, unknown>;
  const selection = pointer.selection as Record<string, unknown> | undefined;
  const selectionIsInvalid = selection !== undefined && (
    !selection
    || typeof selection !== 'object'
    || selection.schemaVersion !== 1
    || selection.enabled !== true
    || typeof selection.repository !== 'string'
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(selection.repository)
    || typeof selection.repositoryId !== 'number'
    || !Number.isSafeInteger(selection.repositoryId)
    || selection.repositoryId <= 0
    || typeof selection.publicKeyHex !== 'string'
    || !/^[0-9a-f]{64}$/.test(selection.publicKeyHex)
    || typeof selection.publicKeyFingerprint !== 'string'
    || !/^[0-9a-f]{16}$/.test(selection.publicKeyFingerprint)
    || typeof selection.configFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(selection.configFingerprint)
    || typeof selection.cacheBucketName !== 'string'
    || selection.cacheBucketName.length === 0
    || selection.cacheBucketName.length > 63
  );
  if (
    selectionIsInvalid
    || pointer.schemaVersion !== 1
    || pointer.seedAbi !== 1
    || typeof pointer.sequence !== 'number'
    || !Number.isSafeInteger(pointer.sequence)
    || pointer.sequence <= 0
    || pointer.sequence > 2 ** 32
    || typeof pointer.digest !== 'string'
    || !/^[0-9a-f]{64}$/.test(pointer.digest)
    || typeof pointer.repositoryId !== 'number'
    || !Number.isSafeInteger(pointer.repositoryId)
    || pointer.repositoryId <= 0
    || typeof pointer.releaseId !== 'number'
    || !Number.isSafeInteger(pointer.releaseId)
    || pointer.releaseId <= 0
    || typeof pointer.releaseTag !== 'string'
    || pointer.releaseTag.length === 0
    || pointer.releaseTag.length > 256
    || /[\u0000-\u001f\u007f]/.test(pointer.releaseTag)
    || typeof pointer.sourceCommit !== 'string'
    || !/^[0-9a-f]{40}$/.test(pointer.sourceCommit)
    || typeof pointer.runtimeDependencyHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(pointer.runtimeDependencyHash)
    || typeof pointer.activatedAt !== 'string'
    || !Number.isFinite(Date.parse(pointer.activatedAt))
  ) {
    throw new Error('Managed release active pointer is invalid');
  }
  return pointer as unknown as ActiveManagedRelease;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

async function managedReleaseCacheSuffix(accountId: string, workerName: string): Promise<string> {
  const normalizedAccountId = accountId.trim();
  const normalizedWorkerName = workerName.trim() || 'codeflare';
  if (!normalizedAccountId) throw new Error('Managed release cache requires a Cloudflare account ID');
  const identity = `${normalizedAccountId}\0${normalizedWorkerName}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)));
  return Array.from(digest.slice(0, 12), (value) => value.toString(16).padStart(2, '0')).join('');
}

function trimBucketHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

function recognizableWorkerName(workerName: string, maxLength: number): string {
  const sanitized = trimBucketHyphens(workerName.trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')) || 'codeflare';
  return trimBucketHyphens(sanitized.slice(0, maxLength)) || 'codeflare'.slice(0, maxLength);
}

/** Exact pre-recognizable derivation retained only to authenticate legacy cleanup. */
export async function getLegacyManagedReleaseCacheBucketName(
  accountId: string,
  workerName = 'codeflare',
): Promise<string> {
  return `codeflare-managed-${await managedReleaseCacheSuffix(accountId, workerName)}`;
}

export async function getManagedReleaseCacheBucketName(
  accountId: string,
  workerName = 'codeflare',
): Promise<string> {
  const suffix = `-managed-${await managedReleaseCacheSuffix(accountId, workerName)}`;
  const recognizable = recognizableWorkerName(workerName || 'codeflare', 63 - suffix.length);
  return `${recognizable}${suffix}`;
}

/**
 * S3-backed deployment cache. The caller supplies the deterministic dedicated
 * bucket name; the same deployment-wide R2 credentials used for user buckets
 * sign these requests.
 */
export function createR2ManagedReleaseCache(input: {
  env: Pick<Env, 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY'>;
  endpoint: string;
  bucketName: string;
  configFingerprint: string;
  fetcher?: typeof fetch;
}): ManagedReleaseCache {
  if (!/^[0-9a-f]{64}$/.test(input.configFingerprint)) {
    throw new Error('Managed release configuration fingerprint must be 64 lowercase hex characters');
  }
  const activePointerKey = `configs/${input.configFingerprint}/active.json`;
  const client = createR2Client(input.env);
  const fetcher = input.fetcher ?? fetch;

  const request = async (
    key: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const signed = await client.sign(getR2Url(input.endpoint, input.bucketName, key), init);
    return fetcher(signed);
  };

  const readBytes = async (key: string, maxBytes: number): Promise<{ bytes: Uint8Array; etag: string } | undefined> => {
    const response = await request(key);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Managed release cache read failed with HTTP ${response.status}`);
    const bytes = await readBoundedResponse(response, maxBytes, 'Managed release cache object');
    return { bytes, etag: response.headers.get('etag') ?? '' };
  };

  const putActive = async (
    pointer: ActiveManagedRelease,
    condition: { ifMatch?: string; ifNoneMatch?: '*' },
  ): Promise<boolean> => {
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'x-amz-server-side-encryption': 'AES256',
    });
    if (condition.ifMatch) headers.set('If-Match', condition.ifMatch);
    if (condition.ifNoneMatch) headers.set('If-None-Match', condition.ifNoneMatch);
    const response = await request(activePointerKey, {
      method: 'PUT',
      headers,
      body: JSON.stringify(pointer),
    });
    if (response.status === 412) return false;
    if (!response.ok) throw new Error(`Managed release cache activation failed with HTTP ${response.status}`);
    return true;
  };

  return {
    async putImmutable(key, bytes) {
      if (!/^releases\/[0-9a-f]{64}\/seed-v1\.(?:json\.gz|sig)$/.test(key)) {
        throw new Error('Managed release immutable cache key is invalid');
      }
      const response = await request(key, {
        method: 'PUT',
        headers: {
          'Content-Type': key.endsWith('.sig') ? 'application/octet-stream' : 'application/gzip',
          'If-None-Match': '*',
          'x-amz-server-side-encryption': 'AES256',
        },
        body: bytes,
      });
      if (response.ok) return;
      if (response.status !== 412) throw new Error(`Managed release cache write failed with HTTP ${response.status}`);
      const existing = await readBytes(key, bytes.byteLength);
      if (!existing || !equalBytes(existing.bytes, bytes)) {
        throw new Error(`Managed release immutable cache conflict at ${key}`);
      }
    },
    async hasRelease(digest) {
      if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Managed release digest must be 64 lowercase hex characters');
      for (const name of ['seed-v1.json.gz', 'seed-v1.sig']) {
        const response = await request(`releases/${digest}/${name}`, { method: 'HEAD' });
        if (response.status === 404) return false;
        if (!response.ok) throw new Error(`Managed release cache HEAD failed with HTTP ${response.status}`);
      }
      return true;
    },
    async readActive() {
      const object = await readBytes(activePointerKey, MAX_ACTIVE_POINTER_BYTES);
      if (!object) return undefined;
      if (!object.etag) throw new Error('Managed release active pointer has no ETag');
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder().decode(object.bytes));
      } catch {
        throw new Error('Managed release active pointer JSON is invalid');
      }
      return { pointer: parseActivePointer(decoded), etag: object.etag };
    },
    createActive(pointer) {
      return putActive(pointer, { ifNoneMatch: '*' });
    },
    replaceActive(pointer, etag) {
      if (!etag) throw new Error('Managed release active pointer replacement requires an ETag');
      return putActive(pointer, { ifMatch: etag });
    },
  };
}

export async function activateManagedRelease(input: {
  cache: ManagedReleaseCache;
  candidate: ActiveManagedRelease;
  bundle: Uint8Array;
  signature: Uint8Array;
}): Promise<ActiveManagedRelease> {
  const releasePrefix = `releases/${input.candidate.digest}`;
  await Promise.all([
    input.cache.putImmutable(`${releasePrefix}/seed-v1.json.gz`, input.bundle),
    input.cache.putImmutable(`${releasePrefix}/seed-v1.sig`, input.signature),
  ]);
  return activateCachedManagedRelease(input.cache, input.candidate);
}

export async function activateCachedManagedRelease(
  cache: ManagedReleaseCache,
  candidate: ActiveManagedRelease,
): Promise<ActiveManagedRelease> {
  const observed = await cache.readActive();
  if (!observed) {
    if (await cache.createActive(candidate)) return candidate;
    const winner = await cache.readActive();
    if (!winner) throw new Error('Managed release activation lost create race without an active pointer');
    const settledWinner = resolveAgainstCurrent(candidate, winner.pointer);
    if (settledWinner) return settledWinner;
    throw new Error('Managed release activation lost to an older pointer; retry required');
  }

  const settled = resolveAgainstCurrent(candidate, observed.pointer);
  if (settled) return settled;
  if (await cache.replaceActive(candidate, observed.etag)) return candidate;

  const winner = await cache.readActive();
  if (!winner) throw new Error('Managed release activation lost update race without an active pointer');
  const settledWinner = resolveAgainstCurrent(candidate, winner.pointer);
  if (settledWinner) return settledWinner;
  throw new Error('Managed release activation lost to an older pointer; retry required');
}
