import { z } from 'zod';
import { parseOperatorConsumerInvocation, type OperatorConsumerInvocation } from './consumer-contracts';
import { getR2Url } from '../lib/r2-client';
import { getSseHeaders } from '../lib/r2-sse';
import { readBoundedResponse } from '../lib/bounded-stream';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/);
const NAME = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const file = z.strictObject({ name: NAME, mediaType: z.string().min(3).max(129),
  size: z.number().int().positive().max(8 * 1024 * 1024), sha256: DIGEST, locator: ID });
const projection = z.strictObject({ schemaVersion: z.literal(1), activityId: ID,
  files: z.array(file).max(16).refine(files => new Set(files.map(item => item.name)).size === files.length
    && new Set(files.map(item => item.locator)).size === files.length
    && files.reduce((total, item) => total + item.size, 0) <= 8 * 1024 * 1024) });

export type OperatorAttachmentProjection = z.infer<typeof projection>;

function sameFile(a: z.infer<typeof file>, b: z.infer<typeof file>): boolean {
  return a.name === b.name && a.mediaType === b.mediaType && a.size === b.size
    && a.sha256 === b.sha256 && a.locator === b.locator;
}

export function projectOperatorAttachments(input: unknown): OperatorAttachmentProjection {
  const invocation: OperatorConsumerInvocation = parseOperatorConsumerInvocation(input);
  return projection.parse({ schemaVersion: 1, activityId: invocation.activityId, files: invocation.attachments });
}

export function parseOperatorAttachmentProjection(input: unknown): OperatorAttachmentProjection {
  return projection.parse(input);
}

export function resolveOperatorAttachment(projectionInput: unknown,
  request: { locator: string; sha256: string; size: number }): { status: 'restored'; path: string } {
  const declared = parseOperatorAttachmentProjection(projectionInput).files.find(item => item.locator === request.locator
    && item.sha256 === request.sha256 && item.size === request.size);
  if (!declared) throw new Error('Attachment scope denied');
  return { status: 'restored', path: `/run/codeflare/operator-resources/input/${declared.name}` };
}

/** Parent-only immutable R2 materialization; a lost conditional PUT response is resolved by
 * reading the exact object, not by overwriting it. No path or R2 credential reaches Pi. */
export async function readApprovedPacketAttachment(input: {
  projection: unknown; file: unknown; ownerBucket: string; endpoint: string;
  fetcher: (request: Request) => Promise<Response>; authorize: () => Promise<void>;
  isBucketMigrating: () => Promise<boolean>; isSseDisabledForBucket: () => Promise<boolean>;
  sseKey?: string; signal?: AbortSignal;
}): Promise<Uint8Array> {
  const scope = parseOperatorAttachmentProjection(input.projection);
  const declared = file.parse(input.file);
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(input.ownerBucket)
    || !scope.files.some(item => sameFile(item, declared))
    || input.signal?.aborted) throw new Error('Approved attachment read denied');
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/') throw new Error('Approved attachment endpoint denied');
  await input.authorize();
  if (await input.isBucketMigrating()) throw new Error('Approved attachment bucket migrating');
  const headers = getSseHeaders({ ENCRYPTION_KEY: input.sseKey }, await input.isSseDisabledForBucket());
  const url = getR2Url(input.endpoint, input.ownerBucket,
    `.codeflare/operator-inputs/${scope.activityId}/${declared.locator}`);
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(input.signal ? [input.signal] : [])]);
  await input.authorize();
  const response = await input.fetcher(new Request(url, { method: 'GET', redirect: 'manual', signal, headers }));
  if (response.status !== 200 || response.redirected) throw new Error('Approved attachment read unavailable');
  const received = await readBoundedResponse(response, declared.size, 'Approved attachment', signal);
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(received))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (received.byteLength !== declared.size || actual !== declared.sha256 || signal.aborted
    || await input.isBucketMigrating()) throw new Error('Approved attachment read mismatch');
  await input.authorize();
  return received;
}

export async function persistApprovedPacketAttachment(input: {
  projection: unknown; file: unknown; bytes: Uint8Array; ownerBucket: string; endpoint: string;
  fetcher: (request: Request) => Promise<Response>; authorize: () => Promise<void>;
  isBucketMigrating: () => Promise<boolean>; isSseDisabledForBucket: () => Promise<boolean>;
  sseKey?: string; signal?: AbortSignal;
}): Promise<z.infer<typeof file>> {
  const scope = parseOperatorAttachmentProjection(input.projection);
  const declared = file.parse(input.file);
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(input.ownerBucket)
    || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength !== declared.size
    || !scope.files.some(item => sameFile(item, declared))
    || input.signal?.aborted) throw new Error('Approved attachment denied');
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/') throw new Error('Approved attachment endpoint denied');
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(input.bytes))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== declared.sha256) throw new Error('Approved attachment digest mismatch');
  await input.authorize();
  if (await input.isBucketMigrating()) throw new Error('Approved attachment bucket migrating');
  const headers = getSseHeaders({ ENCRYPTION_KEY: input.sseKey }, await input.isSseDisabledForBucket());
  const url = getR2Url(input.endpoint, input.ownerBucket,
    `.codeflare/operator-inputs/${scope.activityId}/${declared.locator}`);
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(input.signal ? [input.signal] : [])]);
  await input.authorize();
  try {
    const stored = await input.fetcher(new Request(url, { method: 'PUT', redirect: 'manual', signal,
      headers: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*', ...headers },
      body: Uint8Array.from(input.bytes) }));
    if (stored.redirected || ![200, 201, 204, 412].includes(stored.status)) {
      throw new Error('Approved attachment write unavailable');
    }
  } catch {
    // A lost successful response is ambiguous. The verification read below is authoritative.
  }
  await input.authorize();
  const response = await input.fetcher(new Request(url, { method: 'GET', redirect: 'manual', signal, headers }));
  if (response.status !== 200 || response.redirected) throw new Error('Approved attachment verification unavailable');
  const received = await readBoundedResponse(response, declared.size, 'Approved attachment', signal);
  const readDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(received))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (received.byteLength !== declared.size || readDigest !== declared.sha256
    || signal.aborted || await input.isBucketMigrating()) throw new Error('Approved attachment verification failed');
  await input.authorize();
  return declared;
}
