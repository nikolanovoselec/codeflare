import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createR2Client, getR2Url } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { ValidationError, ContainerError } from '../../lib/error-types';
import { createRateLimiter } from '../../middleware/rate-limit';
import { createLogger } from '../../lib/logger';
import { validateKey } from './validation';
import { getSseHeaders } from '../../lib/r2-sse';
import { fetchObjectWithRegimeFallback, markMixedRecovery } from '../../lib/r2-migration';
import { hasHealthyContainer } from '../../lib/migration-containers';
import { readBoundedResponse, StreamLimitExceededError } from '../../lib/bounded-stream';

const logger = createLogger('storage-preview');

const storagePreviewRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  keyPrefix: 'storage-preview',
});

const MAX_TEXT_SIZE = 1_048_576; // 1 MiB

function contentLength(response: Response): number | undefined {
  const value = response.headers.get('Content-Length');
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : undefined;
}

function isTextContentType(contentType: string): boolean {
  if (contentType.startsWith('text/')) return true;
  if (contentType === 'application/json') return true;
  if (contentType === 'application/xml') return true;
  if (contentType === 'application/javascript') return true;
  if (contentType === 'application/typescript') return true;
  if (contentType === 'application/x-yaml') return true;
  if (contentType === 'application/toml') return true;
  if (contentType === 'application/x-sh') return true;
  return false;
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', storagePreviewRateLimiter);

app.get('/', async (c) => {
  const key = c.req.query('key');

  if (!key) {
    throw new ValidationError('Missing required query parameter: key');
  }

  const validatedKey = validateKey(key);

  const bucketName = c.get('bucketName');
  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);
  const objectUrl = getR2Url(endpoint, bucketName, validatedKey);

  // REQ-ENTERPRISE-020: HEAD in the bucket's committed regime, falling back to the opposite
  // regime once on an SSE-mismatch (see download.ts). `sseDisabled` is the regime that worked,
  // reused for the GET below so it never re-probes. A fallback hit on a ready bucket self-heals.
  const { response: headResponse, stray, sseDisabled } = await fetchObjectWithRegimeFallback(c.env, bucketName, objectUrl, { method: 'HEAD' });
  if (stray) {
    try { c.executionCtx.waitUntil(markMixedRecovery(c.env, bucketName, () => hasHealthyContainer(c.env, bucketName))); } catch { /* no execution context (tests) */ }
  }

  if (!headResponse.ok) {
    logger.error('R2 HEAD failed', undefined, { status: headResponse.status, bucketName, key });
    throw new ContainerError('preview', `R2 HEAD failed: ${headResponse.status}`);
  }

  const size = contentLength(headResponse);
  const contentType = headResponse.headers.get('Content-Type') || 'application/octet-stream';
  const lastModified = headResponse.headers.get('Last-Modified') || '';

  // HEAD avoids unnecessary downloads, but the object can change before GET.
  if (isTextContentType(contentType) && (size === undefined || size <= MAX_TEXT_SIZE)) {
    const response = await r2Client.fetch(objectUrl, { method: 'GET', headers: getSseHeaders(c.env, sseDisabled) });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new ContainerError('preview', `R2 GET failed: ${response.status}`);
    }
    const fetchedSize = contentLength(response) ?? size ?? 0;
    const fetchedModified = response.headers.get('Last-Modified') ?? lastModified;
    if (!isTextContentType(response.headers.get('Content-Type') ?? contentType)) {
      void response.body?.cancel().catch(() => undefined);
      return c.json({ type: 'binary', size: fetchedSize, lastModified: fetchedModified });
    }
    try {
      const bytes = await readBoundedResponse(response, MAX_TEXT_SIZE, 'Text preview');
      return c.json({ type: 'text', content: new TextDecoder().decode(bytes), size: bytes.byteLength, lastModified: fetchedModified });
    } catch (error) {
      if (!(error instanceof StreamLimitExceededError)) throw error;
      // If a growing object has no reliable length, report at least the bytes observed.
      return c.json({ type: 'binary', size: Math.max(fetchedSize, error.observedBytes), lastModified: fetchedModified });
    }
  }

  return c.json({ type: 'binary', size: size ?? 0, lastModified });
});

export default app;
