/**
 * Storage upload routes
 * Handles simple and multipart uploads to R2
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AccessUser, Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';
import { createR2Client, getR2Url, parseInitiateMultipartUploadXml } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { ValidationError, ContainerError, BucketMigratingError } from '../../lib/error-types';
import { decodeXmlEntities, escapeXml } from '../../lib/xml-utils';
import { validateKey, MAX_KEY_LENGTH } from './validation';
import { parseJsonBody } from '../../lib/request-helpers';
import { getSseHeaders } from '../../lib/r2-sse';
import { getRegimeState, getBucketStorageOwner, isR2SseDisabledForBucket, isBucketMigrating } from '../../lib/r2-migration';
import { guardManagedStorageMutation } from '../../lib/managed-storage-guard';

const storageUploadRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 60,
  keyPrefix: 'storage-upload',
});

const SimpleUploadSchema = z.object({
  key: z.string().min(1).max(MAX_KEY_LENGTH),
  content: z.string(),
});

const InitiateUploadSchema = z.object({
  key: z.string().min(1).max(MAX_KEY_LENGTH),
});

const UploadPartSchema = z.object({
  key: z.string().min(1).max(MAX_KEY_LENGTH),
  uploadId: z.string().min(1),
  partNumber: z.number().int().min(1),
  content: z.string().min(1),
});

const CompleteUploadBodySchema = z.object({
  key: z.string().min(1).max(MAX_KEY_LENGTH),
  uploadId: z.string().min(1),
  parts: z.array(z.object({
    partNumber: z.number().int().min(1),
    etag: z.string().regex(/^[a-fA-F0-9-]+$/, 'Invalid etag format'),
  })).min(1),
});

const AbortUploadSchema = z.object({
  key: z.string().min(1).max(MAX_KEY_LENGTH),
  uploadId: z.string().min(1),
});

function forwardMultipart(env: Env, input: BucketMultipartOperation): Promise<Response> {
  return getBucketStorageOwner(env, input.bucketName).runBucketMultipart(new Request('http://container/bucket-multipart', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }));
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', storageUploadRateLimiter);

/**
 * POST /
 * Simple upload (≤ 5MB). Body: { key, content (base64) }
 */
app.post('/', async (c) => {
  const body = await parseJsonBody(c, SimpleUploadSchema);
  const sanitizedKey = validateKey(body.key);

  const bucketName = c.get('bucketName');
  // REQ-ENTERPRISE-020: block writes while the bucket's encryption regime is migrating so a
  // new object can't land in the wrong (pre-flip) regime. 409 BUCKET_MIGRATING until ready.
  if (await isBucketMigrating(c.env, bucketName)) throw new BucketMigratingError();
  await guardManagedStorageMutation({ env: c.env, bucketName, user: c.get('user'), keys: [sanitizedKey] });
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);
  // REQ-ENTERPRISE-018: SSE-C headers follow the bucket's regime marker (see download.ts).
  const r2SseDisabled = await isR2SseDisabledForBucket(c.env, bucketName);

  let binaryContent: Uint8Array;
  try {
    binaryContent = Uint8Array.from(atob(body.content), ch => ch.charCodeAt(0));
  } catch {
    throw new ValidationError('Invalid base64 content');
  }
  const url = getR2Url(endpoint, bucketName, sanitizedKey);

  const response = await r2Client.fetch(url, {
    method: 'PUT',
    body: binaryContent,
    headers: { 'Content-Type': 'application/octet-stream', ...getSseHeaders(c.env, r2SseDisabled) },
  });

  if (!response.ok) {
    throw new ContainerError('upload', `R2 PutObject failed: ${response.status}`);
  }

  // Invalidate storage-stats cache so next poll/fetch gets fresh data
  await c.env.KV.delete(`storage-stats:${bucketName}`);

  // REQ-STOR-015 keeps three triggers only: 15-min cadence, manual
  // Sync-now button, container shutdown. R2 uploads do not auto-fan-
  // out to running containers; the user clicks Sync-now to propagate
  // immediately, or waits for the next 15-minute cycle. This avoids
  // bursting Worker subrequest budget when uploading many files at
  // once.
  return c.json({ key: sanitizedKey, size: binaryContent.length });
});

/**
 * POST /initiate
 * Initiate multipart upload. Body: { key }
 */
app.post('/initiate', async (c) => {
  const body = await parseJsonBody(c, InitiateUploadSchema);
  const sanitizedKey = validateKey(body.key);

  const bucketName = c.get('bucketName');
  // REQ-ENTERPRISE-020: block new multipart uploads during a regime migration (see simple upload).
  if (await isBucketMigrating(c.env, bucketName)) throw new BucketMigratingError();
  await guardManagedStorageMutation({ env: c.env, bucketName, user: c.get('user'), keys: [sanitizedKey] });
  return forwardMultipart(c.env, { bucketName, key: sanitizedKey, action: 'initiate', user: c.get('user') });
});

/**
 * POST /part
 * Upload a single part. Body: { key, uploadId, partNumber, content (base64) }
 */
app.post('/part', async (c) => {
  const body = await parseJsonBody(c, UploadPartSchema);
  const sanitizedKey = validateKey(body.key);

  const bucketName = c.get('bucketName');
  // REQ-ENTERPRISE-020: block part writes during a regime migration (see simple upload).
  if (await isBucketMigrating(c.env, bucketName)) throw new BucketMigratingError();
  await guardManagedStorageMutation({ env: c.env, bucketName, user: c.get('user'), keys: [sanitizedKey] });
  return forwardMultipart(c.env, { ...body, bucketName, key: sanitizedKey, action: 'part', user: c.get('user') });
});

/**
 * POST /complete
 * Complete multipart upload. Body: { key, uploadId, parts: [{partNumber, etag}] }
 */
app.post('/complete', async (c) => {
  const body = await parseJsonBody(c, CompleteUploadBodySchema);
  const sanitizedKey = validateKey(body.key);

  const bucketName = c.get('bucketName');
  // The bucket DO rechecks the regime and durable upload generation while holding admission.
  if (await isBucketMigrating(c.env, bucketName)) throw new BucketMigratingError();
  await guardManagedStorageMutation({ env: c.env, bucketName, user: c.get('user'), keys: [sanitizedKey] });
  return forwardMultipart(c.env, { ...body, bucketName, key: sanitizedKey, action: 'complete', user: c.get('user') });
});

/**
 * POST /abort
 * Abort multipart upload. Body: { key, uploadId }
 */
app.post('/abort', async (c) => {
  const body = await parseJsonBody(c, AbortUploadSchema);
  const sanitizedKey = validateKey(body.key);

  const bucketName = c.get('bucketName');
  await guardManagedStorageMutation({ env: c.env, bucketName, user: c.get('user'), keys: [sanitizedKey] });
  return forwardMultipart(c.env, { ...body, bucketName, key: sanitizedKey, action: 'abort', user: c.get('user') });
});

export type BucketMultipartOperation = { bucketName: string; key: string; user?: AccessUser } & (
  | { action: 'initiate' }
  | { action: 'part'; uploadId: string; partNumber: number; content: string }
  | { action: 'complete'; uploadId: string; parts: Array<{ partNumber: number; etag: string }> }
  | { action: 'abort'; uploadId: string }
);

type MultipartReceipt = { key: string; generation: number; regime: 'plain' | 'sse-c' };
export const MULTIPART_PENDING_COMPLETION = 'multipart:pending-completion';

/** Called only inside the bucket owner's serialized operation. Stale IDs never delete parts. */
export async function performBucketMultipart(
  env: Env,
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>,
  input: BucketMultipartOperation,
): Promise<Response> {
  const observed = await getRegimeState(env, input.bucketName);
  const verified = await storage.get<Pick<MultipartReceipt, 'generation' | 'regime'>>('multipart:regime');
  const state = observed.status === 'ready' && verified && verified.generation >= observed.generation
    ? { ...observed, generation: verified.generation, regime: verified.regime } : observed;
  const pending = await storage.get<{ key: string; uploadId: string }>(MULTIPART_PENDING_COMPLETION);
  if (state.status !== 'ready' && !(input.action === 'abort' && pending?.key === input.key && pending.uploadId === input.uploadId)) {
    return Response.json({ code: 'BUCKET_MIGRATING', error: 'Storage migration is active. Retry after it completes.' }, { status: 409 });
  }
  const restart = () => Response.json({ code: 'MULTIPART_RESTART_REQUIRED', error: 'Upload is unknown, stale, or its completion is uncertain. Restart the upload; existing parts were not deleted. An uncertain completion requires explicit abort confirmation before migration.' }, { status: 409 });
  if (input.action !== 'abort' && pending) return restart();
  const receiptKey = input.action === 'initiate' ? null : `multipart:upload:${input.uploadId}`;
  if (input.action === 'part' || input.action === 'complete') {
    const receipt = await storage.get<MultipartReceipt>(receiptKey!);
    if (!receipt || receipt.key !== input.key || receipt.generation !== state.generation || receipt.regime !== state.regime) return restart();
  }
  await guardManagedStorageMutation({ env, bucketName: input.bucketName,
    user: input.user ?? { email: '', authenticated: false }, keys: [input.key] });
  let content: Uint8Array | undefined;
  if (input.action === 'part') {
    try { content = Uint8Array.from(atob(input.content), ch => ch.charCodeAt(0)); }
    catch { throw new ValidationError('Invalid base64 content'); }
  }
  const client = createR2Client(env);
  const { endpoint } = await getR2Config(env);
  const url = getR2Url(endpoint, input.bucketName, input.key);
  const headers = getSseHeaders(env, state.regime === 'plain');
  if (input.action === 'initiate') {
    const response = await client.fetch(`${url}?uploads`, { method: 'POST', headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new ContainerError('upload', `R2 InitiateMultipartUpload failed: ${response.status}`);
    const uploadId = parseInitiateMultipartUploadXml(await response.text());
    await storage.put(`multipart:upload:${uploadId}`, { key: input.key, generation: state.generation, regime: state.regime } satisfies MultipartReceipt);
    return Response.json({ uploadId, key: input.key });
  }
  const uploadUrl = `${url}?uploadId=${encodeURIComponent(input.uploadId)}`;
  if (input.action === 'part') {
    const response = await client.fetch(`${uploadUrl}&partNumber=${input.partNumber}`, { method: 'PUT', body: content, headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new ContainerError('upload', `R2 UploadPart failed: ${response.status}`);
    return Response.json({ etag: (response.headers.get('etag') ?? '').replace(/"/g, '') });
  }
  if (input.action === 'abort') {
    // Explicit user abort is the recovery path for an uncertain completion, not an automatic stale-ID cleanup.
    const response = await client.fetch(uploadUrl, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
    const recoveringPending = pending?.key === input.key && pending.uploadId === input.uploadId;
    if (!response.ok && !(recoveringPending && response.status === 404)) throw new ContainerError('upload', `R2 AbortMultipartUpload failed: ${response.status}`);
    await storage.delete(receiptKey!);
    if (recoveringPending) await storage.delete(MULTIPART_PENDING_COMPLETION);
    return Response.json({ success: true });
  }
  const parts = [...input.parts].sort((a, b) => a.partNumber - b.partNumber)
    .map(part => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${escapeXml(part.etag)}"</ETag></Part>`).join('');
  // A lost completion response must not be released into a migration: retain uncertainty durably.
  await storage.put(MULTIPART_PENDING_COMPLETION, { key: input.key, uploadId: input.uploadId });
  const response = await client.fetch(uploadUrl, { method: 'POST', body: `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`,
    headers: { 'Content-Type': 'application/xml' }, signal: AbortSignal.timeout(10_000) });
  const xml = await response.text();
  const result = xml.match(/^\s*(?:<\?xml[^?]*\?>\s*)?<CompleteMultipartUploadResult(?:\s[^<>]*)?>([\s\S]*)<\/CompleteMultipartUploadResult>\s*$/);
  const fields = result ? [...result[1].matchAll(/<([A-Za-z_][\w:.-]*)>([^<]*)<\/\1>/g)] : [];
  let cursor = 0;
  let malformed = !result;
  for (const field of fields) {
    if (result![1].slice(cursor, field.index).trim()) malformed = true;
    cursor = field.index! + field[0].length;
  }
  if (result?.[1].slice(cursor).trim()) malformed = true;
  const etags = fields.filter(field => field[1] === 'ETag');
  const etag = etags.length === 1 ? decodeXmlEntities(etags[0][2].trim()) : '';
  if (!response.ok || malformed || fields.some(field => field[1] === 'Error') || !/^"[\x21\x23-\x7e\x80-\xff]+"$/.test(etag)) {
    throw new ContainerError('upload', `R2 CompleteMultipartUpload did not confirm completion: HTTP ${response.status}`);
  }
  await storage.delete(receiptKey!);
  await storage.delete(MULTIPART_PENDING_COMPLETION);
  await env.KV.delete(`storage-stats:${input.bucketName}`);
  return Response.json({ key: input.key });
}

export default app;
