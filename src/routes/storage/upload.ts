/**
 * Storage upload routes
 * Handles simple and multipart uploads to R2
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createR2Client, getR2Url, parseInitiateMultipartUploadXml } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { ValidationError, ContainerError } from '../../lib/error-types';
import { escapeXml } from '../../lib/xml-utils';
import { validateKey, MAX_KEY_LENGTH } from './validation';

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

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * POST /
 * Simple upload (≤ 5MB). Body: { key, content (base64) }
 */
app.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = SimpleUploadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }
  const body = parsed.data;
  validateKey(body.key);

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);

  const binaryContent = Uint8Array.from(atob(body.content), ch => ch.charCodeAt(0));
  const url = getR2Url(endpoint, bucketName, body.key);

  const response = await r2Client.fetch(url, {
    method: 'PUT',
    body: binaryContent,
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  if (!response.ok) {
    throw new ContainerError('upload', `R2 PutObject failed: ${response.status}`);
  }

  return c.json({ key: body.key, size: binaryContent.length });
});

/**
 * POST /initiate
 * Initiate multipart upload. Body: { key }
 */
app.post('/initiate', async (c) => {
  const raw = await c.req.json();
  const parsed = InitiateUploadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }
  const body = parsed.data;
  validateKey(body.key);

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);

  const url = `${getR2Url(endpoint, bucketName, body.key)}?uploads`;
  const response = await r2Client.fetch(url, { method: 'POST' });

  if (!response.ok) {
    throw new ContainerError('upload', `R2 InitiateMultipartUpload failed: ${response.status}`);
  }

  const xml = await response.text();
  const uploadId = parseInitiateMultipartUploadXml(xml);

  return c.json({ uploadId, key: body.key });
});

/**
 * POST /part
 * Upload a single part. Body: { key, uploadId, partNumber, content (base64) }
 */
app.post('/part', async (c) => {
  const raw = await c.req.json();
  const parsed = UploadPartSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }
  const body = parsed.data;
  validateKey(body.key);

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);

  const binaryContent = Uint8Array.from(atob(body.content), ch => ch.charCodeAt(0));
  const url = `${getR2Url(endpoint, bucketName, body.key)}?partNumber=${body.partNumber}&uploadId=${encodeURIComponent(body.uploadId)}`;

  const response = await r2Client.fetch(url, {
    method: 'PUT',
    body: binaryContent,
  });

  if (!response.ok) {
    throw new ContainerError('upload', `R2 UploadPart failed: ${response.status}`);
  }

  const etag = response.headers.get('etag') || '';
  return c.json({ etag: etag.replace(/"/g, '') });
});

/**
 * POST /complete
 * Complete multipart upload. Body: { key, uploadId, parts: [{partNumber, etag}] }
 */
app.post('/complete', async (c) => {
  const raw = await c.req.json();
  const parsed = CompleteUploadBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }
  const body = parsed.data;
  validateKey(body.key);

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);

  const partsXml = body.parts
    .sort((a, b) => a.partNumber - b.partNumber)
    .map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${escapeXml(p.etag)}"</ETag></Part>`)
    .join('');
  const xmlBody = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;

  const url = `${getR2Url(endpoint, bucketName, body.key)}?uploadId=${encodeURIComponent(body.uploadId)}`;

  const response = await r2Client.fetch(url, {
    method: 'POST',
    body: xmlBody,
    headers: { 'Content-Type': 'application/xml' },
  });

  if (!response.ok) {
    throw new ContainerError('upload', `R2 CompleteMultipartUpload failed: ${response.status}`);
  }

  return c.json({ key: body.key });
});

/**
 * POST /abort
 * Abort multipart upload. Body: { key, uploadId }
 */
app.post('/abort', async (c) => {
  const raw = await c.req.json();
  const parsed = AbortUploadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }
  const body = parsed.data;
  validateKey(body.key);

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);

  const url = `${getR2Url(endpoint, bucketName, body.key)}?uploadId=${encodeURIComponent(body.uploadId)}`;
  await r2Client.fetch(url, { method: 'DELETE' });

  return c.json({ success: true });
});

export default app;
